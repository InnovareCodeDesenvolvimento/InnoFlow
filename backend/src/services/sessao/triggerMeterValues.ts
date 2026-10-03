import type Redis from 'ioredis'
import { redis as redisPadrao } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { withDeadline } from '../../lib/withDeadline'
import { sendCommand } from '../../ocpp/commands'

/**
 * `TriggerMessage(MeterValues)` e o teto de comandos OCPP em voo, compartilhados pelo R4 do watchdog e pela marcação STOP_UNCONFIRMED (M5 do Órion).
 *
 * M5: um firmware que manda Boot a cada reconexão SEM interromper a transação, ou que amostra a cada > G1 (ou nunca: `MeterValueSampleInterval=0`), tinha a
 * sessão VIVA fechada pela última amostra enquanto o carro seguia carregando. Ao marcar STOP_UNCONFIRMED com o carregador ONLINE, pede-se uma amostra NA HORA:
 * se o carregador responder com MeterValues de energia nova, o U1 reanima; `NotImplemented`/`Rejected` = o firmware não faz TriggerMessage, nada a fazer.
 * O cooldown vive no Redis (mesma chave do R4: nunca dois pedidos para a mesma sessão na janela, venham de onde vierem).
 */

export const MAX_COMANDOS_EM_VOO = 20
const TRIGGER_TIMEOUT_MS = 35_000
const REDIS_PRAZO_MS = 3_000

let comandosEmVoo = 0

/** Reserva uma vaga de comando em voo (teto compartilhado). Devolve a função que a libera, ou `null` se o teto foi atingido. */
export function reservarVagaDeComando(): (() => void) | null {
  if (comandosEmVoo >= MAX_COMANDOS_EM_VOO) return null
  comandosEmVoo++
  let liberada = false
  return () => {
    if (!liberada) {
      liberada = true
      comandosEmVoo--
    }
  }
}
export const comandosEmVooAgora = () => comandosEmVoo

export const chaveTriggerMeterValues = (sessionId: string) => `session:trigger-meter:${sessionId}`

export type ResultadoTrigger = 'ENVIADO' | 'EM_COOLDOWN' | 'SEM_VAGA' | 'REDIS_INDISPONIVEL'

export async function dispararTriggerMeterValues(p: {
  sessionId: string
  chargePointId: string
  /** Número OCPP do conector (`Connector.connectorId`), não o id interno. */
  connectorNumber: number
  cooldownMinutes: number
  redis?: Redis
  /** Só teste: espera a resposta do carregador. */
  aguardar?: boolean
  /** Para o log: quem pediu. */
  origem: 'R4' | 'MARCACAO'
}): Promise<ResultadoTrigger> {
  const redis = p.redis ?? redisPadrao
  // Cooldown de VERDADE no Redis (SET NX): só quem adquire envia; sem Redis, não envia (nada aqui fecha sessão, pode esperar o próximo ciclo).
  let adquiriu: string | null = null
  try {
    adquiriu = await withDeadline(redis.set(chaveTriggerMeterValues(p.sessionId), String(Date.now()), 'EX', p.cooldownMinutes * 60, 'NX'), REDIS_PRAZO_MS, 'cooldown do TriggerMessage')
  } catch (err) {
    logger.warn({ err, sessionId: p.sessionId }, '[sessao] Redis indisponível para o cooldown do TriggerMessage — não envia')
    return 'REDIS_INDISPONIVEL'
  }
  if (adquiriu !== 'OK') return 'EM_COOLDOWN'

  const liberar = reservarVagaDeComando()
  if (!liberar) return 'SEM_VAGA'
  const envio = sendCommand(p.chargePointId, 'TriggerMessage', { requestedMessage: 'MeterValues', connectorId: p.connectorNumber }, { timeoutMs: TRIGGER_TIMEOUT_MS })
    // NotImplemented/Rejected = o firmware não faz TriggerMessage: não há nada a fazer. Só registra.
    .then((resposta) => logger.info({ sessionId: p.sessionId, chargePointId: p.chargePointId, origin: p.origem, resposta }, '[sessao] TriggerMessage(MeterValues) respondido'))
    .catch((err) => logger.warn({ err, sessionId: p.sessionId, chargePointId: p.chargePointId, origin: p.origem }, '[sessao] TriggerMessage(MeterValues) sem resposta útil — nada a fazer'))
    .finally(liberar)
  if (p.aguardar) await envio
  return 'ENVIADO'
}
