import { useState } from "react"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { useDrivers } from "@/hooks/useDrivers"

/** Regra do backend (`drivers.routes.ts`): OPERATOR só lista buscando, com pelo menos 3 caracteres. */
export const OPERATOR_MIN_SEARCH = 3
/** Espera depois da última tecla antes de consultar (a busca não dispara uma chamada por tecla). */
export const DRIVER_SEARCH_DEBOUNCE_MS = 350

/**
 * Busca de motorista — a regra ÚNICA do Admin (tela Carteiras e diálogo "Iniciar recarga"): termo com debounce, `GET /api/admin/drivers?search=`,
 * e a trava do OPERATOR (só consulta digitando ≥ 3 caracteres, não baixa a base inteira). ADMIN, por padrão, lista sem digitar nada.
 *
 * `minChars` sobrescreve o mínimo por tela: o diálogo de recarga remota exige ao menos 1 caractere também do ADMIN (não faz sentido sugerir "os 5 mais
 * novos da rede" como candidatos a ter a carteira debitada). Fora isso a regra é a mesma — nome por trecho, e-mail só exato (resolvido no servidor).
 */
export function useDriverSearch({ isAdmin, page = 1, pageSize, minChars }: { isAdmin: boolean; page?: number; pageSize: number; minChars?: number }) {
  const [searchInput, setSearchInput] = useState("")
  const search = useDebouncedValue(searchInput.trim(), DRIVER_SEARCH_DEBOUNCE_MS)
  const required = minChars ?? (isAdmin ? 0 : OPERATOR_MIN_SEARCH)
  const needsMoreChars = search.length < required
  const query = useDrivers({ search: search || undefined, page, pageSize }, !needsMoreChars)
  return { searchInput, setSearchInput, search, needsMoreChars, minChars: required, query }
}
