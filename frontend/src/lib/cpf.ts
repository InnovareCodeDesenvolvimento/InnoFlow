/**
 * CPF é um campo OPCIONAL na recarga Pix (D3 — se a Cielo exige CPF — segue
 * em aberto com o dono, ver PROGRESSO.md). Quando o motorista escolhe
 * digitar, validamos o formato no cliente (o mesmo dígito verificador que
 * qualquer formulário brasileiro usa) — não é regra de negócio do domínio
 * InnoElektron, é validação de formato de campo, como e-mail/telefone.
 */

/** Só dígitos — `""` continua `""`. */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "")
}

/** Máscara "000.000.000-00" conforme o motorista digita (aceita colar com pontuação). */
export function formatCpf(value: string): string {
  const digits = onlyDigits(value).slice(0, 11)
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)]
  let out = parts.filter(Boolean).join(".")
  if (digits.length > 9) out += `-${digits.slice(9, 11)}`
  return out
}

function checkDigit(digits: string, weightStart: number): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (weightStart - i)
  const remainder = (sum * 10) % 11
  return remainder === 10 ? 0 : remainder
}

/**
 * Dígito verificador (mod 11) + rejeita sequências de dígito único
 * ("00000000000", "11111111111"...) — passam no cálculo mas nunca são CPF
 * real. Campo vazio não é "inválido" aqui — quem chama decide se é
 * obrigatório (hoje não é).
 */
export function isValidCpf(value: string): boolean {
  const digits = onlyDigits(value)
  if (digits.length !== 11) return false
  if (/^(\d)\1{10}$/.test(digits)) return false
  const d1 = checkDigit(digits.slice(0, 9), 10)
  if (d1 !== Number(digits[9])) return false
  const d2 = checkDigit(digits.slice(0, 10), 11)
  return d2 === Number(digits[10])
}
