import { redis } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { incrWithTtl } from '../../lib/redisCounter'
import { adquirirLock, liberarLock } from '../../lib/redisLock'
import { withDeadline } from '../../lib/withDeadline'

/**
 * Controle de repetição do CANCELAMENTO de pré-autorização (I-3 da auditoria). Tudo em Redis, com TTL — SEM coluna nem estado novo no banco (um estado `VOID_FAILED`
 * exigiria enum novo no Prisma: decisão do Cronos). Quatro peças, todas por intent:
 *  - LOCK (como na captura): o varredor A e o `finalizarSessao` não cancelam o mesmo intent ao mesmo tempo (o 2º void seria recusado e geraria alerta falso). Redis fora => NÃO cancela
 *    (falha fechada: o varredor repete);
 *  - CONTADOR de desfechos não confirmados (TTL longo);
 *  - BACKOFF: depois de um desfecho em andamento/indefinido, pausa crescente (1, 2, 4... até 60 min) antes de gastar outra chamada à Cielo;
 *  - PARADA: recusa DEFINITIVA (40, 41, 53, 101, 103–107) e indefinido repetido => `payment_void_manual_review` e para de repetir (a Cielo disse não, insistir só gera ruído).
 * Os alertas de falha de void saem no máximo 1x/hora por intent e por tipo.
 *
 * Toda leitura/escrita de controle é "melhor esforço" (prazo curto, erro engolido), EXCETO o lock. Perder o estado de controle (Redis reiniciou) só faz o varredor tentar mais uma
 * vez e reconstruir o estado — nunca cancela ou deixa de cancelar algo errado, porque quem decide é a Cielo (a consulta antes do void).
 */

const PRAZO_REDIS_MS = 3_000
const TTL_CONTROLE_SEG = 14 * 24 * 3600
const TTL_PARADA_SEG = 30 * 24 * 3600
/** Desfechos INDEFINIDOS seguidos até desistir e pedir revisão manual. */
export const MAX_INDEFINIDOS_ATE_REVISAO = 5
export const BACKOFF_BASE_SEGUNDOS = 60
export const BACKOFF_MAX_SEGUNDOS = 3_600
const INTERVALO_ALERTA_SEG = 3_600

const k = (parte: string, id: string) => `card-void:${parte}:${id}`

export const chaveLockCancelamento = (id: string) => k('lock', id)

/** TTL do lock: cobre consulta + cancelamento (cada um com o timeout da Cielo) + a transação local, com folga. */
function ttlLockCancelamentoMs(): number {
  return Math.max(60_000, env.CIELO_TIMEOUT_MS * 6)
}

export async function adquirirLockCancelamento(paymentIntentId: string): Promise<string | null> {
  return withDeadline(adquirirLock(redis, chaveLockCancelamento(paymentIntentId), ttlLockCancelamentoMs()), PRAZO_REDIS_MS, 'adquirir o lock do cancelamento')
}

export async function liberarLockCancelamento(paymentIntentId: string, token: string): Promise<void> {
  await withDeadline(liberarLock(redis, chaveLockCancelamento(paymentIntentId), token), PRAZO_REDIS_MS, 'liberar o lock do cancelamento').catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err), paymentIntentId }, '[cancelarPreAutorizacao] não consegui liberar o lock — expira sozinho pelo TTL')
  })
}

async function melhorEsforco<T>(operacao: Promise<T>, padrao: T, paymentIntentId: string): Promise<T> {
  try {
    return await withDeadline(operacao, PRAZO_REDIS_MS, 'controle do cancelamento')
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), paymentIntentId }, '[cancelarPreAutorizacao] Redis indisponível para o controle de repetição — seguindo sem ele')
    return padrao
  }
}

/** Deve pular este intent AGORA (parada definitiva ou backoff em curso)? Redis fora => não pula. */
export async function cancelamentoDeveEsperar(paymentIntentId: string): Promise<'PARADO' | 'BACKOFF' | null> {
  const [parado, backoff] = await melhorEsforco(Promise.all([redis.exists(k('stop', paymentIntentId)), redis.exists(k('next', paymentIntentId))]), [0, 0], paymentIntentId)
  if (parado) return 'PARADO'
  if (backoff) return 'BACKOFF'
  return null
}

/** Conta mais um desfecho não confirmado; devolve o total (1 se o Redis falhar). */
export async function contarDesfechoNaoConfirmado(paymentIntentId: string): Promise<number> {
  return melhorEsforco(incrWithTtl(redis, k('attempts', paymentIntentId), TTL_CONTROLE_SEG), 1, paymentIntentId)
}

export function backoffSegundos(tentativas: number): number {
  return Math.min(BACKOFF_MAX_SEGUNDOS, BACKOFF_BASE_SEGUNDOS * 2 ** Math.max(0, tentativas - 1))
}

export async function pausarCancelamento(paymentIntentId: string, segundos: number): Promise<void> {
  await melhorEsforco(redis.set(k('next', paymentIntentId), '1', 'EX', segundos), null, paymentIntentId)
}

export async function pararCancelamento(paymentIntentId: string): Promise<void> {
  await melhorEsforco(redis.set(k('stop', paymentIntentId), '1', 'EX', TTL_PARADA_SEG), null, paymentIntentId)
}

/** `true` se este alerta (tipo+intent) PODE sair agora (no máximo 1x/h). Redis fora => deixa sair (melhor um alerta repetido que nenhum). */
export async function podeAlertar(paymentIntentId: string, tipo: string, intervaloSeg: number = INTERVALO_ALERTA_SEG): Promise<boolean> {
  const r = await melhorEsforco(redis.set(k(`alert:${tipo}`, paymentIntentId), '1', 'EX', intervaloSeg, 'NX'), 'OK' as 'OK' | null, paymentIntentId)
  return r === 'OK'
}

/** Só para teste/limpeza: apaga o estado de controle de um intent. */
export async function limparControleCancelamento(paymentIntentId: string): Promise<void> {
  await melhorEsforco(redis.del(k('stop', paymentIntentId), k('next', paymentIntentId), k('attempts', paymentIntentId)), 0, paymentIntentId)
}
