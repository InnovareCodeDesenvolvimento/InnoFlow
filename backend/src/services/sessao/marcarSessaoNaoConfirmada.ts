import type { StopUnconfirmedReason } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { emitSessionUpdated } from '../../realtime/emit'
import { env } from '../../lib/env'
import { listarEstadosSessaoAberta } from '../../core/sessao/estadosSessao'
import { deveZerarCusto } from '../../core/sessao/leituraFinal'
import type { TipoAlertaSessao } from '../../core/sessao/avaliarSessaoAberta'
import { calcularFechamentoSessao, CustoNaoCalculadoError } from '../carteira/finalizarSessao'
import { alertarSessaoLimitado } from './alertasSessao'
import { dispararTriggerMeterValues } from './triggerMeterValues'
import { isChargePointOnline } from '../../core/estacoes/disponibilidade'
import { redis as redisPadrao } from '../../lib/redis'
import { withDeadline } from '../../lib/withDeadline'
import { resolverLeituraFinal } from './resolverLeituraFinal'
import { travarSessao, fotoAindaVale, type FotoDaSessao } from './travarSessao'

/**
 * Aberta -> `STOP_UNCONFIRMED` (F5.9): o SERVIDOR acha que a sessão acabou, o carregador não confirmou. NENHUM dinheiro anda aqui:
 * nada é debitado, capturado nem cancelado (a pré-autorização do cartão continua AUTHORIZED). Só grava o estado provisório e um custo
 * PROVISÓRIO (`provisionalCostCents`, informativo; também desconta o "saldo comprometido" da carteira se D7=a).
 *
 * `unconfirmedAt` e `unconfirmedReason` vão no MESMO UPDATE de `status` — o CHECK `charging_session_unconfirmed_requires_reason` do
 * banco recusa a linha sem os dois.
 *
 * Idempotente e seguro sob corrida: trava a linha (`FOR UPDATE`) e RECONFERE dentro do lock. Se o StopTransaction do carregador
 * fechou a sessão antes, devolve `NAO_ABERTA` e não faz nada; se já está não confirmada, `JA_NAO_CONFIRMADA`.
 */
export interface MarcarSessaoNaoConfirmadaParams {
  sessionId: string
  motivo: StopUnconfirmedReason
  /** Foto em que o watchdog decidiu; se mudou sob o lock (atividade nova, outro stop...), a decisão está velha: `CONDICAO_MUDOU`. Chamadores sem snapshot (Boot, stop rejeitado) omitem. */
  fotoEsperada?: FotoDaSessao
  /** Alertas complementares da decisão (o `session_stop_unconfirmed` é SEMPRE emitido). */
  alertasExtras?: readonly TipoAlertaSessao[]
}

/**
 * M7 (Órion): a energia (Wh) da leitura NO MOMENTO da marcação — referência do U1. MeterValues em buffer despejados depois de uma queda movem
 * `lastMeterValuesAt` mas não passam desta energia; só quem ENTREGOU mais reanima. Redis (7 dias) porque `MeterSample` só tem o relógio do carregador e não há
 * coluna para isso; chave perdida => desconhecido => comportamento antigo.
 */
export const chaveEnergiaNaMarcacao = (sessionId: string) => `session:unconfirmed-energy:${sessionId}`
const ENERGIA_NA_MARCACAO_TTL_SEGUNDOS = 7 * 24 * 3600
const REDIS_PRAZO_MS = 3_000

export type MarcarSessaoNaoConfirmadaResultado = 'MARCADA' | 'JA_NAO_CONFIRMADA' | 'NAO_ABERTA' | 'CONDICAO_MUDOU'

