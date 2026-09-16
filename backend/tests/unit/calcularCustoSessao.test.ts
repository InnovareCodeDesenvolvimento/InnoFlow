import { describe, expect, it } from 'vitest'
import {
  calcularCustoSessao,
  serializeTariffSnapshot,
  type SessionMeasurements,
  type TariffSnapshot,
} from '../../src/core/tarifacao/calcularCustoSessao'

const BASE_TARIFF: TariffSnapshot = {
  id: 'tariff-test',
  model: 'PER_KWH',
  pricePerKwh: null,
  pricePerMinute: null,
  sessionFeeCents: null,
  minChargeCents: null,
  idleFeePerMinute: 0,
  idleGracePeriodSeconds: 0,
  windows: [],
}

const BASE_MEASUREMENTS: SessionMeasurements = {
  energyDeliveredWh: 0,
  startedAt: new Date('2026-01-05T10:00:00Z'), // segunda-feira
  chargingEndedAt: null,
  stoppedAt: new Date('2026-01-05T10:30:00Z'),
  timezone: 'America/Sao_Paulo',
}

describe('core/tarifacao/calcularCustoSessao — tarifa simples por kWh', () => {
  it('cobra energia * preço unitário, sem nenhum outro componente', () => {
    const resultado = calcularCustoSessao(
      { ...BASE_TARIFF, pricePerKwh: '0.80' },
      { ...BASE_MEASUREMENTS, energyDeliveredWh: 10_000 }, // 10 kWh
    )

    expect(resultado).toEqual({
      energyCostCents: 800, // 10 kWh * R$0,80 = R$8,00
      timeCostCents: 0,
      idleFeeCents: 0,
      sessionFeeCents: 0,
      minChargeAdjustmentCents: 0,
      totalCostCents: 800,
    })
  })

  it('arredonda o total só uma vez (preço com 4 casas decimais não perde precisão)', () => {
    const resultado = calcularCustoSessao(
      { ...BASE_TARIFF, pricePerKwh: '0.7912' },
      { ...BASE_MEASUREMENTS, energyDeliveredWh: 15_340 }, // 15,34 kWh (valor real de sessão)
    )

    // 15.34 * 0.7912 = 12.1370... -> R$12,14 arredondado só no final
    expect(resultado.energyCostCents).toBe(1214)
    expect(resultado.totalCostCents).toBe(1214)
  })
})

describe('core/tarifacao/calcularCustoSessao — tarifa híbrida com janela ponta/fora-ponta', () => {
  const tariffHibrida: TariffSnapshot = {
    ...BASE_TARIFF,
    model: 'HYBRID',
    pricePerKwh: '0.50', // fora-ponta (preço base)
    windows: [
      {
        label: 'PONTA',
        daysOfWeek: [1], // segunda-feira, mesmo dia do teste
        startMinute: 18 * 60, // 18:00 local
        endMinute: 21 * 60, // 21:00 local
        pricePerKwh: '1.00',
      },
    ],
  }

  it('reparte a energia proporcionalmente ao tempo em cada janela (potência constante)', () => {
    // America/Sao_Paulo = UTC-3. Sessão local: 17:30 (fora-ponta) -> 18:30
    // (ponta) — atravessa a virada das 18:00 exatamente na metade da sessão.
    const medicoes: SessionMeasurements = {
      energyDeliveredWh: 10_000, // 10 kWh, metade em cada janela (30min/30min)
      startedAt: new Date('2026-01-05T20:30:00Z'), // 17:30 em São Paulo
      chargingEndedAt: null,
      stoppedAt: new Date('2026-01-05T21:30:00Z'), // 18:30 em São Paulo
      timezone: 'America/Sao_Paulo',
    }

    const resultado = calcularCustoSessao(tariffHibrida, medicoes)

    // 5 kWh fora-ponta * R$0,50 + 5 kWh ponta * R$1,00 = R$2,50 + R$5,00 = R$7,50
    expect(resultado.energyCostCents).toBe(750)
    expect(resultado.totalCostCents).toBe(750)
  })

  it('sessão inteira dentro da janela ponta cobra 100% no preço da janela', () => {
    const medicoes: SessionMeasurements = {
      energyDeliveredWh: 10_000,
      startedAt: new Date('2026-01-05T21:00:00Z'), // 18:00 em São Paulo
      chargingEndedAt: null,
      stoppedAt: new Date('2026-01-05T22:00:00Z'), // 19:00 em São Paulo
      timezone: 'America/Sao_Paulo',
    }

    const resultado = calcularCustoSessao(tariffHibrida, medicoes)

    expect(resultado.energyCostCents).toBe(1000) // 10 kWh * R$1,00
  })
})

