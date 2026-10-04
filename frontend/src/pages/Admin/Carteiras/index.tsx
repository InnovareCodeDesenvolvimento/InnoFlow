import { useState } from "react"
import { ChevronRight, Search, Users, WalletCards, Zap } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Badge } from "@/components/ui/Badge"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Input } from "@/components/ui/Input"
import { Pagination } from "@/components/ui/Pagination"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { useDrivers } from "@/hooks/useDrivers"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { formatCents, formatDate } from "@/lib/utils"
import type { DriverListRow } from "@/types/api"
import { DriverWalletDrawer } from "./DriverWalletDrawer"

const PAGE_SIZE = 20
/** Regra do backend (`drivers.routes.ts`): OPERATOR só lista buscando, com pelo menos 3 caracteres. */
const OPERATOR_MIN_SEARCH = 3

/**
 * Admin → Carteiras: saldo e extrato dos motoristas da REDE (conta de motorista
 * não pertence a operador). ADMIN lista todos e pode ajustar saldo; OPERATOR só
 * consulta e só encontra motorista digitando ≥ 3 caracteres (não baixa a base
 * inteira). Dado de pessoa identificada: a listagem mostra só o necessário
 * (nome, e-mail — que o servidor omite para OPERATOR —, saldo, dívida).
 */
export default function CarteirasPage() {
  const role = useAuthStore((s) => s.user?.role)
  const isAdmin = role === "ADMIN"

  const [searchInput, setSearchInput] = useState("")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<DriverListRow | null>(null)

  const search = useDebouncedValue(searchInput.trim(), 350)
  const needsMoreChars = !isAdmin && search.length < OPERATOR_MIN_SEARCH
  const { data, isLoading, isError, error, refetch, isFetching } = useDrivers({ search: search || undefined, page, pageSize: PAGE_SIZE }, !needsMoreChars)

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="space-y-6">
      <PageHeader
        title="Carteiras"
        description="Saldo e extrato dos motoristas da rede."
        icon={WalletCards}
      />

      <div className="max-w-md">
        <Input
          type="search"
          aria-label="Buscar motorista"
          placeholder={isAdmin ? "Buscar por nome ou e-mail exato" : "Nome do motorista (mín. 3 letras)"}
          autoComplete="off"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value)
            setPage(1)
          }}
          leftIcon={<Search className="h-4 w-4" aria-hidden="true" />}
          hint={isAdmin ? undefined : "Por segurança, operadores encontram motoristas pelo nome — a base inteira da rede não é listada."}
        />
      </div>

      {needsMoreChars && (
        <EmptyState
          icon={Users}
          title="Busque um motorista"
          description={
            searchInput.trim().length === 0
              ? `Digite pelo menos ${OPERATOR_MIN_SEARCH} letras do nome do motorista para consultar o saldo e o extrato.`
              : `Faltam ${OPERATOR_MIN_SEARCH - search.length} ${OPERATOR_MIN_SEARCH - search.length === 1 ? "caractere" : "caracteres"} para buscar.`
          }
        />
      )}

      {!needsMoreChars && isLoading && <TableSkeleton cols={5} />}
      {!needsMoreChars && isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os motoristas.")} onRetry={() => void refetch()} />}

      {!needsMoreChars && !isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState
          icon={Users}
          title="Nenhum motorista encontrado"
          description={search ? "Confira a grafia. A busca por e-mail só acha o endereço completo e exato." : "Ainda não há motoristas cadastrados na rede."}
        />
      )}

      {!needsMoreChars && !isLoading && !isError && data && data.items.length > 0 && (
        <>
          <div className={isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Motorista</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                  <TableHead className="text-right">Dívida em aberto</TableHead>
                  <TableHead>Cliente desde</TableHead>
                  <TableHead>
                    <span className="sr-only">Extrato</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((driver) => (
                  <TableRow key={driver.id} className="pressable cursor-pointer" onClick={() => setSelected(driver)}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setSelected(driver)}
                        className="block min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        aria-label={`Ver extrato de ${driver.name}`}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ink">{driver.name}</span>
                          {driver.activeSessionId && (
                            <Badge variant="info">
                              <Zap className="h-3 w-3" aria-hidden="true" />
                              Em recarga
                            </Badge>
                          )}
                        </span>
                        {driver.email && <span className="block truncate text-xs text-ink-softer">{driver.email}</span>}
                      </button>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-ink">{formatCents(driver.walletBalanceCents)}</TableCell>
                    <TableCell className="text-right">
                      {driver.openDebtCents > 0 ? (
                        <Badge variant="danger" className="tabular-nums">
                          {formatCents(driver.openDebtCents)}
                        </Badge>
                      ) : (
                        <span className="text-ink-softer">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(driver.createdAt)}</TableCell>
                    <TableCell className="w-10 text-ink-subtle">
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Pagination page={data.page} totalPages={totalPages} total={data.total} pageSize={data.pageSize} onPageChange={setPage} label="motoristas" />
        </>
      )}

      {selected && <DriverWalletDrawer key={selected.id} driver={selected} isAdmin={isAdmin} onClose={() => setSelected(null)} />}
    </div>
  )
}
