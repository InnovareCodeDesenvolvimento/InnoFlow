import type { SessionStopRequester } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { redis as redisPadrao } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { withDeadline } from '../../lib/withDeadline'
import { listarEstadosSessaoAberta } from '../../core/sessao/estadosSessao'
import { sendCommand, OcppCommandTimeoutError } from '../../ocpp/commands'
import { isAcceptedCommandResult } from '../../ocpp/commandResultCache'
import { marcarSessaoNaoConfirmada, type MarcarSessaoNaoConfirmadaResultado } from './marcarSessaoNaoConfirmada'
import { buscarUltimaAmostra } from './resolverLeituraFinal'
import { travarSessao, fotoAindaVale, type FotoDaSessao } from './travarSessao'

/**
 * ÚNICO ponto de `RemoteStopTransaction` do sistema (F5.9). Motorista, admin, guarda de saldo e watchdog passam todos por aqui — antes
 * havia 3 lugares montando o comando, cada um com uma opinião diferente sobre o que fazer com um `Rejected` (um deles encerrava a
 * sessão com dinheiro na hora: defeito M5/M6).
 *
 * O que faz, nesta ordem:
 *  1. cooldown no Redis (anti duplo-toque / reforço do espaçamento do watchdog) — falha ABERTA se o Redis estiver fora;
 *  2. sob `FOR UPDATE`, reconfere que a sessão está aberta (e, se veio foto do watchdog, que ela ainda vale) e grava
 *     `stopRequestedAt` (re-carimbado a CADA tentativa: é ele que espaça o R3), `stopRequestedBy` e `stopAttempts + 1`;
 *  3. DEPOIS do commit (rede nunca entra em transação) manda o comando;
 *  4. classifica a resposta: Accepted = nada mais (o StopTransaction fecha; se não vier, R3 reenvia); Rejected ou erro de transporte
 *     que não seja timeout => `STOP_UNCONFIRMED` (STOP_REJECTED | CHARGER_UNREACHABLE) — NUNCA fecha com dinheiro; timeout é
 *     ambíguo (carregador lento) e SÓ REGISTRA: quem decide é R3.
 *
 * Devolve a promessa do resultado completo (inclui o comando, que pode levar até 35 s). Rotas HTTP e a guarda a chamam sem esperar;
 * o watchdog também (com teto de comandos em voo), os testes esperam.
 */
export interface PedirParadaSessaoParams {
  sessionId: string
  solicitante: SessionStopRequester
  /** Foto do watchdog para o compare-and-swap sob o lock; humanos e a guarda omitem. */
  fotoEsperada?: FotoDaSessao
  timeoutMs?: number
  /** Chamado logo DEPOIS de o pedido ser gravado (e antes do comando, que pode levar 35 s) — o watchdog emite os alertas da decisão aqui. */
  onRegistrado?: (info: { tentativa: number }) => void
  /** Só para teste: Redis injetado. */
  redis?: typeof redisPadrao
}

export type ResultadoComandoParada = 'ACCEPTED' | 'REJECTED' | 'TIMEOUT' | 'UNREACHABLE'

export type PedirParadaSessaoResultado =
  | { registrado: false; motivo: 'NAO_ABERTA' | 'EM_COOLDOWN' | 'CONDICAO_MUDOU' }
  | { registrado: true; tentativa: number; comando: ResultadoComandoParada; marcacao: MarcarSessaoNaoConfirmadaResultado | null }

const COMMAND_TIMEOUT_MS = 35_000
const REDIS_PRAZO_MS = 3_000
/** Humanos e guarda: só barra o duplo-toque. Watchdog: reforça o espaçamento que o R3 já faz por `stopRequestedAt`. */
const COOLDOWN_SEGUNDOS: Record<SessionStopRequester, number> = { DRIVER: 10, ADMIN: 10, GUARD: 10, WATCHDOG: 60 }
const ENERGIA_NO_PEDIDO_TTL_SEGUNDOS = 24 * 3600

export const chaveCooldownParada = (sessionId: string) => `session:stop-cooldown:${sessionId}`
/** Última energia (Wh) conhecida NO MOMENTO do pedido de parada — base do alerta `session_stop_not_obeyed` (energia que continua subindo). */
export const chaveEnergiaNoPedidoDeParada = (sessionId: string) => `session:stop-energy:${sessionId}`

