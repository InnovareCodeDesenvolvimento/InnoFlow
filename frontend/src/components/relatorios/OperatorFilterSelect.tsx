import { Select } from "@/components/ui/Select"
import { useOperators } from "@/hooks/useOperators"

/** Filtro de operador — só renderizado para ADMIN pelas telas que o usam; OPERATOR nunca vê este controle (não tem o que filtrar). */
export function OperatorFilterSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { data } = useOperators()
  const operators = data?.items ?? []

  return (
    <div className="w-56">
      <Select
        aria-label="Filtrar por operador"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Todos os operadores"
        options={operators.map((o) => ({ value: o.id, label: o.name }))}
      />
    </div>
  )
}
