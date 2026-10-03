import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { getPaymentsReconciliation } from '../../src/api/services/paymentsService'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStatusNotification } from '../../src/ocpp/handlers/statusNotification'
import { handleBootNotification } from '../../src/ocpp/handlers/bootNotification'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { chamarHandler, comFakeGateway, criarCenario, criarSessao, debitosDaSessao, minutosAtras, saldo, tokenDoMotorista, type Cenario, cenariosCriados, resolverCapturasPendentes } from './helpers/sessaoTravadaFixture'
import { settle, uniqueSuffix } from './helpers/fixtures'

/**
 * F5.9d (Íris) — CORRIDAS DE DINHEIRO com VÁRIOS atores ao mesmo tempo, em muitas rodadas e com offsets pseudo-aleatórios (semente fixa =
 * reproduzível), WALLET e CARD. Os testes de corrida do Vega usam DOIS atores disparados no mesmo tick (`Promise.all`); aqui cada ator entra
 * com um atraso próprio de 0 a 40 ms, o que varre as intercalações possíveis entre o lock da sessão, o log bruto do Stop e a foto do watchdog.
 *
 * O que NÃO pode acontecer, em nenhuma intercalação (os asserts valem para QUALQUER ordem — não dependem de quem ganhou):
 *   - dois débitos da mesma sessão; dois fechamentos; débito diferente do total (ou, sem saldo, débito + Debt diferente do total);
 *   - stop tardio sobre sessão fechada pelo próprio carregador; stop tardio alterando `totalCostCents`;
 *   - total incoerente com a PROVA que a sessão declara (`meterStopSource`) — o dinheiro tem de bater com a leitura que o banco diz ter usado;
 *   - CARD: mais de um PaymentIntent de captura, captura diferente de `min(total, autorizado)`, ou qualquer lançamento na carteira;
 *   - a identidade de conciliação do operador (differenceCents) sair de 0.
 * Tarifa R$ 1,00/kWh (1.000 Wh = 100 centavos).
 */

vi.mock('../../src/services/pagamentos/capturarSessaoCartao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/pagamentos/capturarSessaoCartao')>()),
  enqueueCapturarSessaoCartao: vi.fn().mockResolvedValue('ENFILEIRADO'),
}))

