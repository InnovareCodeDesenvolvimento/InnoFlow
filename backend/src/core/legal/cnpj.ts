/**
 * CNPJ numérico e ALFANUMÉRICO (vigente desde julho/2026) — regras PURAS.
 * Formato: 12 caracteres (dígitos ou letras A-Z) + 2 dígitos verificadores. O cálculo é o mesmo módulo 11 de sempre, só que o valor de cada caractere é `código ASCII - 48`
 * (dígitos valem 0-9, 'A' vale 17...). Para um CNPJ só de dígitos o resultado é idêntico ao algoritmo antigo — por isso um único validador serve aos dois.
 * "Normalizado" = os 14 caracteres em MAIÚSCULAS, sem pontuação (é o que se guarda no banco).
 */

const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]

/** Tira a pontuação usual (`.`, `/`, `-`, espaço) e põe em maiúsculas. Qualquer outro caractere é mantido para a validação recusar. */
export function normalizarCnpj(bruto: string): string {
  return bruto.replace(/[.\-/\s]/g, '').toUpperCase()
}

function digitoVerificador(base: string, pesos: readonly number[]): number {
  let soma = 0
  for (let i = 0; i < pesos.length; i += 1) soma += (base.charCodeAt(i) - 48) * (pesos[i] as number)
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

/** `true` só para 14 caracteres NORMALIZADOS (12 alfanuméricos + 2 dígitos), não repetidos e com os dois dígitos verificadores corretos. */
export function cnpjNormalizadoValido(normalizado: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(normalizado)) return false
  if (/^(.)\1{13}$/.test(normalizado)) return false // 00000000000000, AAAAAAAAAAAAAA...
  const dv1 = digitoVerificador(normalizado, PESOS_DV1)
  const dv2 = digitoVerificador(normalizado.slice(0, 12) + String(dv1), PESOS_DV2)
  return normalizado.endsWith(`${dv1}${dv2}`)
}

/** Normaliza e valida; `null` = inválido. */
export function validarENormalizarCnpj(bruto: string): string | null {
  const n = normalizarCnpj(bruto)
  return cnpjNormalizadoValido(n) ? n : null
}

/** `12.345.678/0001-95` (a máscara é a mesma para o numérico e o alfanumérico). Entrada: CNPJ normalizado. */
export function formatarCnpjNormalizado(n: string): string {
  return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`
}
