/**
 * Cálculo de custo de uma sessão de recarga — CÓDIGO DE PRODUÇÃO.
 *
 * Função pura (sem I/O, sem Prisma, sem express/ws — respeita a fronteira de
 * `src/core/**` da Nova). Duas chamadoras usam exatamente esta função:
 *
 *   1. O gerador de dado sintético (`prisma/seed-demo.ts`, Cronos) — para
 *      que o faturamento "de mentira" nasça com a MESMA regra de preço que
 *      valerá em produção.
 *   2. O handler `StopTransaction` real (Vega, Fase 4) — vai chamar
 *      `calcularCustoSessao(tariffSnapshot, medições)` para preencher
 *      `ChargingSession.energyCostCents/timeCostCents/idleFeeCents/
 *      sessionFeeCents/minChargeAdjustmentCents/totalCostCents`.
 *
 * Se essas duas chamadoras calculassem preço cada uma a seu modo, o negócio
 * teria dois faturamentos divergentes no dia em que a Fase 4 entrasse no ar
 * — é exatamente essa dívida que este arquivo existe para evitar (ver
 * `.claude/agent-memory/nova/decisoes-retaguarda-relatorios.md`).
 *
 * ------------------------------------------------------------------------
 * Convenções de dinheiro (mandato do Cronos, ver schema-innoelektron.md):
 * ------------------------------------------------------------------------
 * - Preço UNITÁRIO (pricePerKwh, pricePerMinute) chega como STRING decimal
 *   (é como `Tariff.pricePerKwh: Decimal(12,4)` serializa em JSON — nunca
 *   confiar em `number` de ponto flutuante para o preço unitário em si).
 * - Todo custo fracionário (energia, tempo, ociosidade) é acumulado em
 *   REAIS/CENTAVOS-FRACIONÁRIOS sem nenhum arredondamento intermediário —
 *   arredondamos para centavos inteiros só UMA VEZ, no fechamento de cada
 *   componente monetário. `totalCostCents` é a SOMA dos componentes já
 *   inteiros — nunca recalculado/re-arredondado a partir do zero, para não
 *   correr o risco de a soma dos componentes divergir do total exibido.
 *
 * ------------------------------------------------------------------------
 * Janela ponta/fora-ponta (TariffWindow) — como a energia e o tempo são
 * repartidos entre janelas:
 * ------------------------------------------------------------------------
 * Não temos leitura de potência instantânea aqui (essa função nunca lê
 * `MeterSample` — mesma regra do relatório, ver decisoes-retaguarda-
 * relatorios.md). A única leitura de energia disponível é o total da sessão
 * (`energyDeliveredWh`). Por isso, quando a sessão atravessa mais de uma
 * janela tarifária, a energia é repartida PROPORCIONALMENTE AO TEMPO gasto
 * em cada janela (assume potência constante durante a sessão) — é a melhor
 * aproximação possível sem granularidade de medição, documentada aqui como
 * premissa explícita, não escondida.
 *
 * A conversão de instante UTC para dia-da-semana/minuto-do-dia LOCAL do site
 * assume que o fuso tem OFFSET FIXO o ano inteiro — verdade para todos os
 * fusos brasileiros usados neste domínio (America/Sao_Paulo, America/Cuiaba,
 * ...), já que o Brasil aboliu horário de verão em 2019. Isso permite achar
 * o offset uma vez (via Intl) e reaproveitar em toda a sessão, sem lidar com
 * transição de DST — se o produto um dia operar em fuso com DST, esta conta
 * precisa mudar.
 *
 * Janelas sobrepostas no cadastro da tarifa (bug de configuração do
 * operador, não impedido por constraint no banco) fazem a soma dos minutos
 * "combinados" passar do total da sessão — o excedente é simplesmente
 * descartado (baseMs nunca fica negativo). Não é responsabilidade desta
 * função validar consistência de cadastro de `TariffWindow`.
 */

// ------------------------------------------------------------------------
// Tipos — formato JSON-seguro (é exatamente o que fica congelado em
// `ChargingSession.tariffSnapshot`, coluna Json do Postgres).
// ------------------------------------------------------------------------

export interface TariffWindowSnapshot {
  label: string
  /** 0 = domingo .. 6 = sábado (mesma convenção de `Date#getDay()`). */
  daysOfWeek: number[]
  /** Minutos desde 00:00 local do site, inclusive. */
  startMinute: number
  /** Minutos desde 00:00 local do site, exclusivo. */
  endMinute: number
  /** Override de preço — `null`/ausente usa o preço base do Tariff. */
  pricePerKwh?: string | null
  pricePerMinute?: string | null
  /** Override de idle fee — centavos inteiros, `null`/ausente usa o base. */
  idleFeePerMinute?: number | null
}

