import { Select } from "@/components/ui/Select"
import { useSites } from "@/hooks/useSites"

/** Filtro de eletroposto (site) — reaproveita `useSites`, já escopado por operador no backend (OPERATOR só vê os próprios). */
export function SiteFilterSelect({ value, onChange, operatorId }: { value: string; onChange: (value: string) => void; operatorId?: string }) {
  const { data } = useSites({ pageSize: 100 })
  const sites = (data?.items ?? []).filter((s) => !operatorId || s.operatorId === operatorId)

  return (
    <div className="w-56">
      <Select
        aria-label="Filtrar por eletroposto"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Todos os eletropostos"
        options={sites.map((s) => ({ value: s.id, label: s.name }))}
      />
    </div>
  )
}
