/**
 * Dinheiro sem float. Tudo que vira centavos aqui é manipulado como STRING
 * de dígitos e inteiros — nunca `0.1 + 0.2`, nunca `Math.round(50.005 * 100)`
 * (que dá 5000 ou 5001 conforme o binário do dia). É a diferença entre "R$ 50,00"
 * e um lançamento de R$ 49,99 na carteira de alguém.
 */

/** Limite de dígitos da parte inteira: mantém `inteiro * 100` dentro de `Number.MAX_SAFE_INTEGER`. */
const MAX_INTEGER_DIGITS = 12

/**
 * Texto digitado em REAIS → centavos INTEIROS, ou `null` se não for um valor
 * válido. Aceita o jeito brasileiro ("50", "50,5", "50,50", "1.250,00",
 * "R$ 50,00") e o ponto decimal de quem cola de planilha ("50.5", "50.50").
 *
 * Regras (a ambiguidade do ponto é resolvida pelo formato, não por chute):
 * - com vírgula: a vírgula é o decimal; pontos só podem ser milhar ("1.250,00");
 * - só com ponto: grupos de exatamente 3 dígitos = milhar ("1.250" → R$ 1.250,00);
 *   1–2 dígitos depois do ponto = decimal ("50.5" → R$ 50,50);
 * - no máximo 2 casas decimais (centavo é a menor unidade — não arredonda em silêncio);
 * - sem sinal (crédito/débito é escolhido à parte) e sem notação científica.
 */
export function parseReaisToCents(input: string): number | null {
  // Só espaços das PONTAS (e depois do "R$"). Espaço no meio é rejeitado: "50 00" virar 5000 seria erro de 100x.
  const raw = input.trim().replace(/^R\$\s*/i, "")
  if (raw === "" || /\s/.test(raw)) return null

  let intDigits: string
  let decDigits = ""

  if (raw.includes(",")) {
    const parts = raw.split(",")
    if (parts.length !== 2) return null
    const [intPart, decPart] = parts
    if (!/^\d+$/.test(intPart) && !/^\d{1,3}(\.\d{3})+$/.test(intPart)) return null
    if (decPart === "") return null // "50," é digitação pela metade, não "50,00"
    intDigits = intPart.replace(/\./g, "")
    decDigits = decPart
  } else if (raw.includes(".")) {
    if (/^\d{1,3}(\.\d{3})+$/.test(raw)) {
      intDigits = raw.replace(/\./g, "")
    } else {
      const match = raw.match(/^(\d+)\.(\d{1,2})$/)
      if (!match) return null
      intDigits = match[1]
      decDigits = match[2]
    }
  } else {
    if (!/^\d+$/.test(raw)) return null
    intDigits = raw
  }

  if (!/^\d{0,2}$/.test(decDigits)) return null
  if (intDigits.length > MAX_INTEGER_DIGITS) return null

  return Number(intDigits) * 100 + Number(decDigits.padEnd(2, "0"))
}
