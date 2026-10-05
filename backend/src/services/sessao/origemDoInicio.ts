import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { withDeadline } from '../../lib/withDeadline'
import { normalizarOrigemDoInicio, type OrigemDoInicio } from '../../core/sessao/origemDoInicio'

/**
 * Leva o IP e o User-Agent do `POST /api/me/sessions/start` até a `ChargingSession` (L1.8, prova para o dossiê de chargeback). A sessão só EXISTE depois do `StartTransaction` do
 * carregador (outro processo, o gateway OCPP), então o dado viaja por um REDIS de vida curta, chaveado pelo idTag VIRTUAL (único por disparo):
 *   1. `guardarOrigemDoInicio` — na API, ANTES do RemoteStart (sem await do Redis lento: prazo curto), TTL de 15 min; só quem passa a origem (o app do motorista — o remote-start do
 *      ADMIN não passa, então sessões do suporte ficam sem origem). Chave expira sozinha (o dado é pessoal: nada fica no Redis além do necessário).
 *   2. `aplicarOrigemDoInicio` — no gateway, DEPOIS de a sessão estar gravada, em SEGUNDO PLANO: lê a chave, grava `startIp/startUserAgent` e apaga a chave.
 *
 * NUNCA derruba o início da sessão: as duas pontas engolem qualquer erro (Redis fora, banco lento, valor estranho), logam um aviso e seguem. O StartTransaction não espera por isto
 * (o `UPDATE` roda depois que o carregador já recebeu a resposta). O custo de falhar é só uma sessão sem prova de origem — nunca uma recarga recusada ou cobrança errada.
 */

const TTL_SEGUNDOS = 15 * 60
const PRAZO_REDIS_MS = 500
const chave = (idTag: string) => `session-origin:${idTag}`

/** Nunca lança. */
export async function guardarOrigemDoInicio(idTag: string, bruta: { ip?: unknown; userAgent?: unknown }): Promise<void> {
  try {
    const origem = normalizarOrigemDoInicio(bruta)
    if (origem === null) return
    await withDeadline(redis.set(chave(idTag), JSON.stringify(origem), 'EX', TTL_SEGUNDOS), PRAZO_REDIS_MS, 'guardar origem do início da sessão')
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[sessao] não foi possível guardar a origem do início da sessão (a recarga segue sem ela)')
  }
}

function lerOrigem(texto: string | null): OrigemDoInicio | null {
  if (texto === null) return null
  try {
    const bruto = JSON.parse(texto) as { ip?: unknown; userAgent?: unknown }
    return normalizarOrigemDoInicio(bruto) // re-normaliza: o que vem do Redis não é confiável para o tamanho das colunas
  } catch {
    return null
  }
}

/** Nunca lança. Devolve `true` se gravou. */
export async function aplicarOrigemDoInicio(sessionId: string, idTag: string): Promise<boolean> {
  try {
    const texto = await withDeadline(redis.get(chave(idTag)), PRAZO_REDIS_MS, 'ler origem do início da sessão')
    const origem = lerOrigem(texto)
    if (origem === null) return false
    await prisma.chargingSession.update({ where: { id: sessionId }, data: { startIp: origem.ip, startUserAgent: origem.userAgent } })
    await withDeadline(redis.del(chave(idTag)), PRAZO_REDIS_MS, 'apagar origem do início da sessão').catch(() => {}) // expira sozinha em 15 min de qualquer jeito
    return true
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, '[sessao] não foi possível gravar a origem do início da sessão (a recarga segue sem ela)')
    return false
  }
}