export type TariffModelSnapshot = 'PER_KWH' | 'PER_MINUTE' | 'PER_SESSION' | 'HYBRID'

export interface TariffSnapshot {
  id: string
  model: TariffModelSnapshot
  /** Reais por kWh, string decimal (ex.: "0.7912"). */
  pricePerKwh?: string | null
  /** Reais por minuto, string decimal. */
  pricePerMinute?: string | null
  /** Centavos inteiros, cobrança fixa por sessão. */
  sessionFeeCents?: number | null
  /** Centavos inteiros — piso de cobrança da sessão. */
  minChargeCents?: number | null
  /** Centavos inteiros por minuto de ociosidade (base, sem override de janela). */
  idleFeePerMinute: number
  /** Carência antes de começar a cobrar ociosidade. */
  idleGracePeriodSeconds: number
  /** Vazio/ausente = tarifa sem ponta/fora-ponta — todo o custo usa o preço base. */
  windows?: TariffWindowSnapshot[]
}

export interface SessionMeasurements {
  /** = meterStopWh - meterStartWh, já calculado pelo chamador. Nunca negativo. */
  energyDeliveredWh: number
  /** Timestamp do StartTransaction. */
  startedAt: Date
  /**
   * Quando o carro parou de puxar energia de fato (Finishing/SuspendedEV ou
   * potência zerada), com a transação OCPP ainda aberta — início da janela
   * de ociosidade. `null` quando a sessão foi encerrada sem fase de
   * ociosidade detectada (StopTransaction chegou com o carro ainda
   * carregando) — nesse caso não há cobrança de idle fee.
   */
  chargingEndedAt: Date | null
  /** Timestamp do StopTransaction. */
  stoppedAt: Date
  /** IANA timezone do `Site` da sessão (`Site.timezone`) — para resolver TariffWindow. */
  timezone: string
}

export interface CustoSessaoResultado {
  energyCostCents: number
  timeCostCents: number
  idleFeeCents: number
  sessionFeeCents: number
  minChargeAdjustmentCents: number
  totalCostCents: number
}

// ------------------------------------------------------------------------
// Fuso horário — offset fixo (sem DST), ver premissa no cabeçalho.
// ------------------------------------------------------------------------

function getFixedUtcOffsetMinutes(timezone: string): number {
  // Data de referência neutra — o offset é o mesmo o ano inteiro para os
  // fusos deste domínio, então a data em si não importa.
  const referenceMs = Date.UTC(2026, 0, 15, 12, 0, 0)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(referenceMs))

  const get = (type: string): number => {
    const value = parts.find((p) => p.type === type)?.value
    if (value === undefined) {
      throw new Error(`Intl.DateTimeFormat não retornou o campo "${type}" para o timezone "${timezone}"`)
    }
    return Number(value)
  }

  // Interpreta os números do relógio LOCAL como se fossem UTC — a distância
  // até o instante de referência (que É UTC) é o offset do fuso.
  const localReadAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((localReadAsUtcMs - referenceMs) / 60_000)
}

// ------------------------------------------------------------------------
// Repartição de um intervalo [start, end) entre janelas tarifárias
// ------------------------------------------------------------------------

interface WindowAllocation {
  /** `null` = fora de qualquer TariffWindow cadastrada, usa preço base. */
  window: TariffWindowSnapshot | null
  ms: number
}

function allocateByWindow(start: Date, end: Date, windows: TariffWindowSnapshot[], offsetMinutes: number): WindowAllocation[] {
  const totalMs = end.getTime() - start.getTime()
  if (totalMs <= 0) return []
  if (windows.length === 0) return [{ window: null, ms: totalMs }]

  const startMs = start.getTime()
  const endMs = end.getTime()
  const offsetMs = offsetMinutes * 60_000

  // Datas "rotuladas em local" — os getters UTC delas leem a hora local do
  // site, truque padrão para evitar reimplementar conversão de fuso.
  const startLocalMs = startMs + offsetMs
  const endLocalMs = endMs + offsetMs
  const startLocalDate = new Date(startLocalMs)
  const endLocalDate = new Date(endLocalMs)

  const matched = new Map<TariffWindowSnapshot, number>()

  let dayCursor = Date.UTC(startLocalDate.getUTCFullYear(), startLocalDate.getUTCMonth(), startLocalDate.getUTCDate())
  const lastDay = Date.UTC(endLocalDate.getUTCFullYear(), endLocalDate.getUTCMonth(), endLocalDate.getUTCDate())

  while (dayCursor <= lastDay) {
    const weekday = new Date(dayCursor).getUTCDay()
    for (const window of windows) {
      if (!window.daysOfWeek.includes(weekday)) continue

      const windowStartUtcMs = dayCursor + window.startMinute * 60_000 - offsetMs
      const windowEndUtcMs = dayCursor + window.endMinute * 60_000 - offsetMs

      const overlapStart = Math.max(windowStartUtcMs, startMs)
      const overlapEnd = Math.min(windowEndUtcMs, endMs)
      if (overlapEnd > overlapStart) {
        matched.set(window, (matched.get(window) ?? 0) + (overlapEnd - overlapStart))
      }
    }
    dayCursor += 24 * 60 * 60_000
  }

  const matchedTotalMs = [...matched.values()].reduce((sum, ms) => sum + ms, 0)
  const baseMs = Math.max(0, totalMs - matchedTotalMs)

  const allocations: WindowAllocation[] = [...matched.entries()].map(([window, ms]) => ({ window, ms }))
  if (baseMs > 0) allocations.push({ window: null, ms: baseMs })
  return allocations
}

