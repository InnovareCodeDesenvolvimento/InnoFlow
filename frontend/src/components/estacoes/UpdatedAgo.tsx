import { useEffect, useState } from "react"
import { formatUpdatedAgo } from "@/lib/stations"

/**
 * "atualizado há 12 s" — carimbo honesto de que o número é de AGORA (não
 * promessa: não existe reserva). Vem do `dataUpdatedAt` do TanStack Query,
 * NUNCA de campo do servidor; reavalia a cada 5 s pra não ficar parado.
 */
export function UpdatedAgo({ dataUpdatedAt, className }: { dataUpdatedAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])
  const label = formatUpdatedAgo(dataUpdatedAt, now)
  if (!label) return null
  return (
    <span className={className} data-testid="updated-ago">
      {label}
    </span>
  )
}
