import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { envBoolean } from '../../src/lib/envBoolean'

describe('envBoolean — booleano de variável de ambiente', () => {
  it.each(['false', 'FALSE', 'False', '0', 'no', 'off', '  false  '])('%j vira false (z.coerce.boolean() devolvia true)', (valor) => {
    expect(envBoolean(true).parse(valor)).toBe(false)
  })

  it.each(['true', 'TRUE', '1', 'yes', 'on', '  true  '])('%j vira true', (valor) => {
    expect(envBoolean(false).parse(valor)).toBe(true)
  })

  it('ausente e vazio usam o default, nos dois sentidos', () => {
    expect(envBoolean(true).parse(undefined)).toBe(true)
    expect(envBoolean(true).parse('')).toBe(true)
    expect(envBoolean(true).parse('   ')).toBe(true)
    expect(envBoolean(false).parse(undefined)).toBe(false)
    expect(envBoolean(false).parse('')).toBe(false)
  })

  it('texto que não é booleano é RECUSADO, não adivinhado (boot falha alto)', () => {
    expect(() => envBoolean(true).parse('talvez')).toThrow()
    expect(() => envBoolean(true).parse('fasle')).toThrow() // typo clássico — não pode virar "sandbox" em silêncio
  })

  it('documenta o bug que isto corrige: z.coerce.boolean() trata "false" como true', () => {
    expect(z.coerce.boolean().parse('false')).toBe(true)
  })
})
