/**
 * Regras PURAS das notificações ao motorista (L1.6, DL5) — sem Prisma, sem Redis, sem relógio. A fila, o banco e o SMTP estão em `services/notificacoes/`.
 *
 * DL5 (decisão do dono): segurança e cobrança são SEMPRE enviadas (`PASSWORD_CHANGED`, `SESSION_PAYMENT_FAILED`, `ACCOUNT_DELETED`) — não existe coluna nem chave para desligar.
 * Recibo (`sessionReceiptEmail`) e saldo baixo (`lowBalanceEnabled`) são opcionais e vêm LIGADOS; o limiar do saldo baixo é configurável (R$ 5 a R$ 500, padrão R$ 20).
 * Os tipos que o contrato não põe em nenhuma chave (`TOPUP_CREDITED`, `REMOTE_START_BY_SUPPORT`) também não têm como ser desligados: o primeiro é o comprovante de dinheiro
 * que entrou, o segundo é transparência sobre um ato do suporte na conta da pessoa.
 */

export const NOTIFICATION_TYPES = [
  'SESSION_COMPLETED',
  'SESSION_PAYMENT_FAILED',
  'SESSION_CLOSED_BY_SERVER',
  'LOW_BALANCE',
  'TOPUP_CREDITED',
  'REMOTE_START_BY_SUPPORT',
  'PASSWORD_CHANGED',
  'ACCOUNT_DELETED',
] as const
export type TipoDeNotificacao = (typeof NOTIFICATION_TYPES)[number]

/** Espelho de `ALWAYS_ON_NOTIFICATION_TYPES` do contrato (`frontend/src/types/api.ts`) — um teste confere a paridade. */
export const TIPOS_SEMPRE_LIGADOS = ['PASSWORD_CHANGED', 'SESSION_PAYMENT_FAILED', 'ACCOUNT_DELETED'] as const satisfies readonly TipoDeNotificacao[]

export const LIMIAR_SALDO_BAIXO_MIN_CENTS = 500
export const LIMIAR_SALDO_BAIXO_MAX_CENTS = 50_000
export const LIMIAR_SALDO_BAIXO_PADRAO_CENTS = 2_000

export interface PreferenciasDeNotificacao {
  sessionReceiptEmail: boolean
  lowBalanceEnabled: boolean
  lowBalanceThresholdCents: number
}

/** O que vale para quem nunca mexeu (sem linha em `NotificationPreference`). */
export const PREFERENCIAS_PADRAO: Readonly<PreferenciasDeNotificacao> = Object.freeze({
  sessionReceiptEmail: true,
  lowBalanceEnabled: true,
  lowBalanceThresholdCents: LIMIAR_SALDO_BAIXO_PADRAO_CENTS,
})

export type MotivoDeDispensa = 'PREFERENCE_OFF'

export type DecisaoDeEnvio = { enviar: true } | { enviar: false; motivo: MotivoDeDispensa }

export function ehSempreLigado(tipo: TipoDeNotificacao): boolean {
  return (TIPOS_SEMPRE_LIGADOS as readonly string[]).includes(tipo)
}

/** Preferência desligada dispensa SÓ o que é opcional; segurança e cobrança passam mesmo com `prefs` adulteradas/desligadas. */
export function decidirEnvio(tipo: TipoDeNotificacao, prefs: PreferenciasDeNotificacao): DecisaoDeEnvio {
  if (ehSempreLigado(tipo)) return { enviar: true }
  switch (tipo) {
    case 'SESSION_COMPLETED':
    case 'SESSION_CLOSED_BY_SERVER':
      return prefs.sessionReceiptEmail ? { enviar: true } : { enviar: false, motivo: 'PREFERENCE_OFF' }
    case 'LOW_BALANCE':
      return prefs.lowBalanceEnabled ? { enviar: true } : { enviar: false, motivo: 'PREFERENCE_OFF' }
    default:
      return { enviar: true }
  }
}

/**
 * Saldo baixo SÓ no CRUZAMENTO do limiar: o saldo ANTES do movimento estava no limiar ou acima e DEPOIS ficou abaixo. Quem já estava abaixo (R$ 15 -> R$ 10) não é avisado de novo;
 * quem sobe e volta a cruzar é avisado de novo (cada cruzamento é um fato novo).
 */
export function cruzouLimiarDeSaldoBaixo(saldoAntesCents: number, saldoDepoisCents: number, limiarCents: number): boolean {
  return saldoAntesCents >= limiarCents && saldoDepoisCents < limiarCents
}

export function limiarValido(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= LIMIAR_SALDO_BAIXO_MIN_CENTS && valor <= LIMIAR_SALDO_BAIXO_MAX_CENTS
}

/** Id do job BullMQ: o mesmo fato (tipo + entidade) nunca tem dois jobs vivos. Sem `:` (o BullMQ recusa) nem espaço. */
export function jobIdDaNotificacao(tipo: TipoDeNotificacao, entityId: string): string {
  return `notif-${tipo}-${entityId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** Política de tentativas do job: 6 tentativas, backoff exponencial a partir de 30 s (30 s, 1, 2, 4, 8 min — ~15 min no total) antes de alertar. */
export const NOTIFICACAO_JOB_ATTEMPTS = 6
export const NOTIFICACAO_JOB_BACKOFF_MS = 30_000

/** `statusReason` só aceita CÓDIGO (o banco recusa espaço/`@`): qualquer coisa fora do padrão vira um código genérico — NUNCA a mensagem do SMTP (costuma repetir o endereço). */
export function codigoSeguroDeMotivo(bruto: unknown, padrao = 'SEND_FAILED'): string {
  return typeof bruto === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(bruto) ? bruto : padrao
}