function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveKwhPrice(window: TariffWindowSnapshot | null, tariff: TariffSnapshot): number | null {
  const override = window ? parseDecimal(window.pricePerKwh) : null
  return override ?? parseDecimal(tariff.pricePerKwh)
}

function resolveMinutePrice(window: TariffWindowSnapshot | null, tariff: TariffSnapshot): number | null {
  const override = window ? parseDecimal(window.pricePerMinute) : null
  return override ?? parseDecimal(tariff.pricePerMinute)
}

function resolveIdleFeePerMinuteCents(window: TariffWindowSnapshot | null, tariff: TariffSnapshot): number {
  const override = window?.idleFeePerMinute
  return override ?? tariff.idleFeePerMinute
}

/** Reais (fração, sem arredondar) -> centavos inteiros. Único ponto de arredondamento por componente. */
function toCentsRounded(reais: number): number {
  return Math.round(reais * 100)
}

// ------------------------------------------------------------------------
// Função principal
// ------------------------------------------------------------------------

/**
 * Calcula o custo total de uma sessão de recarga a partir da tarifa
 * congelada (`tariffSnapshot`) e das medições reais da sessão.
 *
 * Não lança para dados "de negócio" estranhos (ex.: tarifa sem nenhum
 * preço configurado) — nesse caso o componente correspondente fica 0.
 * Lança `Error` só para inconsistência estrutural nas medições (datas fora
 * de ordem), porque isso indica bug no chamador, não uma tarifa incomum.
 */
