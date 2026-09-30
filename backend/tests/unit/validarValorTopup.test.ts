import { describe, expect, it } from 'vitest'
import { TOPUP_MAX_AMOUNT_CENTS, TOPUP_MIN_AMOUNT_CENTS, valorTopupDentroDoLimite } from '../../src/core/pagamentos/validarValorTopup'

describe('valorTopupDentroDoLimite', () => {
  it('aceita os limites INCLUSIVE (R$ 10,00 e R$ 500,00)', () => {
    expect(valorTopupDentroDoLimite(TOPUP_MIN_AMOUNT_CENTS)).toBe(true)
    expect(valorTopupDentroDoLimite(TOPUP_MAX_AMOUNT_CENTS)).toBe(true)
  })

  it('rejeita abaixo do mínimo', () => {
    expect(valorTopupDentroDoLimite(TOPUP_MIN_AMOUNT_CENTS - 1)).toBe(false)
  })

  it('rejeita acima do máximo', () => {
    expect(valorTopupDentroDoLimite(TOPUP_MAX_AMOUNT_CENTS + 1)).toBe(false)
  })

  it('rejeita valor não inteiro (centavos fracionados não existem)', () => {
    expect(valorTopupDentroDoLimite(2_000.5)).toBe(false)
  })

  it('aceita limites customizados quando informados explicitamente', () => {
    expect(valorTopupDentroDoLimite(500, 100, 1000)).toBe(true)
    expect(valorTopupDentroDoLimite(1500, 100, 1000)).toBe(false)
  })
})
