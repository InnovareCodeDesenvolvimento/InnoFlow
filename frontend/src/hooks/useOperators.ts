import { useQuery } from "@tanstack/react-query"
import { operatorsService } from "@/services/operators"
import { useAuthStore } from "@/store/authStore"

/** Lista de operadores — só ADMIN pode ver/filtrar por operador (ver `getAdminNav`/regras de escopo). A query nem dispara para OPERATOR. */
export function useOperators() {
  const role = useAuthStore((s) => s.user?.role)
  return useQuery({
    queryKey: ["operators", "admin"],
    queryFn: () => operatorsService.list(),
    enabled: role === "ADMIN",
    staleTime: 5 * 60 * 1000,
  })
}
