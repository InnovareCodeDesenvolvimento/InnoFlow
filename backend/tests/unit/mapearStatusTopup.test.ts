import { describe, expect, it } from 'vitest'
import { mapearStatusTopup } from '../../src/core/pagamentos/mapearStatusTopup'

describe('mapearStatusTopup', () => {
  it.each([
    ['PENDING', 'PENDING'],
    ['PAID', 'PAID'],
    ['EXPIRED', 'EXPIRED'],
  ] as const)('%s -> %s', (input, expected) => {
    expect(mapearStatusTopup(input)).toBe(expected)
  })

  it('CREATED (transiente/nunca deveria vazar) cai em FAILED — fail-safe, nunca fica "pendente" para sempre', () => {
    expect(mapearStatusTopup('CREATED')).toBe('FAILED')
  })

  it('qualquer valor do enum de CARTÃO (vocabulário errado para Pix) também cai em FAILED', () => {
    expect(mapearStatusTopup('CAPTURED')).toBe('FAILED')
    expect(mapearStatusTopup('VOIDED')).toBe('FAILED')
    expect(mapearStatusTopup('DENIED')).toBe('FAILED')
  })

  it('valor totalmente desconhecido cai em FAILED', () => {
    expect(mapearStatusTopup('ALGO_NUNCA_VISTO')).toBe('FAILED')
  })
})
