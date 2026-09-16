import { MapPin, Zap } from "lucide-react"
import { Card, CardContent } from "@/components/ui/Card"
import { Badge } from "@/components/ui/Badge"
import { CONNECTOR_TYPE_LABELS, formatPowerKw, toNumber } from "@/lib/utils"
import type { ConnectorType, PublicSite } from "@/types/api"

interface ConnectorSummary {
  type: ConnectorType
  total: number
  available: number
  maxPowerKw: number
}

/** Agrupa os conectores de todos os pontos de recarga do site por tipo — é o que o motorista decide olhando: quantos livres, de qual tipo, com qual potência. */
function summarizeConnectors(site: PublicSite): ConnectorSummary[] {
  const byType = new Map<ConnectorType, ConnectorSummary>()
  for (const cp of site.chargePoints) {
    for (const c of cp.connectors) {
      const entry = byType.get(c.type) ?? { type: c.type, total: 0, available: 0, maxPowerKw: 0 }
      entry.total += 1
      if (c.status === "AVAILABLE") entry.available += 1
      entry.maxPowerKw = Math.max(entry.maxPowerKw, toNumber(c.maxPowerKw))
      byType.set(c.type, entry)
    }
  }
  return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type))
}

export function PublicSiteCard({ site }: { site: PublicSite }) {
  const summary = summarizeConnectors(site)
  const totalAvailable = summary.reduce((acc, s) => acc + s.available, 0)
  const totalConnectors = summary.reduce((acc, s) => acc + s.total, 0)

  return (
    <Card className="transition-shadow hover:shadow-card-hover">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-ink">{site.name}</h3>
            <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-softer">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {site.addressLine} — {site.city}/{site.state}
              </span>
            </p>
          </div>
          <Badge variant={totalAvailable > 0 ? "success" : "neutral"} className="shrink-0">
            <Zap className="h-3 w-3" aria-hidden="true" />
            {totalAvailable}/{totalConnectors} livres
          </Badge>
        </div>

        {summary.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {summary.map((s) => (
              <Badge key={s.type} variant={s.available > 0 ? "primary" : "neutral"}>
                {CONNECTOR_TYPE_LABELS[s.type]} · {s.available}/{s.total}
                {s.maxPowerKw > 0 && <span className="normal-case">· até {formatPowerKw(s.maxPowerKw)}</span>}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-xs text-ink-subtle">Nenhum conector cadastrado ainda.</p>
        )}
      </CardContent>
    </Card>
  )
}
