import { Search } from "lucide-react"
import { Input } from "@/components/ui/Input"

/**
 * Campo de busca de motorista (Admin): o texto e as dicas da regra única de `useDriverSearch`. ADMIN busca por nome ou e-mail exato; OPERATOR só pelo nome
 * (o servidor omite o e-mail dele, LGPD). `label` visível opcional — sem ele o campo é nomeado por `aria-label="Buscar motorista"`.
 */
export function DriverSearchField({
  value,
  onChange,
  isAdmin,
  label,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  isAdmin: boolean
  label?: string
  autoFocus?: boolean
}) {
  return (
    <Input
      type="search"
      label={label}
      aria-label={label ? undefined : "Buscar motorista"}
      placeholder={isAdmin ? "Buscar por nome ou e-mail exato" : "Nome do motorista (mín. 3 letras)"}
      autoComplete="off"
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      leftIcon={<Search className="h-4 w-4" aria-hidden="true" />}
      hint={isAdmin ? undefined : "Por segurança, operadores encontram motoristas pelo nome — a base inteira da rede não é listada."}
    />
  )
}