/** mulberry32: PRNG determinístico — a mesma semente reproduz exatamente os mesmos atrasos. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SEMENTE = Number(process.env.IRIS_SEMENTE ?? 0x1f59)
const atrasar = <T>(ms: number, fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => setTimeout(() => fn().then(resolve, reject), ms))

const meterValues = (connectorId: number, transactionId: number, energyWh: number, ts: Date) => ({
  connectorId,
  transactionId,
  meterValue: [{ timestamp: ts.toISOString(), sampledValue: [{ value: String(energyWh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
})
const statusNotification = (connectorId: number, status: string) => ({ connectorId, errorCode: 'NoError', status })

describe('F5.9 — corridas de dinheiro com vários atores, offsets pseudo-aleatórios (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const killSwitchOriginal = (env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED
  let cenWallet: Cenario
  let cenCard: Cenario
  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const ciclo = (c: Cenario) => vigiarSessoes({ chargePointIds: [c.tenant.chargePointId], aguardarComandos: true })

  beforeAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = true // o watchdog nasce DESLIGADO (M4); aqui o teste o liga EXPLICITAMENTE
    cenWallet = await criarCenario(`${suffix}w`, 'corr-w')
    cenCard = await criarCenario(`${suffix}c`, 'corr-c')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function conciliacao(c: Cenario) {
    return getPaymentsReconciliation({ operatorId: c.tenant.operatorId }, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000), previousFrom: new Date(), previousTo: new Date(), tz: 'America/Sao_Paulo' }, true)
  }

  describe('sessão em CONFIRMAÇÃO (STOP_UNCONFIRMED vencida): 2 ciclos do watchdog x Stop do carregador x Stop duplicado x MeterValues atrasado x Boot', () => {
    // leituras: início 1.000; amostras 2.000 e 3.000; o Stop real do carregador diz 6.000 (=> 500); um MeterValues atrasado traz 4.500
    const stopReal = 6_000

    function atores(c: Cenario, s: Awaited<ReturnType<typeof criarSessao>>, rnd: () => number) {
      const tx = s.session.ocppTransactionId
      const stopTs = minutosAtras(1).toISOString()
      const d = () => Math.floor(rnd() * 40)
      return [
        atrasar(d(), () => ciclo(c)),
        atrasar(d(), () => ciclo(c)),
        atrasar(d(), () => chamarHandler(handleStopTransaction, c.ctx, { transactionId: tx, meterStop: stopReal, timestamp: stopTs, reason: 'Local' })),
        atrasar(d(), () => chamarHandler(handleStopTransaction, c.ctx, { transactionId: tx, meterStop: stopReal, timestamp: stopTs, reason: 'Local' })), // retransmissão com messageId novo
        atrasar(d(), () => chamarHandler(handleMeterValues, c.ctx, meterValues(s.connector.connectorId, tx, 4_500, new Date()))),
        atrasar(d(), () => chamarHandler(handleBootNotification, c.ctx, { chargePointVendor: 'v', chargePointModel: 'm' })),
        atrasar(d(), () => chamarHandler(handleStatusNotification, c.ctx, statusNotification(s.connector.connectorId, 'Finishing'))),
      ]
    }

    it('WALLET, 40 rodadas: um fechamento, um débito, total coerente com a prova declarada, Stop tardio só sobre fechamento do servidor — e conciliação em 0', async () => {
      const rnd = prng(SEMENTE)
      const vistos = { CHARGER: 0, SERVER_STOP: 0, SERVER_AMOSTRA: 0 }
      for (let rodada = 0; rodada < 40; rodada++) {
        const s = await criarSessao(cenWallet, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 }, saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000] })
        await Promise.all(atores(cenWallet, s, rnd))
        await settle(60) // efeitos fire-and-forget (guarda, SSE) terminam antes de olhar

        const linha = await sessao(s.session.id)
        const onde = `rodada ${rodada} (semente ${SEMENTE})`
        const debitos = await debitosDaSessao(s.session.id)
        expect(linha.status, onde).toBe('STOPPED') // o Stop do carregador SEMPRE fecha o que estiver aberto/em confirmação
        expect(debitos, `${onde}: exatamente UM débito`).toHaveLength(1)
        expect(debitos[0]!.amountCents, onde).toBe(-linha.totalCostCents!)
        expect(await saldo(s.wallet.id), onde).toBe(10_000 - linha.totalCostCents!)
        expect(linha.stoppedAt, onde).not.toBeNull()
        // o dinheiro bate com a prova que a própria sessão declara
        const custoDe = (wh: number) => Math.round((wh - 1_000) / 10) // R$ 1,00/kWh => 0,1 centavo por Wh
        expect(linha.totalCostCents, `${onde}: total == custo da leitura declarada (${linha.meterStopSource} ${linha.meterStopWh})`).toBe(custoDe(linha.meterStopWh!))
        if (linha.closureSource === 'CHARGER') {
          vistos.CHARGER++
          expect(linha.meterStopSource, onde).toBe('STOP_TRANSACTION')
          expect(linha.meterStopWh, onde).toBe(stopReal)
          expect(linha.lateStopReceivedAt, `${onde}: Stop do próprio carregador nunca vira "tardio"`).toBeNull()
          expect(linha.unbilledCostCents, onde).toBeNull()
        } else {
          expect(linha.closureSource, onde).toBe('SERVER')
          // o Stop do carregador chegou depois (ou foi o que o servidor leu no log): fica registrado, NUNCA cobrado
          expect(linha.lateStopMeterWh, onde).toBe(stopReal)
          expect(linha.unbilledCostCents, onde).toBe(Math.max(0, custoDe(stopReal) - linha.totalCostCents!))
          if (linha.meterStopSource === 'STOP_TRANSACTION') {
            vistos.SERVER_STOP++
            expect(linha.meterStopWh, onde).toBe(stopReal)
            expect(linha.unbilledCostCents, onde).toBe(0)
          } else {
            vistos.SERVER_AMOSTRA++
            expect(linha.meterStopSource, onde).toBe('LAST_METER_SAMPLE')
            expect([3_000, 4_500], onde).toContain(linha.meterStopWh)
          }
        }
      }
      // sanidade do próprio teste: com a semente fixa, as intercalações têm de ter exercido mais de um desfecho (senão o teste não varre nada)
      expect(Object.values(vistos).filter((n) => n > 0).length, `desfechos observados: ${JSON.stringify(vistos)}`).toBeGreaterThanOrEqual(2)
      const r = await conciliacao(cenWallet)
      expect(r.differenceCents).toBe(0)
      expect(r.walletDebitCents).toBe(r.revenueCents)
    }, 120_000)

    it('CARD, 20 rodadas: UM intent em CAPTURE_PENDING com min(total, autorizado), nada na carteira, total coerente com a prova — e conciliação em 0', async () => {
      const rnd = prng(SEMENTE + 1)
      for (let rodada = 0; rodada < 20; rodada++) {
        const s = await criarSessao(cenCard, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 }, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], autorizadoCents: 5_000 })
        await Promise.all(atores(cenCard, s, rnd))
        await settle(60)

        const linha = await sessao(s.session.id)
        const onde = `rodada ${rodada} (semente ${SEMENTE + 1})`
        expect(linha.status, onde).toBe('STOPPED')
        const intents = await prisma.paymentIntent.findMany({ where: { chargingSessionId: s.session.id } })
        expect(intents, `${onde}: exatamente UM intent`).toHaveLength(1)
        expect(intents[0]!.status, onde).toBe('CAPTURE_PENDING')
        expect(intents[0]!.captureAmountCents, onde).toBe(Math.min(linha.totalCostCents!, 5_000))
        expect(linha.totalCostCents, onde).toBe(Math.round((linha.meterStopWh! - 1_000) / 10))
        expect(await debitosDaSessao(s.session.id), `${onde}: CARD jamais debita a carteira`).toHaveLength(0)
        expect(await prisma.walletEntry.count({ where: { walletId: s.wallet.id } }), onde).toBe(0)
        if (linha.closureSource === 'CHARGER') expect(linha.lateStopReceivedAt, onde).toBeNull()
      }
      expect((await conciliacao(cenCard)).differenceCents).toBe(0)
    }, 120_000)
  })

  describe('sessão ABERTA com parada pedida: watchdog (R3 reenvia) x stop do motorista (API) x guarda de saldo (MeterValues) x Stop do carregador x StatusNotification', () => {
    it('WALLET, 30 rodadas com saldo folgado, justo e curto: todo RemoteStop do servidor tem tentativa gravada (toque humano não conta, M6); UM débito; total = Stop real; Debt cobre o que faltou; conciliação 0', async () => {
      const rnd = prng(SEMENTE + 2)
      const saldos = [10_000, 900, 300]
      for (let rodada = 0; rodada < 30; rodada++) {
        const saldoInicial = saldos[rodada % saldos.length]!
        const s = await criarSessao(cenWallet, {
          mode: 'WALLET',
          status: 'CHARGING',
          saldoCents: saldoInicial,
          meterStartWh: 1_000,
          amostrasWh: [2_000],
          atividadeHaMin: 3,
          lastMeterValuesHaMin: 3,
          stopRequestedHaMin: 6, // R3 vencido: o watchdog reenvia o RemoteStop
          stopAttempts: 1,
        })
        const tx = s.session.ocppTransactionId
        const token = tokenDoMotorista(s.driver.id)
        const d = () => Math.floor(rnd() * 40)
        const onde = `rodada ${rodada} saldo ${saldoInicial} (semente ${SEMENTE + 2})`

        const statusHttp: number[] = []
        const comandos = await comFakeGateway(cenWallet.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
          await Promise.all([
            atrasar(d(), () => ciclo(cenWallet)),
            atrasar(d(), async () => {
              const res = await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set('Authorization', `Bearer ${token}`)
              statusHttp.push(res.status)
            }),
            // MeterValues com energia que estoura o saldo curto: dispara a guarda (fire-and-forget) => pedirParadaSessao(GUARD)
            atrasar(d(), () => chamarHandler(handleMeterValues, cenWallet.ctx, meterValues(s.connector.connectorId, tx, 12_000, new Date()))),
            atrasar(d(), () => chamarHandler(handleStatusNotification, cenWallet.ctx, statusNotification(s.connector.connectorId, rnd() < 0.5 ? 'Charging' : 'Finishing'))),
            atrasar(d(), () => chamarHandler(handleStopTransaction, cenWallet.ctx, { transactionId: tx, meterStop: 6_000, timestamp: minutosAtras(1).toISOString(), reason: 'Remote' })),
          ])
          await settle(450) // comandos fire-and-forget do gateway de mentira terminam
          return recebidos.filter((r) => r.method === 'RemoteStopTransaction').length
        })

        const linha = await sessao(s.session.id)
        expect(statusHttp.every((c) => c === 202 || c === 409), `${onde}: o stop do motorista nunca dá 5xx (${statusHttp})`).toBe(true)
        expect(linha.status, onde).toBe('STOPPED')
        expect(linha.closureSource, `${onde}: aberta -> STOPPED só pelo carregador (o servidor passa por STOP_UNCONFIRMED)`).toBe('CHARGER')
        expect(linha.meterStopSource, onde).toBe('STOP_TRANSACTION')
        expect(linha.lateStopReceivedAt, onde).toBeNull()
        expect(linha.totalCostCents, onde).toBe(500) // 6.000 - 1.000 Wh
        // M6: só GUARD/WATCHDOG contam para o teto (stopAttempts); toque humano (HTTP 202) manda comando sem contar. Logo: todo comando de servidor tem tentativa gravada
        // (stopAttempts - 1 <= comandos) e os comandos EXTRAS são no máximo os toques humanos aceitos (um 202 por rodada)
        const toquesAceitos = statusHttp.filter((c) => c === 202).length
        const doServidor = linha.stopAttempts - 1
        expect(doServidor, `${onde}: tentativas de servidor gravadas (${linha.stopAttempts}) vs comandos enviados (${comandos})`).toBeGreaterThanOrEqual(0)
        expect(comandos, onde).toBeGreaterThanOrEqual(doServidor)
        expect(comandos - doServidor, `${onde}: comandos sem tentativa gravada só podem ser toques humanos`).toBeLessThanOrEqual(toquesAceitos)

        const debitos = await debitosDaSessao(s.session.id)
        expect(debitos, `${onde}: UM débito`).toHaveLength(1)
        const esperadoDebito = Math.min(saldoInicial, 500)
        expect(-debitos[0]!.amountCents, onde).toBe(esperadoDebito)
        expect(await saldo(s.wallet.id), onde).toBe(saldoInicial - esperadoDebito)
        const dividas = await prisma.debt.findMany({ where: { chargingSessionId: s.session.id } })
        expect(
          dividas.reduce((acc, x) => acc + x.amountCents, 0),
          `${onde}: o que o saldo não cobriu vira Debt, exato`,
        ).toBe(500 - esperadoDebito)
      }
      const r = await conciliacao(cenWallet)
      expect(r.differenceCents).toBe(0)
    }, 180_000)
  })
})