export function calcularCustoSessao(tariffSnapshot: TariffSnapshot, measurements: SessionMeasurements): CustoSessaoResultado {
  const { startedAt, stoppedAt, chargingEndedAt, energyDeliveredWh, timezone } = measurements

  if (stoppedAt.getTime() < startedAt.getTime()) {
    throw new Error('calcularCustoSessao: stoppedAt não pode ser anterior a startedAt')
  }
  if (chargingEndedAt && (chargingEndedAt.getTime() < startedAt.getTime() || chargingEndedAt.getTime() > stoppedAt.getTime())) {
    throw new Error('calcularCustoSessao: chargingEndedAt precisa estar entre startedAt e stoppedAt')
  }
  if (energyDeliveredWh < 0) {
    throw new Error('calcularCustoSessao: energyDeliveredWh não pode ser negativo')
  }

  const windows = tariffSnapshot.windows ?? []
  const offsetMinutes = windows.length > 0 ? getFixedUtcOffsetMinutes(timezone) : 0

  // --- Energia + tempo: repartidos pela janela ativa durante a CARGA ---
  // (chargingEndedAt ?? stoppedAt) porque, se o carro nunca parou de
  // carregar antes do StopTransaction, a sessão inteira é "carga".
  //
  // +1ms de proteção contra duração zero (sessão que falhou instantaneamente
  // com meterStart == meterStop): garante que sempre haja um instante para
  // resolver a janela ativa, sem precisar de um branch de divisão por zero
  // separado — o impacto de 1ms sobre uma sessão real é desprezível.
  const rawChargingEnd = chargingEndedAt ?? stoppedAt
  const chargingEnd = new Date(Math.max(rawChargingEnd.getTime(), startedAt.getTime() + 1))
  const totalChargingMs = chargingEnd.getTime() - startedAt.getTime()

  const chargingAllocations = allocateByWindow(startedAt, chargingEnd, windows, offsetMinutes)

  let energyCostReais = 0
  let timeCostReais = 0
  for (const allocation of chargingAllocations) {
    const shareOfEnergyWh = totalChargingMs > 0 ? energyDeliveredWh * (allocation.ms / totalChargingMs) : 0

    const kwhPrice = resolveKwhPrice(allocation.window, tariffSnapshot)
    if (kwhPrice !== null) {
      energyCostReais += (shareOfEnergyWh / 1000) * kwhPrice
    }

    const minutePrice = resolveMinutePrice(allocation.window, tariffSnapshot)
    if (minutePrice !== null) {
      timeCostReais += (allocation.ms / 60_000) * minutePrice
    }
  }

  // --- Ociosidade: janela [chargingEndedAt + carência, stoppedAt) ---
  let idleFeeCentsRaw = 0
  if (chargingEndedAt) {
    const idleStart = new Date(chargingEndedAt.getTime() + tariffSnapshot.idleGracePeriodSeconds * 1000)
    const idleEnd = stoppedAt
    if (idleEnd.getTime() > idleStart.getTime()) {
      const idleAllocations = allocateByWindow(idleStart, idleEnd, windows, offsetMinutes)
      for (const allocation of idleAllocations) {
        const centsPerMinute = resolveIdleFeePerMinuteCents(allocation.window, tariffSnapshot)
        idleFeeCentsRaw += (allocation.ms / 60_000) * centsPerMinute
      }
    }
  }

  const energyCostCents = toCentsRounded(energyCostReais)
  const timeCostCents = toCentsRounded(timeCostReais)
  const idleFeeCents = Math.round(idleFeeCentsRaw)
  const sessionFeeCents = tariffSnapshot.sessionFeeCents ?? 0

  const subtotalCents = energyCostCents + timeCostCents + idleFeeCents + sessionFeeCents
  const minChargeAdjustmentCents =
    tariffSnapshot.minChargeCents != null ? Math.max(0, tariffSnapshot.minChargeCents - subtotalCents) : 0

  const totalCostCents = subtotalCents + minChargeAdjustmentCents

  return {
    energyCostCents,
    timeCostCents,
    idleFeeCents,
    sessionFeeCents,
    minChargeAdjustmentCents,
    totalCostCents,
  }
}

// ------------------------------------------------------------------------
// Helper de serialização — monta o `TariffSnapshot` JSON-seguro a partir de
// uma linha `Tariff` + suas `TariffWindow[]` (formato que vem do Prisma).
// Usado tanto pelo StartTransaction real (Vega, Fase 4 — hoje o handler
// grava só `tariff`, sem `windows`, ver PENDÊNCIAS do handoff) quanto pelo
// seed sintético, para as duas fontes produzirem o MESMO formato de
// snapshot que `calcularCustoSessao` espera.
//
// Tipado com `DecimalLike` (em vez de importar `Prisma.Decimal` de
// `@prisma/client`) para este arquivo continuar sem dependência de tempo de
// execução em nenhuma biblioteca externa — qualquer objeto com `toString()`
// (Decimal do Prisma, string, number) serve.
// ------------------------------------------------------------------------

type DecimalLike = { toString(): string } | string | number

function decimalToStringOrNull(value: DecimalLike | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : value.toString()
}

export function serializeTariffSnapshot(
  tariff: {
    id: string
    model: string
    pricePerKwh?: DecimalLike | null
    pricePerMinute?: DecimalLike | null
    sessionFeeCents?: number | null
    minChargeCents?: number | null
    idleFeePerMinute: number
    idleGracePeriodSeconds: number
  },
  windows: Array<{
    label: string
    daysOfWeek: number[]
    startMinute: number
    endMinute: number
    pricePerKwh?: DecimalLike | null
    pricePerMinute?: DecimalLike | null
    idleFeePerMinute?: number | null
  }> = [],
): TariffSnapshot {
  return {
    id: tariff.id,
    model: tariff.model as TariffModelSnapshot,
    pricePerKwh: decimalToStringOrNull(tariff.pricePerKwh),
    pricePerMinute: decimalToStringOrNull(tariff.pricePerMinute),
    sessionFeeCents: tariff.sessionFeeCents ?? null,
    minChargeCents: tariff.minChargeCents ?? null,
    idleFeePerMinute: tariff.idleFeePerMinute,
    idleGracePeriodSeconds: tariff.idleGracePeriodSeconds,
    windows: windows.map((w) => ({
      label: w.label,
      daysOfWeek: w.daysOfWeek,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      pricePerKwh: decimalToStringOrNull(w.pricePerKwh),
      pricePerMinute: decimalToStringOrNull(w.pricePerMinute),
      idleFeePerMinute: w.idleFeePerMinute ?? null,
    })),
  }
}