export async function marcarSessaoNaoConfirmada(params: MarcarSessaoNaoConfirmadaParams): Promise<MarcarSessaoNaoConfirmadaResultado> {
  const { sessionId, motivo } = params

  const resultado = await prisma.$transaction(async (tx) => {
    const travada = await travarSessao(tx, sessionId)
    if (travada.status === 'STOP_UNCONFIRMED') return { tipo: 'JA_NAO_CONFIRMADA' as const }
    if (!(listarEstadosSessaoAberta() as string[]).includes(travada.status)) return { tipo: 'NAO_ABERTA' as const }
    if (params.fotoEsperada && !fotoAindaVale(travada, params.fotoEsperada)) return { tipo: 'CONDICAO_MUDOU' as const }

    // Custo provisório com a MESMA conta do fechamento real: melhor prova de leitura disponível AGORA e, sem nenhuma, a política D2.
    const sessao = await tx.chargingSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { id: true, userId: true, meterStartWh: true, startedAt: true, chargingEndedAt: true, tariffSnapshot: true, site: { select: { timezone: true } } },
    })
    const leitura = await resolverLeituraFinal(tx, { id: sessionId, chargePointId: travada.chargePointId, ocppTransactionId: travada.ocppTransactionId, meterStartWh: sessao.meterStartWh, startedAt: sessao.startedAt, chargingEndedAt: sessao.chargingEndedAt })
    // ALTO-1: se o cálculo falhar, o provisório fica NULL ("desconhecido", nunca 0) — marcar não move dinheiro e não pode travar por isso.
    let provisionalCostCents: number | null = null
    let custoFalhou = false
    try {
      provisionalCostCents = calcularFechamentoSessao(sessao, {
        meterStopWh: leitura.meterStopWh,
        timestamp: leitura.timestamp,
        stopReason: 'OTHER',
        zerarCusto: deveZerarCusto(leitura.prova, env.SESSION_NO_READING_POLICY),
      }).custos.totalCostCents
    } catch (err) {
      if (!(err instanceof CustoNaoCalculadoError)) throw err
      custoFalhou = true
    }

    const agora = new Date()
    // Update condicional: só vira STOP_UNCONFIRMED se continua aberta (cinto e suspensório do lock acima).
    const alteradas = await tx.chargingSession.updateMany({
      where: { id: sessionId, status: { in: listarEstadosSessaoAberta() } },
      data: { status: 'STOP_UNCONFIRMED', unconfirmedAt: agora, unconfirmedReason: motivo, provisionalCostCents },
    })
    if (alteradas.count !== 1) return { tipo: 'NAO_ABERTA' as const }

    // M5: presença do carregador e número OCPP do conector, para o TriggerMessage logo depois do commit.
    const [carregador, conector] = await Promise.all([
      tx.chargePoint.findUnique({ where: { id: travada.chargePointId }, select: { lastSeenAt: true, disconnectedAt: true } }),
      tx.connector.findUnique({ where: { id: travada.connectorId }, select: { connectorId: true } }),
    ])

    return {
      tipo: 'MARCADA' as const,
      chargePointId: travada.chargePointId,
      operatorId: travada.operatorId,
      userId: sessao.userId,
      provisionalCostCents,
      custoFalhou,
      prova: leitura.prova,
      energiaNaMarcacaoWh: leitura.prova === 'LAST_METER_SAMPLE' ? leitura.meterStopWh : null,
      online: carregador ? isChargePointOnline(carregador, agora) : false,
      connectorNumber: conector?.connectorId ?? null,
      statusAnterior: travada.status,
    }
  })

  if (resultado.tipo !== 'MARCADA') return resultado.tipo

  if (resultado.custoFalhou) {
    void alertarSessaoLimitado('session_cost_calculation_failed', { sessionId, chargePointId: resultado.chargePointId, where: 'provisional_cost' }, 'não foi possível calcular o custo provisório — fica desconhecido (null)').catch(() => undefined)
  }
  // BAIXO-1 (Órion): os alertas passam pelo limitador (1x/h por tipo e sessão) — uma sessão que o R2 marca de novo a cada ciclo não pode gerar 1 alerta por minuto.
  const alertas = new Set<TipoAlertaSessao>(['session_stop_unconfirmed', ...(params.alertasExtras ?? [])])
  for (const alerta of alertas) {
    await alertarSessaoLimitado(
      alerta,
      { sessionId, chargePointId: resultado.chargePointId, reason: motivo, previousStatus: resultado.statusAnterior, provisionalCostCents: resultado.provisionalCostCents, meterProof: resultado.prova },
      `sessão movida para STOP_UNCONFIRMED (${motivo}) — nenhum dinheiro movido; aguardando o carregador`,
    )
  }

  // M7: guarda a energia da marcação (referência do U1). Melhor esforço: Redis fora => o U1 cai no comportamento antigo.
  if (resultado.energiaNaMarcacaoWh !== null) {
    void withDeadline(redisPadrao.set(chaveEnergiaNaMarcacao(sessionId), String(resultado.energiaNaMarcacaoWh), 'EX', ENERGIA_NA_MARCACAO_TTL_SEGUNDOS), REDIS_PRAZO_MS, 'energia na marcação').catch((err) =>
      logger.warn({ err, sessionId }, '[sessao] não guardou a energia da marcação (o U1 reanima pelo critério antigo)'),
    )
  }

  // M5: com o carregador ONLINE, pede uma amostra na hora — se ele segue entregando, o MeterValues que voltar reanima (U1); NotImplemented = nada a fazer.
  // Em segundo plano, com o mesmo cooldown e o mesmo teto de comandos em voo do R4.
  if (resultado.online && resultado.connectorNumber !== null) {
    void dispararTriggerMeterValues({ sessionId, chargePointId: resultado.chargePointId, connectorNumber: resultado.connectorNumber, cooldownMinutes: env.SESSION_METER_TRIGGER_COOLDOWN_MINUTES, origem: 'MARCACAO' }).catch((err) =>
      logger.warn({ err, sessionId }, '[sessao] TriggerMessage pós-marcação falhou (não bloqueante)'),
    )
  }
  // Tempo real: o PWA do motorista e o painel admin invalidam o detalhe/lista (STOP_UNCONFIRMED não é "ativa"). Depois do commit, não bloqueante.
  void emitSessionUpdated({ operatorId: resultado.operatorId, userId: resultado.userId, sessionId, chargePointId: resultado.chargePointId }).catch((err) =>
    logger.error({ err, sessionId }, '[realtime] falha ao publicar session.updated (não bloqueante)'),
  )
  return 'MARCADA'
}
