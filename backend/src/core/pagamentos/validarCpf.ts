/**
 * Validação de CPF (dígito verificador mod 11) — mesmo algoritmo do
 * frontend (`frontend/src/lib/cpf.ts`), portado para o backend porque a API
 * NUNCA pode confiar só na validação do cliente (regra dura de toda entrada
 * externa). CPF é OPCIONAL na recarga Pix (D3 em aberto com o dono, ver
 * PROGRESSO.md) — quem chama decide se é obrigatório; aqui só valida FORMATO
 * quando um valor É informado.
 */

/** Só dígitos — mesmo helper do frontend. */
export function apenasDigitos(value: string): string {
  return value.replace(/\D/g, '')
}

function digitoVerificador(digits: string, weightStart: number): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (weightStart - i)
  const remainder = (sum * 10) % 11
  return remainder === 10 ? 0 : remainder
}

/**
 * Espera 11 dígitos JÁ limpos (sem pontuação) — quem chama normaliza com
 * `apenasDigitos` antes. Rejeita sequências de dígito único
 * ("00000000000"...) — passam no cálculo do dígito verificador mas nunca são
 * CPF real.
 */
export function isValidCpf(digits: string): boolean {
  if (digits.length !== 11 || !/^\d{11}$/.test(digits)) return false
  if (/^(\d)\1{10}$/.test(digits)) return false
  const d1 = digitoVerificador(digits.slice(0, 9), 10)
  if (d1 !== Number(digits[9])) return false
  const d2 = digitoVerificador(digits.slice(0, 10), 11)
  return d2 === Number(digits[10])
}
