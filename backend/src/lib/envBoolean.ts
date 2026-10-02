import { z } from 'zod'

/**
 * Booleano de variável de ambiente — módulo PRÓPRIO, sem importar `env.ts`
 * (que valida TODAS as envs de forma eager e exigiria `DATABASE_URL` etc.
 * só para testar um parser), mesmo motivo de `logRedactPaths.ts`.
 *
 * Por que isto existe: `z.coerce.boolean()` faz `Boolean(valor)`, e qualquer
 * string não vazia é truthy — `"false"`, `"0"` e `"FALSE"` viravam `true`.
 * Achado do Atlas (02/10/2026) em `CIELO_SANDBOX`: no go-live, trocar a env
 * para `false` manteria `environment: 'sandbox'` na sessão de tokenização do
 * cartão (`cieloAdapter.ts`), e um cartão tokenizado no sandbox não cobra em
 * produção.
 *
 * Regras: vazio/ausente => `defaultValue`; `true/1/yes/on` e `false/0/no/off`
 * (sem diferenciar maiúsculas) => o boolean correspondente; qualquer outro
 * texto NÃO é adivinhado — passa adiante e o `z.boolean()` recusa, então o
 * boot falha alto em vez de assumir sandbox/produção por engano.
 */
export function envBoolean(defaultValue: boolean) {
  return z.preprocess((valor) => {
    if (typeof valor !== 'string') return valor
    const texto = valor.trim().toLowerCase()
    if (texto === '') return undefined
    if (['true', '1', 'yes', 'on'].includes(texto)) return true
    if (['false', '0', 'no', 'off'].includes(texto)) return false
    return valor
  }, z.boolean().default(defaultValue))
}
