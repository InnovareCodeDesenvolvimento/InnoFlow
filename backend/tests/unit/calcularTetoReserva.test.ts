import { describe, expect, it } from 'vitest'
import { calcularTetoReserva, RESERVA_PISO_CENTS_DEFAULT, RESERVA_TETO_CENTS_DEFAULT } from '../../src/core/carteira/calcularTetoReserva'

describe('calcularTetoReserva', () => {
  it('tarifa PER_KWH com maxPowerKw: teto = ceil(maxPowerKw × 1.5h × pricePerKwh × 1.15), clampado', () => {
    // 50kW × 1.5h × R$0,80/kWh × 1.15 = R$69,00 -> 6900 centavos, dentro do range [5000, 40000].
    const result = calcularTetoReserva({ pricePerKwh: '0.80' }, { maxPowerKw: '50' })
    expect(result).toBe(6900)
  })

  it('clampa no teto absoluto quando o cálculo passa de RESERVA_TETO_CENTS (conector muito potente)', () => {
    // 150kW × 1.5h × R$1,50/kWh × 1.15 = R$388,13 -> 38813 centavos, ainda dentro do teto de 40000.
    const dentroDoTeto = calcularTetoReserva({ pricePerKwh: '1.50' }, { maxPowerKw: '150' })
    expect(dentroDoTeto).toBeLessThanOrEqual(RESERVA_TETO_CENTS_DEFAULT)

    // 350kW × 1.5h × R$2,00/kWh × 1.15 = R$1.207,50 -> estoura o teto, clampa em 40000.
    const estouraTeto = calcularTetoReserva({ pricePerKwh: '2.00' }, { maxPowerKw: '350' })
    expect(estouraTeto).toBe(RESERVA_TETO_CENTS_DEFAULT)
  })

  it('sem pricePerKwh (tarifa PER_MINUTE/PER_SESSION): cai para pricePerMinute × 90min + sessionFeeCents', () => {
    // R$0,50/min × 90min = R$45,00 = 4500 centavos + sessionFeeCents 200 = 4700 -> clampa no piso (5000).
    const abaixoDoPiso = calcularTetoReserva({ pricePerMinute: '0.50', sessionFeeCents: 200 }, {})
    expect(abaixoDoPiso).toBe(RESERVA_PISO_CENTS_DEFAULT)

    // R$1,00/min × 90min = R$90,00 = 9000 centavos + sessionFeeCents 500 = 9500 -> acima do piso, sem clamp.
    const acimaDoPiso = calcularTetoReserva({ pricePerMinute: '1.00', sessionFeeCents: 500 }, {})
    expect(acimaDoPiso).toBe(9500)
  })

  it('tarifa sem nenhum preço configurado (nem kWh, nem minuto): cai no piso', () => {
    const result = calcularTetoReserva({}, {})
    expect(result).toBe(RESERVA_PISO_CENTS_DEFAULT)
  })

  it('pricePerKwh presente mas connector sem maxPowerKw: cai para o fallback de pricePerMinute (ou piso se também ausente)', () => {
    const comFallbackMinuto = calcularTetoReserva({ pricePerKwh: '0.80', pricePerMinute: '0.60' }, {})
    // R$0,60/min × 90min = R$54,00 = 5400 centavos.
    expect(comFallbackMinuto).toBe(5400)

    const semNadaUsavel = calcularTetoReserva({ pricePerKwh: '0.80' }, {})
    expect(semNadaUsavel).toBe(RESERVA_PISO_CENTS_DEFAULT)
  })

  it('respeita config customizada de piso/teto quando passada explicitamente', () => {
    const result = calcularTetoReserva({ pricePerKwh: '0.80' }, { maxPowerKw: '50' }, { pisoCents: 100, tetoCents: 1000 })
    expect(result).toBe(1000) // 6900 estouraria o teto customizado de 1000
  })
})
