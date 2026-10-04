import { Badge } from "@/components/ui/Badge"
import { Skeleton } from "@/components/ui/Skeleton"
import type { ChargePointCoverage } from "@/lib/tariffAssignments"

/**
 * Resumo de uma linha da cobertura de tarifa de um carregador, para a tabela de carregadores.
 * Só o que EXIGE atenção vira selo: "Sem tarifa" (o QR não inicia recarga) e "Falta em N tomada(s)". Tarifa única aparece como texto.
 * `coverage = null` = ainda não dá para afirmar nada (carregando, erro ou lista truncada) — nunca mostra "Sem tarifa" por palpite.
 */
export function TariffCoverageBadge({ coverage, loading }: { coverage: ChargePointCoverage | null; loading?: boolean }) {
  if (loading) return <Skeleton className="h-5 w-24" />
  if (!coverage) return <span className="text-ink-softer" title="Não foi possível verificar a tarifa deste carregador">—</span>

  switch (coverage.state) {
    case "none":
      return <Badge variant="warning">Sem tarifa</Badge>
    case "partial":
      return <Badge variant="warning">{coverage.uncovered === 1 ? "Falta em 1 tomada" : `Falta em ${coverage.uncovered} tomadas`}</Badge>
    case "mixed":
      return <Badge variant="info">Varia por tomada</Badge>
    case "no-connectors":
      return <span className="text-ink-softer">Sem tomadas</span>
    case "uniform":
      return <span className="font-medium text-ink-soft">{coverage.tariff?.name}</span>
  }
}
