import { describe, expect, it } from 'vitest'
import { fromCents, formatBRL, round2, toCents } from '../../src/lib/money'

describe('lib/money', () => {
  it('round2 corrige erro de ponto flutuante', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })

  it('toCents converte reais em centavos inteiros', () => {
    expect(toCents(10.5)).toBe(1050)
    expect(toCents(0.1)).toBe(10)
  })

  it('fromCents converte centavos em reais', () => {
    expect(fromCents(1050)).toBe(10.5)
  })

  it('toCents/fromCents são inversas', () => {
    expect(fromCents(toCents(123.45))).toBe(123.45)
  })

  it('formatBRL formata em pt-BR', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56')
  })
})
