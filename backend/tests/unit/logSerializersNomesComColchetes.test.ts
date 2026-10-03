import { describe, expect, it } from 'vitest'
import { CAMPOS_SENSIVEIS, varrerSensivel } from '../../src/lib/logSerializers'
import { REDACT_PATHS } from '../../src/lib/logRedactPaths'

/**
 * Íris (02/10/2026) — todo path de `REDACT_PATHS` tem que virar um nome de campo em `CAMPOS_SENSIVEIS` (a varredura em profundidade do `err` usa essa
 * lista, e o `fast-redact` não alcança 2+ níveis).
 */
describe('CAMPOS_SENSIVEIS cobre todos os paths de REDACT_PATHS', () => {
  it('campos simples (`*.CardNumber`, `req.headers.authorization`) entram, em minúsculas', () => {
    for (const nome of ['cardnumber', 'authorization', 'cookie', 'merchantkey', 'securitycode', 'cardtoken', 'holder', 'identity']) expect(CAMPOS_SENSIVEIS.has(nome), nome).toBe(true)
  })

  it('varrerSensivel redige campo sensível a 3 níveis, sem distinguir maiúsculas', () => {
    const saida = varrerSensivel({ a: { b: { MERCHANTKEY: 'x', cardNumber: 'y', ok: 1 } } })
    expect(saida).toEqual({ a: { b: { MERCHANTKEY: '[redacted]', cardNumber: '[redacted]', ok: 1 } } })
  })

  // BUG: ver `logRealErroSerializadoProcessoFilho.test.ts` (impacto na saída real). Aqui, a causa: o nome extraído de `res.headers["set-cookie"]` é `headers["set-cookie`.
  it('(BUG corrigido — F5.8) os paths com colchetes (`set-cookie`, `x-innoelektron-webhook-secret`) viram o nome do header em CAMPOS_SENSIVEIS', () => {
    const comColchetes = REDACT_PATHS.filter((p) => p.includes('["'))
    expect(comColchetes.length).toBeGreaterThan(0) // se a lista mudar e não houver mais colchetes, este teste deve ser revisto
    expect(CAMPOS_SENSIVEIS.has('set-cookie')).toBe(true)
    expect(CAMPOS_SENSIVEIS.has('x-innoelektron-webhook-secret')).toBe(true)
  })
})
