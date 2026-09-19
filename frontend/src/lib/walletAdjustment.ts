import { formatCents } from "@/lib/utils"
import { parseReaisToCents } from "@/lib/money"

/**
 * Regras do ajuste manual de saldo (tela Admin → Carteiras). Puras e testáveis;
 * o servidor continua sendo a autoridade (teto, saldo, papel) — isto só evita
 * viagem de rede à toa e dá mensagem clara em português.
 */

/** R$ 5.000 — teto por lançamento (decisão do dono). ESPELHA `WALLET_ADJUSTMENT_MAX_CENTS` do backend (`driver.schema.ts`); a API não expõe o valor, então se mudar lá o servidor responde `VALIDATION_ERROR` e a tela mostra a mensagem genérica. */
export const WALLET_ADJUSTMENT_MAX_CENTS = 500_000
/** Descrição obrigatória (trilha de auditoria do lançamento): 5 a 500 caracteres, depois do `trim`. */
export const WALLET_DESCRIPTION_MIN = 5
export const WALLET_DESCRIPTION_MAX = 500

export type AdjustmentKind = "credit" | "debit"

export const ADJUSTMENT_KIND_LABELS: Record<AdjustmentKind, string> = { credit: "Crédito", debit: "Débito" }

export interface AdjustmentDraft {
  kind: AdjustmentKind
  /** Texto digitado em reais ("50", "50,50"). */
  amountInput: string
  description: string
}

export interface AdjustmentErrors {
  amount?: string
  description?: string
}

export interface AdjustmentValidation {
  errors: AdjustmentErrors
  /** Valor SEM sinal, em centavos inteiros — `null` enquanto o texto do valor for inválido. */
  amountCents: number | null
  /** Descrição já com `trim` (é o que o servidor grava). */
  description: string
  valid: boolean
}

/**
 * Valida o rascunho. `balanceCents` (saldo atual conhecido) só barra DÉBITO
 * maior que o saldo — pré-checagem de conveniência: o saldo pode ter mudado
 * desde que o extrato foi aberto, então o `INSUFFICIENT_BALANCE` do servidor
 * continua tratado à parte (`walletAdjustmentErrorMessage`).
 */
export function validateAdjustment(draft: AdjustmentDraft, balanceCents: number): AdjustmentValidation {
  const errors: AdjustmentErrors = {}
  const description = draft.description.trim()

  const amountCents = parseReaisToCents(draft.amountInput)
  if (draft.amountInput.trim() === "") {
    errors.amount = "Informe o valor."
  } else if (amountCents === null) {
    errors.amount = "Valor inválido. Use números, com até 2 casas decimais (ex.: 50,00)."
  } else if (amountCents === 0) {
    errors.amount = "O valor precisa ser maior que zero."
  } else if (amountCents > WALLET_ADJUSTMENT_MAX_CENTS) {
    errors.amount = `O máximo por lançamento é ${formatCents(WALLET_ADJUSTMENT_MAX_CENTS)}.`
  } else if (draft.kind === "debit" && amountCents > balanceCents) {
    errors.amount = `O débito não pode passar do saldo atual (${formatCents(balanceCents)}).`
  }

  if (description.length < WALLET_DESCRIPTION_MIN) {
    errors.description = `Descreva o motivo (mínimo de ${WALLET_DESCRIPTION_MIN} caracteres) — fica registrado na auditoria.`
  } else if (description.length > WALLET_DESCRIPTION_MAX) {
    errors.description = `A descrição passa de ${WALLET_DESCRIPTION_MAX} caracteres.`
  }

  const usable = errors.amount === undefined
  return { errors, amountCents: usable ? amountCents : null, description, valid: Object.keys(errors).length === 0 }
}

/** Crédito → positivo, débito → negativo (o contrato é assinado: `WalletAdjustmentRequest.amountCents`). */
export function toSignedCents(kind: AdjustmentKind, amountCents: number): number {
  return kind === "credit" ? amountCents : -amountCents
}

/** Saldo previsto depois do lançamento (aritmética de inteiros; é PREVISÃO — quem manda é o servidor). */
export function balanceAfter(kind: AdjustmentKind, amountCents: number, balanceCents: number): number {
  return balanceCents + toSignedCents(kind, amountCents)
}

/** "Creditar R$ 50,00 para Fulano" — a frase da confirmação (é dinheiro: precisa ser inequívoca). */
export function adjustmentSummary(kind: AdjustmentKind, amountCents: number, driverName: string): string {
  return `${kind === "credit" ? "Creditar" : "Debitar"} ${formatCents(amountCents)} ${kind === "credit" ? "para" : "de"} ${driverName}`
}

/** Códigos do `POST /api/admin/drivers/:id/wallet/entries` → mensagem em português. Por `code`, nunca pelo texto do backend. */
export function walletAdjustmentErrorMessage(code: string | undefined): string {
  switch (code) {
    case "INSUFFICIENT_BALANCE":
      return "Saldo insuficiente: o débito é maior que o saldo atual do motorista. O saldo pode ter mudado — feche e abra o extrato de novo."
    case "FORBIDDEN":
      return "Só administradores podem ajustar saldo."
    case "NOT_FOUND":
      return "Motorista não encontrado."
    case "VALIDATION_ERROR":
      return "Valor ou descrição recusados pelo servidor — confira o teto por lançamento e o tamanho da descrição."
    default:
      return "Não foi possível registrar o ajuste. Nada foi alterado — tente novamente."
  }
}
