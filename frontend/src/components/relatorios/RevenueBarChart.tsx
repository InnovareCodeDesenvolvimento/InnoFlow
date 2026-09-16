import { useState } from "react"
import { formatCents, formatDate } from "@/lib/utils"

/**
 * Barras de faturamento por dia — magnitude de uma série só, por isso um
 * hue sequencial único (`primary`), nunca arco-íris (ver skill de dataviz).
 * Sem lib de gráfico nova: SVG próprio, leve, com tooltip de hover e uma
 * tabela oculta (`sr-only`) para leitor de tela — não é só decoração.
 */
export function RevenueBarChart({ data }: { data: Array<{ date: string; revenueCents: number }> }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  if (data.length === 0) return null

  const max = Math.max(1, ...data.map((d) => d.revenueCents))
  const width = 100
  const height = 40
  const gap = data.length > 20 ? 0.3 : 0.6
  const barWidth = width / data.length - gap

  return (
    <figure className="w-full">
      <figcaption className="sr-only">Faturamento por dia no período selecionado</figcaption>
      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height + 4}`} className="h-48 w-full overflow-visible" preserveAspectRatio="none" role="img" aria-hidden="true">
          <line x1={0} y1={height} x2={width} y2={height} stroke="rgb(var(--color-border-subtle))" strokeWidth={0.2} />
          {data.map((d, i) => {
            const barHeight = (d.revenueCents / max) * height
            const x = i * (width / data.length) + gap / 2
            const y = height - barHeight
            const isHovered = hoverIndex === i
            return (
              <rect
                key={d.date}
                x={x}
                y={y}
                width={Math.max(0.1, barWidth)}
                height={Math.max(0, barHeight)}
                rx={0.6}
                fill={isHovered ? "rgb(var(--color-primary-700))" : "rgb(var(--color-primary-500))"}
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex((prev) => (prev === i ? null : prev))}
              />
            )
          })}
        </svg>

        {hoverIndex !== null && (
          <div
            className="pointer-events-none absolute -top-2 -translate-y-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg"
            style={{ left: `${(hoverIndex / data.length) * 100}%` }}
          >
            <p className="font-bold text-ink">{formatCents(data[hoverIndex].revenueCents)}</p>
            <p className="text-ink-softer">{formatDate(data[hoverIndex].date)}</p>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>Faturamento por dia</caption>
        <thead>
          <tr>
            <th>Data</th>
            <th>Faturamento</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{formatDate(d.date)}</td>
              <td>{formatCents(d.revenueCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
