import { formatCents } from "@/lib/utils"

/**
 * Donut cartão × carteira — 2 categorias (identidade, não magnitude), cores
 * fixas por categoria (nunca por ranking): azul (`primary-500`) = cartão,
 * verde (`accent-600`) = carteira — mesma dupla de marca do projeto.
 * Revalidado no rebranding InnoFlow (16/09/2026): `primary-600` sozinho
 * falhava o piso de chroma do validador (lê como cinza), então o swatch
 * de cartão subiu para `primary-500` (mais saturado). Par atual passa em
 * todos os checks — ΔE 15.7 deutan / 17.0 normal.
 */
export function PaymentSplitDonut({ cardCents, walletCents }: { cardCents: number; walletCents: number }) {
  const total = cardCents + walletCents
  if (total === 0) {
    return <p className="py-8 text-center text-sm text-ink-softer">Sem pagamentos no período.</p>
  }

  const cardPct = (cardCents / total) * 100
  const radius = 15.9155
  const circumference = 2 * Math.PI * radius
  const cardDash = (cardPct / 100) * circumference

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
      <svg viewBox="0 0 36 36" className="h-36 w-36" role="img" aria-label={`Cartão ${cardPct.toFixed(0)}%, carteira ${(100 - cardPct).toFixed(0)}%`}>
        <circle cx={18} cy={18} r={radius} fill="none" stroke="rgb(var(--color-accent-600))" strokeWidth={4} />
        <circle
          cx={18}
          cy={18}
          r={radius}
          fill="none"
          stroke="rgb(var(--color-primary-500))"
          strokeWidth={4}
          strokeDasharray={`${cardDash} ${circumference - cardDash}`}
          strokeDashoffset={circumference / 4}
          strokeLinecap="butt"
        />
        <text x={18} y={17.5} textAnchor="middle" className="fill-ink text-[6px] font-black">
          {cardPct.toFixed(0)}%
        </text>
        <text x={18} y={22.5} textAnchor="middle" className="fill-ink-softer text-[3px] font-semibold">
          cartão
        </text>
      </svg>

      <dl className="grid grid-cols-1 gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary-500" aria-hidden="true" />
          <dt className="font-medium text-ink-soft">Cartão</dt>
          <dd className="font-bold tabular-nums text-ink">{formatCents(cardCents)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent-600" aria-hidden="true" />
          <dt className="font-medium text-ink-soft">Carteira</dt>
          <dd className="font-bold tabular-nums text-ink">{formatCents(walletCents)}</dd>
        </div>
      </dl>
    </div>
  )
}
