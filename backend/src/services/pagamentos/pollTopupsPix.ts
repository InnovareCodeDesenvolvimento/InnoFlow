import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { withDeadline } from '../../lib/withDeadline'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { emitTopupUpdated, emitWalletUpdated } from '../../realtime/emit'
import { creditarTopupPix } from './creditarTopupPix'
import { getPagamentoPort } from './pagamentoPortInstance'
import { ambienteDoIntentConfere } from './ambienteDoIntent'

/**
 * Crédito do Pix por POLLING (decisão do dono, 04/10/2026: a conta Cielo é COMPARTILHADA com o Parque das Feiras e a URL de notificação do Site Cielo é UMA por estabelecimento e é do Parque —
 * o InnoFlow NÃO a cadastra). Sem webhook, "pago" só é descoberto perguntando à Cielo. Dois gatilhos, ambos idempotentes porque passam por `creditarTopupPix` (reconsulta + `FOR UPDATE` no intent
 * e na carteira + `status = PAID` + índice único `ux_wallet_entry_topup_once`) — consultar de novo, ou duas vezes ao mesmo tempo, nunca credita em dobro:
 *  1. VARREDOR periódico (`varrerTopupsPixPendentes`, job `poll-topups-pix`): todo Pix PENDING com idade mínima curta e ainda dentro do prazo, com BACKOFF crescente por idade e teto por rodada;
 *  2. LEITURA pelo app (`tentarCreditarPixPendente`, usada por `GET /api/me/wallet/topups/:id`): quem está olhando a tela vê o crédito sem esperar o varredor, com um intervalo mínimo por intent.
 * O webhook, se um dia existir, continua sendo só uma DICA que adianta o mesmo caminho. A expiração segue com `varrerTopupsPixExpirados` (reconsulta antes de expirar).
 */

const PRAZO_REDIS_MS = 3_000
/** Consultas à Cielo por rodada do varredor (teto duro — nunca martela a Cielo). */
export const LOTE_POLL_PIX = 50
const MAX_PAGINAS = 6
const PAGINA = 50

/**
 * Intervalo entre consultas do MESMO Pix, por idade: 15 s no 1º minuto (o motorista está olhando a tela), 30 s até 5 min, 60 s até 30 min, 120 s depois. O QR vale 30 min por padrão,
 * então a maior parte das consultas fica nos primeiros minutos, que é onde o crédito imediato importa.
 */
export function backoffPollSegundos(idadeSegundos: number): number {
  if (idadeSegundos < 60) return 15
  if (idadeSegundos < 300) return 30
  if (idadeSegundos < 1800) return 60
  return 120
}

export const chaveProximaConsultaPix = (intentId: string) => `pix-poll:next:${intentId}`
export const chaveConsultaPorLeituraPix = (intentId: string) => `pix-poll:read:${intentId}`

/** Credita (idempotente) e publica os eventos de tempo real. `true` = creditou AGORA. Erros de publicação não derrubam o crédito. */
export async function creditarEPublicar(intentId: string, port: PagamentoPort): Promise<boolean> {
  const resultado = await creditarTopupPix(intentId, port)
  if (!resultado) return false
  await Promise.all([emitWalletUpdated(resultado.userId, resultado.balanceAfterCents), emitTopupUpdated(resultado.userId, resultado.paymentIntentId, 'PAID')]).catch((err) =>
    logger.error({ err, intentId }, '[pollTopupsPix] falha ao publicar eventos de tempo real (não bloqueante)'),
  )
  return true
}

/** Reserva o direito de consultar (SET NX EX). `true` = pode consultar agora. Redis fora => `false` (não martela a Cielo sem controle). */
async function reservar(chave: string, segundos: number): Promise<boolean> {
  try {
    return (await withDeadline(redis.set(chave, '1', 'EX', segundos, 'NX'), PRAZO_REDIS_MS, 'reservar consulta de Pix')) === 'OK'
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[pollTopupsPix] sem Redis para controlar o intervalo das consultas — pulando')
    return false
  }
}

/**
 * Chamado pela LEITURA do top-up pelo app: se o Pix ainda está PENDING, reconsulta (no máximo 1x a cada `minIntervaloSeg` por intent) e credita se já foi pago. Nunca lança e tem prazo (a
 * leitura da tela não pode esperar a Cielo indefinidamente). `true` = creditou agora (quem chamou deve reler o intent).
 */
export async function tentarCreditarPixPendente(intentId: string, opcoes: { minIntervaloSeg?: number; prazoMs?: number; port?: PagamentoPort } = {}): Promise<boolean> {
  const { minIntervaloSeg = 5, prazoMs = 6_000 } = opcoes
  try {
    if (!(await reservar(chaveConsultaPorLeituraPix(intentId), minIntervaloSeg))) return false
    const port = opcoes.port ?? (await getPagamentoPort())
    return await withDeadline(creditarEPublicar(intentId, port), prazoMs, 'reconsulta do Pix na leitura')
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), intentId }, '[pollTopupsPix] reconsulta do Pix na leitura falhou — a tela mostra o estado atual e o varredor tenta de novo')
    return false
  }
}

/** Varredor periódico dos Pix PENDING (ver o comentário do módulo). */
export async function varrerTopupsPixPendentes(pagamentoPortInjetado?: PagamentoPort): Promise<{ consultados: number; creditados: number }> {
  const pagamentoPort = pagamentoPortInjetado ?? (await getPagamentoPort())
  const agora = Date.now()
  const idadeMinima = new Date(agora - env.TOPUP_PIX_POLL_MIN_AGE_MS)

  let consultados = 0
  let creditados = 0
  let cursor: string | undefined

  for (let pagina = 0; pagina < MAX_PAGINAS && consultados < LOTE_POLL_PIX; pagina++) {
    const pendentes = await prisma.paymentIntent.findMany({
      where: {
        purpose: 'WALLET_TOPUP_PIX',
        status: 'PENDING',
        cieloPaymentId: { not: null },
        createdAt: { lte: idadeMinima },
        // vencidos ficam com `varrerTopupsPixExpirados` (que também reconsulta antes de expirar)
        OR: [{ pixExpiresAt: null }, { pixExpiresAt: { gt: new Date(agora) } }],
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: PAGINA,
    })
    if (pendentes.length === 0) break
    cursor = pendentes[pendentes.length - 1].id

    for (const intent of pendentes) {
      if (consultados >= LOTE_POLL_PIX) break
      try {
        if (!(await ambienteDoIntentConfere(intent, 'varrerTopupsPixPendentes'))) continue // outro ambiente: nem consulta
        const idadeSeg = Math.floor((agora - intent.createdAt.getTime()) / 1000)
        if (!(await reservar(chaveProximaConsultaPix(intent.id), backoffPollSegundos(idadeSeg)))) continue // ainda no backoff (ou Redis fora)
        consultados++
        if (await creditarEPublicar(intent.id, pagamentoPort)) creditados++
      } catch (err) {
        // Falha de rede/Cielo neste intent não derruba o lote; o backoff já foi reservado, então a próxima consulta vem depois dele (sem martelar).
        logger.error({ err, intentId: intent.id }, '[pollTopupsPix] falha ao reconsultar/creditar — tentando de novo depois do backoff')
      }
    }
    if (pendentes.length < PAGINA) break
  }

  if (creditados > 0) logger.info({ consultados, creditados }, '[pollTopupsPix] Pix creditados por polling (sem webhook)')
  return { consultados, creditados }
}
