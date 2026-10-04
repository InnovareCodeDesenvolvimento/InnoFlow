/**
 * `SoftDescriptor` (texto na fatura do cartão), F21/C2.4: a Cielo aceita até 13 caracteres e SÓ `A-Z0-9`; um caractere especial (acento, espaço,
 * hífen, ponto...) faz a Cielo recusar a transação INTEIRA — o motorista fica sem recarga por causa de um enfeite. Higieniza: remove acentos
 * (`Elétron` -> `ELETRON`), maiúsculas, descarta o que não é A-Z/0-9 e corta em 13. Vazio depois disso -> `null` (o campo simplesmente não vai).
 */
export const SOFT_DESCRIPTOR_MAX = 13

/** Marcas combinantes U+0300–U+036F (o que sobra de `é` depois do NFD). Montada por código para o fonte não depender de escape. */
const MARCAS_DE_ACENTO = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g')

export function higienizarSoftDescriptor(bruto: string | null | undefined): string | null {
  if (!bruto) return null
  const limpo = bruto
    .normalize('NFD')
    .replace(MARCAS_DE_ACENTO, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, SOFT_DESCRIPTOR_MAX)
  return limpo === '' ? null : limpo
}
