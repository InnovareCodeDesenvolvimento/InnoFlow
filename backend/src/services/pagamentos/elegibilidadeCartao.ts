import { createHash } from 'node:crypto'
import { ipKeyGenerator } from 'express-rate-limit'
import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { incrWithTtl } from '../../lib/redisCounter'
import { withDeadline } from '../../lib/withDeadline'
import { cartaoLiberadoParaUsuario } from '../../core/pagamentos/configGateway'
import { AppError } from '../../api/middleware/errorHandler'

/**
 * I-7 (decisão do dono, 04/10/2026) — quem pode PAGAR COM CARTÃO. Duas camadas, só para CARTÃO (Pix e carteira nunca passam por aqui):
 *  1. IDENTIDADE VERIFICADA: `cartaoLiberadoParaUsuario` (googleSub OU staff). Desligável por `CARD_REQUIRE_VERIFIED_IDENTITY` (padrão: ligado em produção). Recusa com 403
 *     `CARD_REQUIRES_VERIFIED_IDENTITY`. Cartões JÁ cadastrados de quem não é elegível seguem na lista (a tela os mostra), mas inutilizáveis.
 *  2. BLOQUEIO POR RECUSAS (carding), em Redis, janela FIXA a partir do 1º evento (TTL):
 *     - recusas de cartão por USUÁRIO em 24 h (`CARD_BLOCK_MAX_REFUSALS_PER_USER_DAY`, padrão 3);
 *     - recusas de cartão por IP em 1 h (`CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR`, padrão 10);
 *     - cadastros de cartão TENTADOS por usuário em 24 h (`CARD_BLOCK_MAX_REGISTRATIONS_PER_USER_DAY`, padrão 10).
 *     Bloqueado => 429 `CARD_TEMPORARILY_BLOCKED` + `Retry-After` + `details.blockedUntil`, e UM alerta `payment_card_testing_suspected` quando o contador cruza o limite
 *     (sem dado pessoal: IP só mascarado em /24; o usuário só pelo id interno). A chave do IP no Redis é um hash (nenhum IP cru fica guardado).
 *  3. CHARGEBACK (L1.8, DL7/P3): o motorista que teve um chargeback registrado perde o MODO CARTÃO (Pix e carteira seguem). Bloqueio DERIVADO do razão `PaymentReversal` (sem flag): existe
 *     chargeback OPEN, ou LOST/ACCEPTED que o ADMIN ainda não desbloqueou (`cardUnblockedAt` nulo). WON libera sozinho; LOST/ACCEPTED só com o desbloqueio manual. Vem ANTES da identidade
 *     (mandar quem tem chargeback "entrar com o Google" seria um beco sem saída) e é fail-CLOSED (erro de banco propaga — é o portão de dinheiro). Recusa com 403 `CARD_CHARGEBACK_BLOCKED`.
 *  Falha de Redis => NÃO bloqueia (fail-open, com aviso): é um freio de abuso, não o portão de dinheiro; o portão de identidade (1) não depende de Redis.
 */

const PRAZO_REDIS_MS = 2_000
const JANELA_DIA_SEG = 24 * 3600
const JANELA_HORA_SEG = 3600

export type MotivoInelegibilidadeCartao = 'GOOGLE_LOGIN_REQUIRED' | 'TEMPORARILY_BLOCKED' | 'CHARGEBACK_BLOCKED'

export interface ElegibilidadeCartao {
  eligible: boolean
  reason: MotivoInelegibilidadeCartao | null
  blockedUntil: string | null
}

type EscopoContador = 'user_refusals' | 'ip_refusals' | 'user_registrations'

