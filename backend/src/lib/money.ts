/**
 * Utilidades genéricas de dinheiro — só aritmética, nenhuma regra de negócio
 * (tarifação, pré-autorização, carteira ficam em `src/core/`, que é quem
 * decide QUANTO cobrar; isto aqui só ajuda a não errar arredondamento).
 *
 * Trabalha em centavos (inteiro) internamente sempre que possível — soma e
 * subtração de `number` em reais (ponto flutuante) acumulam erro de
 * arredondamento, o clássico "R$ 0,1 + R$ 0,2 !== R$ 0,3".
 */

/** Arredonda para 2 casas decimais (mesma convenção do ParquedasFeiras). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** Reais (número) -> centavos (inteiro). */
export function toCents(reais: number): number {
  return Math.round(round2(reais) * 100)
}

/** Centavos (inteiro) -> reais (número). */
export function fromCents(cents: number): number {
  return round2(cents / 100)
}

/** Formata centavos como "R$ 1.234,56" (pt-BR). */
export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