describe('core/tarifacao/calcularCustoSessao — idle fee (ociosidade)', () => {
  const tariffComIdle: TariffSnapshot = {
    ...BASE_TARIFF,
    idleFeePerMinute: 100, // R$1,00/min
  }

  it('desconta a carência antes de começar a cobrar', () => {
    const chargingEndedAt = new Date('2026-01-05T10:20:00Z')
    const resultado = calcularCustoSessao(
      { ...tariffComIdle, idleGracePeriodSeconds: 300 }, // 5 min de carência
      {
        ...BASE_MEASUREMENTS,
        chargingEndedAt,
        stoppedAt: new Date(chargingEndedAt.getTime() + 20 * 60_000), // 20 min plugado ocioso
      },
    )

    // 20 min ociosos - 5 min de carência = 15 min cobrados * R$1,00
    expect(resultado.idleFeeCents).toBe(1500)
    expect(resultado.totalCostCents).toBe(1500)
  })

  it('sem carência, cobra a ociosidade inteira desde o primeiro segundo', () => {
    const chargingEndedAt = new Date('2026-01-05T10:20:00Z')
    const resultado = calcularCustoSessao(
      { ...tariffComIdle, idleGracePeriodSeconds: 0 },
      {
        ...BASE_MEASUREMENTS,
        chargingEndedAt,
        stoppedAt: new Date(chargingEndedAt.getTime() + 20 * 60_000),
      },
    )

    expect(resultado.idleFeeCents).toBe(2000) // 20 min * R$1,00, sem desconto
  })

  it('carência maior ou igual à ociosidade real não cobra nada', () => {
    const chargingEndedAt = new Date('2026-01-05T10:20:00Z')
    const resultado = calcularCustoSessao(
      { ...tariffComIdle, idleGracePeriodSeconds: 600 }, // 10 min de carência
      {
        ...BASE_MEASUREMENTS,
        chargingEndedAt,
        stoppedAt: new Date(chargingEndedAt.getTime() + 5 * 60_000), // só 5 min ocioso
      },
    )

    expect(resultado.idleFeeCents).toBe(0)
  })

  it('chargingEndedAt nulo (parou de carregar só no StopTransaction) não gera idle fee', () => {
    const resultado = calcularCustoSessao(tariffComIdle, { ...BASE_MEASUREMENTS, chargingEndedAt: null })
    expect(resultado.idleFeeCents).toBe(0)
  })
})

describe('core/tarifacao/calcularCustoSessao — minChargeCents (piso de cobrança)', () => {
  const tariffComMinimo: TariffSnapshot = {
    ...BASE_TARIFF,
    pricePerKwh: '0.50',
    minChargeCents: 500, // R$5,00 mínimo por sessão
  }

  it('aplica o ajuste quando o custo calculado fica abaixo do mínimo', () => {
    const resultado = calcularCustoSessao(tariffComMinimo, { ...BASE_MEASUREMENTS, energyDeliveredWh: 200 }) // 0,2 kWh

    // 0,2 kWh * R$0,50 = R$0,10 -> abaixo do mínimo de R$5,00
    expect(resultado.energyCostCents).toBe(10)
    expect(resultado.minChargeAdjustmentCents).toBe(490)
    expect(resultado.totalCostCents).toBe(500)
  })

  it('não aplica ajuste quando o custo calculado já supera o mínimo', () => {
    const resultado = calcularCustoSessao(tariffComMinimo, { ...BASE_MEASUREMENTS, energyDeliveredWh: 20_000 }) // 20 kWh

    expect(resultado.energyCostCents).toBe(1000) // R$10,00 > R$5,00
    expect(resultado.minChargeAdjustmentCents).toBe(0)
    expect(resultado.totalCostCents).toBe(1000)
  })
})

