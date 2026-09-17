import { Select } from "@/components/ui/Select"
import { useAuditLogActors } from "@/hooks/useAuditLogs"

/**
 * Filtro de ator da tela de Auditoria — alimentado por `GET
 * /api/admin/audit-logs/actors` (só quem de fato gerou evento no período
 * selecionado), não uma listagem de usuários separada (pedido explícito do
 * escopo). Refaz a lista quando o período muda.
 */
export function AuditActorFilterSelect({
  from,
  to,
  value,
  onChange,
}: {
  from: string
  to: string
  value: string
  onChange: (value: string) => void
}) {
  const { data } = useAuditLogActors({ from, to })
  const actors = data?.items ?? []

  return (
    <div className="w-64">
      <Select
        aria-label="Filtrar por ator"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Todos os atores"
        options={actors.map((a) => ({ value: a.userId, label: `${a.name} (${a.eventCount})` }))}
      />
    </div>
  )
}
