import { apenasDigitos, isValidCpf } from '../pagamentos/validarCpf'

/**
 * Normalização da chave Pix que o titular informa para receber a devolução do saldo (L1.4, DL2). Pura.
 *
 * As cinco formas que o Banco Central define: CPF, CNPJ, celular, e-mail e chave aleatória (EVP, um UUID). Qualquer outra coisa é recusada ANTES de ser cifrada
 * e guardada — uma chave errada só apareceria na hora em que o ADMIN tentasse o Pix (tarde demais: a conta já foi anonimizada e o titular não é mais localizável).
 *
 * Devolve a forma CANÔNICA (a que o ADMIN vai colar no app do banco): CPF/CNPJ só dígitos, celular `+55DDDNNNNNNNNN`, e-mail em minúsculas, EVP em minúsculas.
 * O valor NUNCA vai para log (este módulo não loga; quem o chama também não).
 */

const TAMANHO_MAXIMO_CHAVE_PIX = 77 // limite do BCB para a chave (e-mail é o que mais se aproxima)

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const EVP = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function cnpjValido(digitos: string): boolean {
  if (!/^\d{14}$/.test(digitos) || /^(\d)\1{13}$/.test(digitos)) return false
  const dv = (base: string, pesos: number[]): number => {
    const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * pesos[i]!, 0)
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  const d1 = dv(digitos.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  if (d1 !== Number(digitos[12])) return false
  const d2 = dv(digitos.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return d2 === Number(digitos[13])
}

export function validarCnpj(digitos: string): boolean {
  return cnpjValido(digitos)
}

/** `null` = não é uma chave Pix reconhecível. */
export function normalizarChavePix(bruta: string): string | null {
  const texto = bruta.trim()
  if (texto.length === 0 || texto.length > TAMANHO_MAXIMO_CHAVE_PIX) return null

  if (texto.includes('@')) return EMAIL.test(texto) ? texto.toLowerCase() : null
  if (EVP.test(texto)) return texto.toLowerCase()

  // Só dígitos e a pontuação usual de CPF/CNPJ/telefone; qualquer outro caractere (letra, controle, emoji) é recusado.
  if (!/^[\d\s().+\-/]+$/.test(texto)) return null
  const digitos = apenasDigitos(texto)

  if (digitos.length === 14) return cnpjValido(digitos) ? digitos : null
  if (digitos.length === 11 && !texto.startsWith('+') && isValidCpf(digitos)) return digitos

  // Celular: com +55 (13 dígitos: 55 + DDD + 9 dígitos) ou sem (11: DDD + 9 + 8 dígitos). O 9 inicial do número é obrigatório em celular.
  const semPais = digitos.length === 13 && digitos.startsWith('55') ? digitos.slice(2) : digitos.length === 11 ? digitos : null
  if (semPais && /^[1-9]{2}9\d{8}$/.test(semPais)) return `+55${semPais}`
  return null
}