export async function pedirParadaSessao(params: PedirParadaSessaoParams): Promise<PedirParadaSessaoResultado> {
  const { sessionId, solicitante } = params
  const redis = params.redis ?? redisPadrao

  // 1. Cooldown. Redis fora => segue (o pedido de parada de um humano vale mais que o dedupe); o espaçamento real vem do banco.
  try {
    const adquiriu = await withDeadline(redis.set(chaveCooldownParada(sessionId), solicitante, 'EX', COOLDOWN_SEGUNDOS[solicitante], 'NX'), REDIS_PRAZO_MS, 'cooldown do pedido de parada')
    if (adquiriu !== 'OK') return { registrado: false, motivo: 'EM_COOLDOWN' }
  } catch (err) {
    logger.warn({ err, sessionId }, '[sessao] cooldown do pedido de parada indisponível (Redis) — seguindo sem ele')
  }

  // 2. Registro do pedido, sob lock.
  const registro = await prisma.$transaction(async (tx) => {
    const travada = await travarSessao(tx, sessionId)
    if (!(listarEstadosSessaoAberta() as string[]).includes(travada.status)) return { tipo: 'NAO_ABERTA' as const }
    if (params.fotoEsperada && !fotoAindaVale(travada, params.fotoEsperada)) return { tipo: 'CONDICAO_MUDOU' as const }

    const humano = solicitante === 'DRIVER' || solicitante === 'ADMIN'
    // O 1º solicitante vence nas repetições do watchdog (quem PEDIU primeiro é a informação útil); um humano sempre assume.
    const quem = travada.stopRequestedBy === null || humano ? solicitante : travada.stopRequestedBy
    const atualizadas = await tx.chargingSession.updateMany({
      where: { id: sessionId, status: { in: listarEstadosSessaoAberta() } },
      data: { stopRequestedAt: new Date(), stopRequestedBy: quem, stopAttempts: { increment: 1 } },
    })
    if (atualizadas.count !== 1) return { tipo: 'NAO_ABERTA' as const }
    return { tipo: 'OK' as const, tentativa: travada.stopAttempts + 1, chargePointId: travada.chargePointId, ocppTransactionId: travada.ocppTransactionId }
  })
  if (registro.tipo !== 'OK') return { registrado: false, motivo: registro.tipo }

  params.onRegistrado?.({ tentativa: registro.tentativa })
  await guardarEnergiaNoPedido(redis, sessionId).catch((err) => logger.warn({ err, sessionId }, '[sessao] não guardou a energia do pedido de parada (só enfraquece o alerta session_stop_not_obeyed)'))

  // 3. Comando — fora de qualquer transação.
  logger.info({ sessionId, chargePointId: registro.chargePointId, requestedBy: solicitante, attempt: registro.tentativa }, '[sessao] RemoteStopTransaction disparado')
  let comando: ResultadoComandoParada
  try {
    const resposta = await sendCommand(registro.chargePointId, 'RemoteStopTransaction', { transactionId: registro.ocppTransactionId }, { timeoutMs: params.timeoutMs ?? COMMAND_TIMEOUT_MS })
    comando = isAcceptedCommandResult(resposta) ? 'ACCEPTED' : 'REJECTED'
  } catch (err) {
    comando = err instanceof OcppCommandTimeoutError ? 'TIMEOUT' : 'UNREACHABLE'
    logger.error({ err, sessionId, chargePointId: registro.chargePointId, requestedBy: solicitante }, '[sessao] RemoteStopTransaction falhou')
  }

  // 4. Classificação. Nunca fecha a sessão com dinheiro aqui.
  let marcacao: MarcarSessaoNaoConfirmadaResultado | null = null
  if (comando === 'REJECTED' || comando === 'UNREACHABLE') {
    marcacao = await marcarSessaoNaoConfirmada({ sessionId, motivo: comando === 'REJECTED' ? 'STOP_REJECTED' : 'CHARGER_UNREACHABLE' }).catch((err) => {
      logger.error({ err, sessionId }, '[sessao] falha ao marcar a sessão como STOP_UNCONFIRMED após stop não aceito — o watchdog reavalia no próximo ciclo')
      return null
    })
  }

  return { registrado: true, tentativa: registro.tentativa, comando, marcacao }
}

async function guardarEnergiaNoPedido(redis: typeof redisPadrao, sessionId: string): Promise<void> {
  const amostra = await buscarUltimaAmostra(prisma, sessionId)
  if (!amostra) return
  await withDeadline(redis.set(chaveEnergiaNoPedidoDeParada(sessionId), String(amostra.meterWh), 'EX', ENERGIA_NO_PEDIDO_TTL_SEGUNDOS), REDIS_PRAZO_MS, 'energia no pedido de parada')
}