describe('core/tarifacao/calcularCustoSessao — sessionFeeCents e composição do total', () => {
  it('soma taxa fixa de sessão aos demais componentes', () => {
    const resultado = calcularCustoSessao(
      { ...BASE_TARIFF, pricePerKwh: '0.50', sessionFeeCents: 200 },
      { ...BASE_MEASUREMENTS, energyDeliveredWh: 10_000 },
    )

    expect(resultado.energyCostCents).toBe(500)
    expect(resultado.sessionFeeCents).toBe(200)
    expect(resultado.totalCostCents).toBe(700)
  })
})

describe('core/tarifacao/calcularCustoSessao — validação defensiva', () => {
  it('lança erro se stoppedAt for anterior a startedAt', () => {
    expect(() =>
      calcularCustoSessao(BASE_TARIFF, {
        ...BASE_MEASUREMENTS,
        startedAt: new Date('2026-01-05T10:30:00Z'),
        stoppedAt: new Date('2026-01-05T10:00:00Z'),
      }),
    ).toThrow(/stoppedAt/)
  })

  it('lança erro se chargingEndedAt estiver fora do intervalo [startedAt, stoppedAt]', () => {
    expect(() =>
      calcularCustoSessao(BASE_TARIFF, {
        ...BASE_MEASUREMENTS,
        chargingEndedAt: new Date('2026-01-05T11:00:00Z'), // depois de stoppedAt
      }),
    ).toThrow(/chargingEndedAt/)
  })

  it('lança erro se energyDeliveredWh for negativo', () => {
    expect(() => calcularCustoSessao(BASE_TARIFF, { ...BASE_MEASUREMENTS, energyDeliveredWh: -1 })).toThrow(/energyDeliveredWh/)
  })

  it('sessão com duração zero e energia zero não quebra (borda de sessão falha instantânea)', () => {
    const resultado = calcularCustoSessao(
      { ...BASE_TARIFF, pricePerKwh: '0.50' },
      { ...BASE_MEASUREMENTS, startedAt: new Date('2026-01-05T10:00:00Z'), stoppedAt: new Date('2026-01-05T10:00:00Z'), energyDeliveredWh: 0 },
    )
    expect(resultado.totalCostCents).toBe(0)
  })
})

describe('core/tarifacao/serializeTariffSnapshot', () => {
  it('converte Decimal/objetos com toString() em string JSON-segura', () => {
    const decimalLike = { toString: () => '0.7912' }

    const snapshot = serializeTariffSnapshot(
      {
        id: 'tariff-1',
        model: 'PER_KWH',
        pricePerKwh: decimalLike,
        pricePerMinute: null,
        sessionFeeCents: null,
        minChargeCents: 500,
        idleFeePerMinute: 100,
        idleGracePeriodSeconds: 600,
      },
      [
        {
          label: 'PONTA',
          daysOfWeek: [1, 2, 3, 4, 5],
          startMinute: 1080,
          endMinute: 1260,
          pricePerKwh: { toString: () => '1.20' },
        },
      ],
    )

    expect(snapshot.pricePerKwh).toBe('0.7912')
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows?.[0].pricePerKwh).toBe('1.20')
    expect(snapshot.windows?.[0].pricePerMinute).toBeNull()
  })

  it('resultado é consumível direto por calcularCustoSessao', () => {
    const snapshot = serializeTariffSnapshot({
      id: 'tariff-2',
      model: 'PER_KWH',
      pricePerKwh: '0.90',
      pricePerMinute: null,
      sessionFeeCents: null,
      minChargeCents: null,
      idleFeePerMinute: 0,
      idleGracePeriodSeconds: 0,
    })

    const resultado = calcularCustoSessao(snapshot, { ...BASE_MEASUREMENTS, energyDeliveredWh: 1_000 })
    expect(resultado.energyCostCents).toBe(90)
  })
})
