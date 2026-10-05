import { isValidCpf, onlyDigits } from "@/lib/cpf"

/**
 * Chave Pix para a devolução do saldo na exclusão da conta (L1.4). Validação de FORMATO no cliente, espelhando `backend/src/core/lgpd/chavePix.ts` (que é a fonte da verdade e
 * valida de novo): uma chave errada só apareceria na hora em que o ADMIN tentasse o Pix, tarde demais (a conta já foi anonimizada e a pessoa não é mais localizável) - por isso
 * o cliente barra o erro de digitação antes. As cinco formas do Banco Central: CPF, CNPJ, celular, e-mail e chave aleatória (UUID).
 *
 * Lógica PURA (sem DOM/rede). O valor NUNCA vai para log.
 */

export type PixKeyKind = "CPF" | "CNPJ" | "PHONE" | "EMAIL" | "RANDOM"

export const PIX_KEY_MAX_LENGTH = 77 // limite do BCB para a chave (o e-mail é o que mais se aproxima)

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const EVP = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function isValidCnpj(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false
  const check = (base: string, weights: number[]): number => {
    const sum = base.split("").reduce((acc, d, i) => acc + Number(d) * weights[i]!, 0)
    const rest = sum % 11
    return rest < 2 ? 0 : 11 - rest
  }
  const d1 = check(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  if (d1 !== Number(digits[12])) return false
  return check(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[13])
}

export interface PixKeyParse {
  kind: PixKeyKind
  /** Forma canônica: CPF/CNPJ só dígitos, celular `+55DDDNNNNNNNNN`, e-mail e chave aleatória em minúsculas. É o que a tela mostra de volta para conferência. */
  normalized: string
}

/** `null` = não é uma chave Pix reconhecível. */
export function parsePixKey(raw: string): PixKeyParse | null {
  const text = raw.trim()
  if (text.length === 0 || text.length > PIX_KEY_MAX_LENGTH) return null

  if (text.includes("@")) return EMAIL.test(text) ? { kind: "EMAIL", normalized: text.toLowerCase() } : null
  if (EVP.test(text)) return { kind: "RANDOM", normalized: text.toLowerCase() }

  // Só dígitos e a pontuação usual de CPF/CNPJ/telefone; qualquer outro caractere (letra, controle, emoji) é recusado.
  if (!/^[\d\s().+\-/]+$/.test(text)) return null
  const digits = onlyDigits(text)

  if (digits.length === 14) return isValidCnpj(digits) ? { kind: "CNPJ", normalized: digits } : null
  if (digits.length === 11 && !text.startsWith("+") && isValidCpf(digits)) return { kind: "CPF", normalized: digits }

  // Celular: com +55 (13 dígitos: 55 + DDD + 9 dígitos) ou sem (11: DDD + 9 + 8 dígitos). O 9 inicial do número é obrigatório em celular.
  const national = digits.length === 13 && digits.startsWith("55") ? digits.slice(2) : digits.length === 11 ? digits : null
  if (national && /^[1-9]{2}9\d{8}$/.test(national)) return { kind: "PHONE", normalized: `+55${national}` }
  return null
}

const KIND_LABEL: Record<PixKeyKind, string> = {
  CPF: "CPF",
  CNPJ: "CNPJ",
  PHONE: "celular",
  EMAIL: "e-mail",
  RANDOM: "chave aleatória",
}

export function pixKeyKindLabel(kind: PixKeyKind): string {
  return KIND_LABEL[kind]
}

/** Forma legível da chave para conferência ("CPF 529.982.247-25", "celular +55 11 91234-5678"). */
export function formatPixKeyForDisplay(parsed: PixKeyParse): string {
  const { kind, normalized } = parsed
  const label = KIND_LABEL[kind]
  if (kind === "CPF") return `${label} ${normalized.slice(0, 3)}.${normalized.slice(3, 6)}.${normalized.slice(6, 9)}-${normalized.slice(9)}`
  if (kind === "CNPJ") return `${label} ${normalized.slice(0, 2)}.${normalized.slice(2, 5)}.${normalized.slice(5, 8)}/${normalized.slice(8, 12)}-${normalized.slice(12)}`
  if (kind === "PHONE") return `${label} +55 ${normalized.slice(3, 5)} ${normalized.slice(5, 10)}-${normalized.slice(10)}`
  return `${label} ${normalized}`
}

export const PIX_KEY_REQUIRED_MESSAGE = "Informe a chave Pix para receber a devolução do saldo."
export const PIX_KEY_INVALID_MESSAGE = "Chave Pix inválida. Use um CPF, CNPJ, celular, e-mail ou chave aleatória válidos."

/** Mensagem de erro do campo, ou `null` se a chave é válida. */
export function pixKeyError(raw: string): string | null {
  if (raw.trim() === "") return PIX_KEY_REQUIRED_MESSAGE
  return parsePixKey(raw) ? null : PIX_KEY_INVALID_MESSAGE
}
