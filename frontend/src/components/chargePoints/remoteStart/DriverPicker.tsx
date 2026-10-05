import type { KeyboardEvent } from "react"
import { Zap } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Skeleton } from "@/components/ui/Skeleton"
import { DriverSearchField } from "@/components/admin/DriverSearchField"
import { useDriverSearch } from "@/hooks/useDriverSearch"
import { getApiErrorMessage } from "@/services/api"
import { formatCents } from "@/lib/utils"
import type { DriverListRow } from "@/types/api"
import { RadioRow } from "./RadioRow"

const RESULTS = 5

/** Saldo e dívida do motorista, no mesmo formato na lista, no cartão "selecionado" e na confirmação. */
export function DriverBalanceLine({ driver }: { driver: Pick<DriverListRow, "walletBalanceCents" | "openDebtCents"> }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-softer">
      <span>
        Saldo <strong className="font-semibold tabular-nums text-ink">{formatCents(driver.walletBalanceCents)}</strong>
      </span>
      {driver.openDebtCents > 0 ? (
        <Badge variant="danger" className="tabular-nums">
          Dívida {formatCents(driver.openDebtCents)}
        </Badge>
      ) : (
        <span>Sem dívida</span>
      )}
    </span>
  )
}

/**
 * Busca e escolha do motorista (ADMIN). A regra da busca é a ÚNICA do Admin (`useDriverSearch` + `DriverSearchField`, a mesma da tela Carteiras); aqui o ADMIN também
 * precisa digitar (≥ 1 caractere) para ver candidatos. Saldo e dívida aparecem em cada resultado — a pessoa decide com eles à vista, antes de confirmar.
 */
export function DriverPicker({ isAdmin, selected, onSelect, error }: { isAdmin: boolean; selected: DriverListRow | null; onSelect: (driver: DriverListRow) => void; error?: string }) {
  const { searchInput, setSearchInput, needsMoreChars, minChars, query } = useDriverSearch({ isAdmin, pageSize: RESULTS, minChars: isAdmin ? 1 : undefined })
  const { data, isLoading, isError, error: queryError, refetch } = query

  // Enter no campo de busca NÃO envia o formulário do diálogo (a pessoa ainda não escolheu ninguém).
  const swallowEnter = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "search") e.preventDefault()
  }

  return (
    <div className="space-y-2" onKeyDown={swallowEnter}>
      <DriverSearchField value={searchInput} onChange={setSearchInput} isAdmin={isAdmin} label="Buscar motorista" />

      {needsMoreChars && (
        <p className="text-xs text-ink-softer" data-testid="driver-search-prompt">
          {isAdmin ? "Digite o nome ou o e-mail completo do motorista." : `Digite pelo menos ${minChars} letras do nome do motorista.`}
        </p>
      )}

      {!needsMoreChars && isLoading && (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      )}

      {!needsMoreChars && isError && (
        <Alert tone="danger" size="sm" role="alert">
          <p>{getApiErrorMessage(queryError, "Não foi possível buscar motoristas.")}</p>
          <Button type="button" variant="outline" size="touch-sm" className="mt-2" onClick={() => void refetch()}>
            Tentar de novo
          </Button>
        </Alert>
      )}

      {!needsMoreChars && !isLoading && !isError && data && data.items.length === 0 && (
        <p className="text-sm text-ink-softer" role="status">
          Nenhum motorista encontrado. Confira a grafia — a busca por e-mail só acha o endereço completo e exato.
        </p>
      )}

      {!needsMoreChars && !isError && data && data.items.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="sr-only">Resultados da busca</legend>
          {data.items.map((d) => (
            <RadioRow key={d.id} name="remote-start-driver" value={d.id} checked={selected?.id === d.id} onChange={() => onSelect(d)}>
              <span className="block min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{d.name}</span>
                  {d.activeSessionId && (
                    <Badge variant="info">
                      <Zap className="h-3 w-3" aria-hidden="true" />
                      Em recarga
                    </Badge>
                  )}
                </span>
                {d.email && <span className="block truncate text-xs text-ink-softer">{d.email}</span>}
                <DriverBalanceLine driver={d} />
              </span>
            </RadioRow>
          ))}
          {data.total > data.items.length && (
            <p className="text-xs text-ink-softer" role="status">
              Mostrando {data.items.length} de {data.total}. Refine a busca para achar o motorista certo.
            </p>
          )}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
