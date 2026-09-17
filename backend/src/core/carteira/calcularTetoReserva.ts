/**
 * Teto de custo estimado de uma sessão de recarga — usado só como
 * INFORMAÇÃO para a guarda ao vivo do `MeterValues` (ver `meterValues.ts`) e
 * para o campo `estimatedMaxCostCents` de `POST .../commands/remote-start`.
 *
 * IMPORTANTE: isto NUNCA é reservado/debitado antecipadamente da carteira —
 * a identidade de conciliação já em produção (`paymentsService.ts`:
 * `revenue === cardCaptured + walletDebit + openDebt`) proíbe reserva
 * antecipada por débito (ver decisão da Nova, PROGRESSO.md §F4 desenhada).
 * É só um número de referência para decidir QUANDO auto-parar a sessão.
 *
 * Função pura (sem I/O, sem Prisma/express/ws — respeita a fronteira de
 * `src/core/**` da Nova, reforçada em `eslint.config.mjs`).
 */

export interface TetoReservaTariff {
  /** Reais por kWh, string decimal (mesmo formato do `TariffSnapshot`) ou number. `null`/ausente = tarifa sem componente de energia. */
  pricePerKwh?: string | number | null
  /** Reais por minuto, string decimal ou number. */
  pricePerMinute?: string | number | null
  /** Centavos inteiros — cobrança fixa por sessão. */
  sessionFeeCents?: number | null
}

export interface TetoReservaConnector {
  /** kW nominal do conector — Decimal do Prisma serializa como string. `null`/ausente = sem informação de potência. */
  maxPowerKw?: string | number | null
}

export interface TetoReservaConfig {
  pisoCents: number
  tetoCents: number
}

/** Defaults documentados no schema/decisão do dono — o valor REAL de produção vem de `env.RESERVA_PISO_CENTS`/`env.RESERVA_TETO_CENTS`, passado explicitamente pelo chamador (núcleo puro não lê `env`). */
export const RESERVA_PISO_CENTS_DEFAULT = 5000
export const RESERVA_TETO_CENTS_DEFAULT = 40000

/** Duração de referência para uma "sessão longa típica" — mesma premissa usada pelo teto de pré-autorização de cartão (decisão do dono, 2026-09-17). */
const SESSAO_LONGA_HORAS = 1.5
const SESSAO_LONGA_MINUTOS = SESSAO_LONGA_HORAS * 60 // 90
const MARGEM = 1.15

function parseDecimal(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toCentsRounded(reais: number): number {
  return Math.round(reais * 100)
}

function clamp(cents: number, config: TetoReservaConfig): number {
  return Math.min(config.tetoCents, Math.max(config.pisoCents, Math.ceil(cents)))
}

/**
 * `teto = ceil(maxPowerKw × 1.5h × precoPorKwh × 1.15)`, clampado entre
 * `config.pisoCents` e `config.tetoCents`.
 *
 * Se a tarifa não tiver `pricePerKwh` (ou o conector não tiver
 * `maxPowerKw` cadastrado) — típico de tarifa `PER_MINUTE`/`PER_SESSION` —
 * cai para `base = pricePerMinute × 90min + sessionFeeCents`. Se nada disso
 * existir (tarifa sem nenhum preço configurado), cai no piso (o `clamp`
 * cuida disso sozinho: `ceil(0)` fica abaixo do piso).
 */
export function calcularTetoReserva(
  tariff: TetoReservaTariff,
  connector: TetoReservaConnector,
  config: TetoReservaConfig = { pisoCents: RESERVA_PISO_CENTS_DEFAULT, tetoCents: RESERVA_TETO_CENTS_DEFAULT },
): number {
  const pricePerKwh = parseDecimal(tariff.pricePerKwh)
  const maxPowerKw = parseDecimal(connector.maxPowerKw)

  if (pricePerKwh !== null && maxPowerKw !== null) {
    const energiaEstimadaKwh = maxPowerKw * SESSAO_LONGA_HORAS
    const baseReais = energiaEstimadaKwh * pricePerKwh * MARGEM
    return clamp(toCentsRounded(baseReais), config)
  }

  const pricePerMinute = parseDecimal(tariff.pricePerMinute)
  if (pricePerMinute !== null) {
    const baseCents = toCentsRounded(pricePerMinute * SESSAO_LONGA_MINUTOS) + (tariff.sessionFeeCents ?? 0)
    return clamp(baseCents, config)
  }

  // Nada configurado (nem kWh nem minuto) — clamp(0) sempre resulta no piso.
  return clamp(0, config)
}
