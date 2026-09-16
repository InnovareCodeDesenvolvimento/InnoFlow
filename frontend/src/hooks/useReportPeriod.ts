import { useMemo, useState } from "react"
import { resolvePeriod, type PeriodPreset } from "@/lib/period"

/**
 * Estado do seletor de período — LOCAL de cada tela (não é compartilhado
 * entre telas, cada uma escolhe seu próprio período), por isso hook comum
 * em vez de store global.
 */
export function useReportPeriod(initialPreset: PeriodPreset = "30d") {
  const [preset, setPreset] = useState<PeriodPreset>(initialPreset)
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => {
    const r = resolvePeriod(initialPreset)
    return { from: r.from, to: r.to }
  })

  const period = useMemo(() => resolvePeriod(preset, custom), [preset, custom])

  return {
    preset,
    from: period.from,
    to: period.to,
    setPreset,
    setCustom: (range: { from: string; to: string }) => {
      setPreset("custom")
      setCustom(range)
    },
  }
}
