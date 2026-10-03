import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { chamarHandler, criarCenario, criarSessao, debitosDaSessao, minutosAtras, cenariosCriados, resolverCapturasPendentes, type Cenario } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * F5.9d (Íris) — M2 do Órion PROVADO contra o Postgres real: "reconexão após queda longa encerra no 1º ciclo, antes do Stop enfileirado".
 *
 * Cenário (o D-A de volta): o carregador caiu, a sessão ficou STOP_UNCONFIRMED há 30 min, e AGORA ele reconecta (`connectedAt` = agora, `lastSeenAt`
 * = agora) — o Stop que ele guardou offline ainda vai chegar. A janela online G1 (10 min) conta desde `unconfirmedAt`, então já "venceu": o primeiro
 * ciclo do watchdog depois da reconexão encerra pelo servidor com a ÚLTIMA AMOSTRA, e o Stop real que chega segundos depois vira stop tardio (diferença
 * NÃO cobrada, D3). A migration `20261003140000` criou `ChargePoint.connectedAt` exatamente para o watchdog esperar a partir da reconexão, mas o
 * commit que a USA ainda não está no HEAD — por isso o teste é `it.fails`: quando o watchdog respeitar a reconexão, o teste passa a "falhar como
 * esperado" e o marcador sai.
 *
 * O controle (carregador conectado há 30 min) tem de continuar encerrando: a correção não pode virar "nunca encerra".
 */
describe('F5.9d — reconexão depois de queda longa (M2): o Stop enfileirado precisa ter chance de chegar', () => {
  const suffix = uniqueSuffix()
  let cen: Cenario
  const killSwitchOriginal = (env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED
  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const ciclo = () => vigiarSessoes({ chargePointIds: [cen.tenant.chargePointId], aguardarComandos: true })

  beforeAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = true
    cen = await criarCenario(suffix, 'm2-reconexao')
  })
  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessaoEmConfirmacao = () =>
    criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], naoConfirmada: { motivo: 'CHARGER_UNREACHABLE', haMin: 30 }, iniciouHaMin: 60 })

  it('controle: carregador conectado há 30 min e sessão em confirmação há 30 min: o watchdog encerra (G1 de 10 min venceu)', async () => {
    await prisma.chargePoint.update({ where: { id: cen.tenant.chargePointId }, data: { lastSeenAt: new Date(), connectedAt: minutosAtras(30), disconnectedAt: null } })
    const s = await sessaoEmConfirmacao()
    await ciclo()
    expect((await sessao(s.session.id)).status).toBe('STOPPED')
    expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
  })

  it('carregador que ACABOU de reconectar (connectedAt = agora): o 1º ciclo NÃO pode encerrar — o Stop enfileirado ainda vai chegar e fechar com a leitura real', async () => {
    await prisma.chargePoint.update({ where: { id: cen.tenant.chargePointId }, data: { lastSeenAt: new Date(), connectedAt: new Date(), disconnectedAt: null } })
    const s = await sessaoEmConfirmacao()
    await ciclo() // o ciclo roda segundos depois da reconexão, antes de o Stop guardado chegar
    expect((await sessao(s.session.id)).status, 'o servidor encerrou com a última amostra antes do Stop enfileirado').toBe('STOP_UNCONFIRMED')

    // e o Stop real, ao chegar, fecha normalmente com o consumo verdadeiro (500), não como stop tardio absorvido
    await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(1).toISOString(), reason: 'PowerLoss' })
    const linha = await sessao(s.session.id)
    expect(linha.closureSource).toBe('CHARGER')
    expect(linha.totalCostCents).toBe(500)
  })
})
