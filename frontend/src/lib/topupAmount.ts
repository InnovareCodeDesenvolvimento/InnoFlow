import { formatCents } from "@/lib/utils"
import { parseReaisToCents } from "@/lib/money"

/**
 * Regras da tela "Adicionar saldo" (recarga Pix, F5.1). Puras e testáveis; o
 * servidor continua sendo a autoridade (`TOPUP_AMOUNT_OUT_OF_RANGE`) — isto só
 * evita viagem de rede à toa e mostra a mensagem certa antes de gerar o QR.
 * Mesmo espírito de `lib/walletAdjustment.ts`.
 */

/** R$ 10,00 a R$ 500,00 (pedido do dono). Não há endpoint público que exponha estes limites — se o backend mudar, ele responde `TOPUP_AMOUNT_OUT_OF_RANGE` e a tela mostra a mensagem genérica do código. */
export const TOPUP_MIN_AMOUNT_CENTS = 1_000
export const TOPUP_MAX_AMOUNT_CENTS = 50_000

/** Sugestões fixas exibidas como chips — nem toda sugestão precisa estar dentro do range se ele mudar, mas hoje as três cabem. */
export const TOPUP_SUGGESTED_AMOUNTS_CENTS = [2_000, 5_000, 10_000] as const

export interface TopupAmountValidation {
  error?: string
  /** `null` enquanto o texto digitado (modo "valor livre") for inválido. */
  amountCents: number | null
  valid: boolean
}

/** `amountInput` só é considerado quando nenhum chip está selecionado (`selectedChipCents === null`). */
export function validateTopupAmount(selectedChipCents: number | null, amountInput: string): TopupAmountValidation {
  const raw = selectedChipCents ?? parseReaisToCents(amountInput)

  if (selectedChipCents === null && amountInput.trim() === "") {
    return { error: "Escolha um valor ou digite o quanto quer adicionar.", amountCents: null, valid: false }
  }
  if (raw === null) {
    return { error: "Valor inválido. Use números, com até 2 casas decimais (ex.: 35,00).", amountCents: null, valid: false }
  }
  if (raw < TOPUP_MIN_AMOUNT_CENTS) {
    return { error: `O valor mínimo é ${formatCents(TOPUP_MIN_AMOUNT_CENTS)}.`, amountCents: null, valid: false }
  }
  if (raw > TOPUP_MAX_AMOUNT_CENTS) {
    return { error: `O valor máximo é ${formatCents(TOPUP_MAX_AMOUNT_CENTS)}.`, amountCents: null, valid: false }
  }
  return { amountCents: raw, valid: true }
}

/** Parte do valor escolhido que quitaria a dívida em aberto automaticamente — 0 quando não há dívida ou o valor ainda não é válido. */
export function debtSettledPreviewCents(amountCents: number | null, openDebtCents: number): number {
  if (amountCents === null || openDebtCents <= 0) return 0
  return Math.min(amountCents, openDebtCents)
}

/** Saldo LIVRE previsto depois de quitar a dívida (o restante do valor escolhido). */
export function freeBalancePreviewCents(amountCents: number | null, openDebtCents: number): number {
  if (amountCents === null) return 0
  return amountCents - debtSettledPreviewCents(amountCents, openDebtCents)
}

/** "Os primeiros R$ X do seu crédito quitam a dívida em aberto automaticamente" — só existe quando há dívida E um valor válido escolhido. */
export function debtWarningMessage(amountCents: number | null, openDebtCents: number): string | null {
  const settled = debtSettledPreviewCents(amountCents, openDebtCents)
  if (settled <= 0) return null
  return `Os primeiros ${formatCents(settled)} do seu crédito quitam a dívida em aberto automaticamente.`
}

/** Códigos do `POST /api/me/wallet/topups` → mensagem em português. Por `code`, nunca pelo texto do backend. */
export function createTopupErrorMessage(code: string | undefined): string {
  switch (code) {
    case "TOPUP_AMOUNT_OUT_OF_RANGE":
      return `O valor precisa estar entre ${formatCents(TOPUP_MIN_AMOUNT_CENTS)} e ${formatCents(TOPUP_MAX_AMOUNT_CENTS)}.`
    case "CPF_REQUIRED":
      return "Informe seu CPF para gerar o Pix."
    case "INVALID_CPF":
      return "CPF inválido — confira os números digitados."
    case "TOO_MANY_PENDING_TOPUPS":
      return "Você já tem uma recarga Pix aguardando pagamento. Pague ou espere expirar antes de gerar outra."
    case "PAYMENT_GATEWAY_UNAVAILABLE":
      return "O Pix está indisponível no momento. Tente novamente em instantes."
    default:
      return "Não foi possível gerar o Pix. Tente novamente."
  }
}