/** `a.b.c.d` -> `a.b.c.0/24`; IPv6 -> 3 primeiros grupos `/48`; ausente -> `desconhecido`. Só para LOG/alerta. */
export function mascararIp(ip: string | null | undefined): string {
  if (!ip) return 'desconhecido'
  const v4 = ip.replace(/^::ffff:/i, '')
  const m = /^([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})[.][0-9]{1,3}$/.exec(v4)
  if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`
  if (v4.includes(':')) return `${v4.split(':').slice(0, 3).join(':')}::/48`
  return 'desconhecido'
}

function chaveDoIp(ip: string): string {
  const base = ip.replace(/^::ffff:/i, '')
  return createHash('sha256').update(ipKeyGenerator(base)).digest('hex').slice(0, 24)
}

const chaveUsuarioRecusas = (userId: string) => `card-risk:refusals:user:${userId}`
const chaveIpRecusas = (ip: string) => `card-risk:refusals:ip:${chaveDoIp(ip)}`
const chaveUsuarioCadastros = (userId: string) => `card-risk:registrations:user:${userId}`

function limiteDe(escopo: EscopoContador): number {
  if (escopo === 'user_refusals') return env.CARD_BLOCK_MAX_REFUSALS_PER_USER_DAY
  if (escopo === 'ip_refusals') return env.CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR
  return env.CARD_BLOCK_MAX_REGISTRATIONS_PER_USER_DAY
}

async function melhorEsforco<T>(operacao: Promise<T>, padrao: T, o: string): Promise<T> {
  try {
    return await withDeadline(operacao, PRAZO_REDIS_MS, o)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), operacao: o }, '[elegibilidadeCartao] Redis indisponível — controle de abuso do cartão ignorado nesta chamada (fail-open)')
    return padrao
  }
}

/**
 * Até quando o bloqueio vale (o MAIOR prazo entre os contadores que estouraram), ou `null`.
 *
 * UM prazo TOTAL (`PRAZO_REDIS_MS`) para a leitura inteira: os contadores são lidos em PARALELO e os TTLs dos que estouraram também. Antes eram até 3 leituras sequenciais de 2 s cada, e com o
 * Redis fora/travado cada tela de cartão esperava ~6 s antes do fail-open (achado da Íris, rodada 3). Estourou o prazo (ou o Redis falhou): fail-open ruidoso, UM aviso por chamada.
 */
async function bloqueadoAte(userId: string, ip: string | null | undefined): Promise<Date | null> {
  const contadores: Array<[string, EscopoContador]> = [
    [chaveUsuarioRecusas(userId), 'user_refusals'],
    [chaveUsuarioCadastros(userId), 'user_registrations'],
  ]
  if (ip) contadores.push([chaveIpRecusas(ip), 'ip_refusals'])

  const ler = async (): Promise<Date | null> => {
    const valores = await Promise.all(contadores.map(([chave]) => redis.get(chave)))
    const estourados = contadores.filter(([, escopo], i) => valores[i] !== null && Number(valores[i]) >= limiteDe(escopo))
    if (estourados.length === 0) return null
    const ttls = await Promise.all(estourados.map(([chave]) => redis.pttl(chave)))
    let ate: Date | null = null
    estourados.forEach(([, escopo], i) => {
      const ttlMs = ttls[i]
      const fim = new Date(Date.now() + (ttlMs > 0 ? ttlMs : (escopo === 'ip_refusals' ? JANELA_HORA_SEG : JANELA_DIA_SEG) * 1000))
      if (ate === null || fim > ate) ate = fim
    })
    return ate
  }
  return melhorEsforco(ler(), null as Date | null, 'ler contadores de risco do cartão')
}

/**
 * O motorista está bloqueado no cartão por chargeback? Mesma consulta do `docs/MODELO-DADOS-LOTE1.md` §4 (índice parcial `ix_payment_reversal_card_block`) + o desbloqueio manual: OPEN bloqueia sempre;
 * LOST/ACCEPTED bloqueiam até `cardUnblockedAt` ser preenchido; WON nunca bloqueia.
 */
export async function motoristaBloqueadoPorChargeback(userId: string): Promise<boolean> {
  const achado = await prisma.paymentReversal.findFirst({
    where: { userId, kind: 'CHARGEBACK', OR: [{ status: 'OPEN' }, { status: { in: ['LOST', 'ACCEPTED'] }, cardUnblockedAt: null }] },
    select: { id: true },
  })
  return achado !== null
}

/** Elegibilidade completa (para `GET /api/me/payment-methods` e para os portões). */
export async function avaliarElegibilidadeCartao(userId: string, ip?: string | null): Promise<ElegibilidadeCartao> {
  if (await motoristaBloqueadoPorChargeback(userId)) return { eligible: false, reason: 'CHARGEBACK_BLOCKED', blockedUntil: null }
  if (env.CARD_REQUIRE_VERIFIED_IDENTITY) {
    const usuario = await prisma.user.findUnique({ where: { id: userId }, select: { googleSub: true, role: true } })
    if (!cartaoLiberadoParaUsuario(usuario)) return { eligible: false, reason: 'GOOGLE_LOGIN_REQUIRED', blockedUntil: null }
  }
  const ate = await bloqueadoAte(userId, ip)
  if (ate) return { eligible: false, reason: 'TEMPORARILY_BLOCKED', blockedUntil: ate.toISOString() }
  return { eligible: true, reason: null, blockedUntil: null }
}

/** Portão: lança 403 `CARD_REQUIRES_VERIFIED_IDENTITY` ou 429 `CARD_TEMPORARILY_BLOCKED` (com `Retry-After`). Só COMEÇOS de cartão. */
export async function exigirCartaoElegivel(userId: string, ip?: string | null): Promise<void> {
  const e = await avaliarElegibilidadeCartao(userId, ip)
  if (e.eligible) return
  if (e.reason === 'CHARGEBACK_BLOCKED') {
    throw new AppError('O pagamento com cartão está indisponível para a sua conta. O Pix e a carteira continuam disponíveis. Em caso de dúvida, fale com o suporte.', 403, 'CARD_CHARGEBACK_BLOCKED')
  }
  if (e.reason === 'GOOGLE_LOGIN_REQUIRED') {
    throw new AppError('Para pagar com cartão, entre com a sua conta Google. O Pix e a carteira continuam disponíveis.', 403, 'CARD_REQUIRES_VERIFIED_IDENTITY')
  }
  const retryAfter = Math.max(1, Math.ceil((new Date(e.blockedUntil!).getTime() - Date.now()) / 1000))
  throw new AppError('O pagamento com cartão está temporariamente indisponível para a sua conta. O Pix e a carteira continuam disponíveis.', 429, 'CARD_TEMPORARILY_BLOCKED', { blockedUntil: e.blockedUntil! }, { 'Retry-After': String(retryAfter) })
}

async function contar(chave: string, ttlSeg: number, escopo: EscopoContador, userId: string | null, ip: string | null | undefined): Promise<void> {
  const total = await melhorEsforco(incrWithTtl(redis, chave, ttlSeg), 0, 'contar evento de risco do cartão')
  if (total === 0) return
  if (total === limiteDe(escopo)) {
    // Cruzou o limite AGORA (uma vez por janela): é o sinal de "teste de cartões". Sem dado pessoal.
    logger.warn(
      { alert: 'payment_card_testing_suspected', escopo, limite: limiteDe(escopo), ipMascarado: mascararIp(ip), ...(userId && escopo !== 'ip_refusals' ? { userId } : {}) },
      '[elegibilidadeCartao] limite de recusas/tentativas de cartão atingido — cartão bloqueado temporariamente (Pix e carteira seguem)',
    )
  }
}

/** Uma recusa de cartão pela Cielo (intent DENIED por recusa/4xx definitivo). Soma no usuário (24 h) e no IP (1 h). Nunca lança. */
export async function registrarRecusaDeCartao(params: { userId: string; ip?: string | null }): Promise<void> {
  try {
    await contar(chaveUsuarioRecusas(params.userId), JANELA_DIA_SEG, 'user_refusals', params.userId, params.ip)
    if (params.ip) await contar(chaveIpRecusas(params.ip), JANELA_HORA_SEG, 'ip_refusals', null, params.ip)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[elegibilidadeCartao] falha ao registrar recusa de cartão (ignorada)')
  }
}

/** Um cadastro de cartão TENTADO (conta mesmo que falhe depois). Nunca lança. */
export async function registrarTentativaDeCadastroDeCartao(params: { userId: string; ip?: string | null }): Promise<void> {
  try {
    await contar(chaveUsuarioCadastros(params.userId), JANELA_DIA_SEG, 'user_registrations', params.userId, params.ip)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[elegibilidadeCartao] falha ao registrar tentativa de cadastro (ignorada)')
  }
}

/** Só para teste: apaga os contadores de um usuário (e de um IP). */
export async function limparRiscoDeCartaoParaTeste(userId: string, ip?: string): Promise<void> {
  await redis.del(chaveUsuarioRecusas(userId), chaveUsuarioCadastros(userId), ...(ip ? [chaveIpRecusas(ip)] : []))
}
