import type Redis from 'ioredis'
import { logger } from '../../lib/logger'
import { redis as redisPadrao } from '../../lib/redis'
import { withDeadline } from '../../lib/withDeadline'
import type { TipoAlertaSessao } from '../../core/sessao/avaliarSessaoAberta'
import { severidadeDoAlerta } from '../../core/sessao/severidadeAlertas'

/**
 * Ponto único de emissão dos alertas de sessão travada (F5.9). O campo estruturado é `alert` (mesma convenção dos alertas de
 * pagamento) e a severidade vem de `core/sessao/severidadeAlertas.ts`.
 *
 * SEM DADO PESSOAL, de propósito (Órion/9e): só ids técnicos da sessão/carregador, status, motivos e valores em centavos/Wh.
 * Nunca nome, e-mail, idTag ou userId. Quem chama passa `campos` já limpos.
 */
export interface CamposAlertaSessao {
  sessionId?: string
  chargePointId?: string
  [chave: string]: unknown
}

export function alertarSessao(tipo: TipoAlertaSessao, campos: CamposAlertaSessao, mensagem: string, contexto: { diferencaCents?: number } = {}): void {
  const severidade = severidadeDoAlerta(tipo, contexto)
  const payload = { alert: tipo, ...campos }
  const texto = `[sessao][watchdog] ${mensagem}`
  if (severidade === 'error') logger.error(payload, texto)
  else if (severidade === 'warn') logger.warn(payload, texto)
  else logger.info(payload, texto)
}

/** Chave Redis que limita um alerta REPETITIVO (condição que persiste) a 1 emissão por janela, por sessão. */
export const chaveAlertaLimitado = (tipo: TipoAlertaSessao, sessionId: string) => `session:alert:${tipo}:${sessionId}`

const ALERTA_LIMITADO_PADRAO_SEGUNDOS = 3600
const REDIS_PRAZO_MS = 2_000

/**
 * Alerta de condição PERSISTENTE (o carregador que não obedece o stop, a energia que segue chegando numa sessão já fechada): sem limite
 * sairia um alerta de ERRO por minuto — ou por MeterValues — até alguém agir, e o plantão aprenderia a ignorar. Emite no máximo 1x por
 * janela por (tipo, sessão), com o limite no Redis. Redis fora => EMITE (falha aberta: melhor repetir um alerta que calá-lo).
 * Devolve `true` se emitiu.
 */
export async function alertarSessaoLimitado(
  tipo: TipoAlertaSessao,
  campos: CamposAlertaSessao & { sessionId: string },
  mensagem: string,
  opcoes: { redis?: Redis; janelaSegundos?: number } = {},
): Promise<boolean> {
  return alertarLimitadoPorEscopo(tipo, campos.sessionId, campos, mensagem, opcoes)
}

/**
 * Mesma ideia para alertas que NÃO são de uma sessão específica (ex.: `ocpp_foreign_transaction`, MeterValues sem transactionId): o limite é por
 * (tipo, `escopo`) — o chamador escolhe a chave (ex.: `carregador:transação`). Sem dado pessoal no `escopo` nem nos campos.
 */
export async function alertarLimitadoPorEscopo(
  tipo: TipoAlertaSessao,
  escopo: string,
  campos: CamposAlertaSessao,
  mensagem: string,
  opcoes: { redis?: Redis; janelaSegundos?: number } = {},
): Promise<boolean> {
  const redis = opcoes.redis ?? redisPadrao
  let emitir = true
  try {
    const r = await withDeadline(redis.set(chaveAlertaLimitado(tipo, escopo), '1', 'EX', opcoes.janelaSegundos ?? ALERTA_LIMITADO_PADRAO_SEGUNDOS, 'NX'), REDIS_PRAZO_MS, 'limite de alerta repetido')
    emitir = r === 'OK'
  } catch (err) {
    logger.warn({ err, label: 'limite de alerta repetido' }, '[sessao][watchdog] Redis indisponível para limitar o alerta — emitindo sem limite')
  }
  if (emitir) alertarSessao(tipo, campos, mensagem)
  return emitir
}
