import { createHash, randomBytes } from 'node:crypto'

/**
 * Núcleo PURO da redefinição de senha por e-mail (L1.3): gera/valida/hasheia o token, decide QUEM recebe o quê e monta o link. Sem Redis, Prisma, SMTP, relógio implícito
 * ou `env` — tudo entra por parâmetro, para ser testável sem infraestrutura. O serviço (`services/auth/redefinicaoSenha.ts`) liga isto aos adaptadores.
 *
 * Decisões fixadas (Nova + dono, DL1/DL5):
 *  - token: 32 bytes aleatórios (256 bits) em base64url (43 caracteres). O Redis guarda SÓ o sha-256 dele;
 *  - ADMIN NUNCA redefine por e-mail (só pelo script `user:set-password`) — `decidirSolicitacao` devolve `NADA/ADMIN`;
 *  - conta sem senha que entra com o Google recebe um AVISO sem token (a identidade verificada do I-7 continua ancorada no Google: um link de e-mail não pode "criar uma
 *    senha" numa conta cujo e-mail só foi provado pelo Google);
 *  - o link leva o token no FRAGMENTO (`#t=`): não vai para access log do proxy nem para o `Referer`.
 */

/** Vida do token: curta de propósito (uso único; o e-mail só importa nos primeiros minutos). */
export const TTL_TOKEN_REDEFINICAO_SEGUNDOS = 30 * 60
const BYTES_DO_TOKEN = 32
const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{43}$/

export function gerarTokenRedefinicao(): string {
  return randomBytes(BYTES_DO_TOKEN).toString('base64url')
}

/** Barra lixo ANTES de tocar no Redis (o token real tem sempre exatamente este formato). */
export function formatoDeTokenValido(token: unknown): token is string {
  return typeof token === 'string' && FORMATO_DO_TOKEN.test(token)
}

/** O que o Redis guarda como chave: nunca o token. */
export function hashDoToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Chave de contador por e-mail: hash do endereço normalizado (o e-mail em claro nunca vira chave do Redis). */
export function hashDoEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex')
}

/** Chave de contador por IP (o IP cru não é gravado no Redis). */
export function hashDoIp(ip: string): string {
  return createHash('sha256').update(`ip:${ip}`, 'utf8').digest('hex').slice(0, 32)
}

/**
 * "Impressão" da senha vigente: se a senha mudar por OUTRO caminho depois do pedido (troca autenticada, vínculo do Google que zera a senha, script), o link morre.
 * Só um hash curto do hash — nunca o `passwordHash` em si.
 */
export function impressaoDaSenha(passwordHash: string | null): string {
  return createHash('sha256').update(`pwd:${passwordHash ?? ''}`, 'utf8').digest('hex').slice(0, 32)
}

export interface ContaParaRedefinicao {
  id: string
  role: 'ADMIN' | 'OPERATOR' | 'DRIVER'
  active: boolean
  passwordHash: string | null
  googleSub: string | null
}

export type DecisaoDeSolicitacao =
  | { acao: 'ENVIAR_LINK' }
  | { acao: 'AVISO_GOOGLE' }
  | { acao: 'NADA'; motivo: 'INEXISTENTE' | 'ADMIN' | 'INATIVA' }

/** Quem recebe o quê. A resposta HTTP é a mesma (202) para TODOS os casos — isto só decide o que acontece em segundo plano. */
export function decidirSolicitacao(conta: ContaParaRedefinicao | null): DecisaoDeSolicitacao {
  if (!conta) return { acao: 'NADA', motivo: 'INEXISTENTE' }
  // ADMIN antes de `active`: mesmo desativado, a tentativa de redefinir a senha de um ADMIN por e-mail é sinal que vale auditar.
  if (conta.role === 'ADMIN') return { acao: 'NADA', motivo: 'ADMIN' }
  if (!conta.active) return { acao: 'NADA', motivo: 'INATIVA' }
  if (conta.googleSub && !conta.passwordHash) return { acao: 'AVISO_GOOGLE' }
  return { acao: 'ENVIAR_LINK' }
}

/** O token foi emitido para esta conta e ela ainda pode redefinir (defesa em profundidade no CONSUMO: o mundo muda entre o pedido e o clique). */
export function contaPodeConsumirToken(conta: ContaParaRedefinicao | null, impressaoDoToken: string): boolean {
  if (!conta) return false
  if (conta.role === 'ADMIN' || !conta.active) return false
  return impressaoDaSenha(conta.passwordHash) === impressaoDoToken
}

export interface FontesDaBaseUrl {
  publicAppUrl?: string
  /** `CORS_ALLOWED_ORIGINS` (a primeira origem vale como reserva). */
  corsOrigins: readonly string[]
  producao: boolean
}

function origemUtilizavel(bruto: string | undefined, producao: boolean): string | null {
  if (!bruto) return null
  let url: URL
  try {
    url = new URL(bruto)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (producao) {
    // Em produção: https e nada de máquina local — um link de e-mail para localhost/http é configuração esquecida, não destino.
    if (url.protocol !== 'https:') return null
    if (/^(localhost|127\.|\[::1\])/i.test(url.hostname)) return null
  }
  return url.origin
}

/** Origem pública do FRONTEND para os links dos e-mails: `PUBLIC_APP_URL` > primeira origem do CORS. NUNCA vem da requisição. `null` = sem destino confiável (não enviar). */
export function resolverBaseUrlPublica(f: FontesDaBaseUrl): string | null {
  return origemUtilizavel(f.publicAppUrl, f.producao) ?? origemUtilizavel(f.corsOrigins[0], f.producao)
}

/** `https://<app>/redefinir-senha#t=<token>` — token no FRAGMENTO, nunca em query/path. */
export function montarLinkDeRedefinicao(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/redefinir-senha#t=${token}`
}
