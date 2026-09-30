import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, CreditCard, MoreVertical, Plus, Star } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu"
import { useMePaymentMethods, useRemovePaymentMethod, useSetDefaultPaymentMethod } from "@/hooks/useMePaymentMethods"
import { useAddCardFlow } from "@/hooks/useAddCardFlow"
import { getApiErrorMessage } from "@/services/api"
import { toast } from "sonner"
import type { MePaymentMethodDTO } from "@/types/api"

/** Nome de exibição por bandeira — chega pronto do backend (`brand`), sem tradução necessária hoje; centralizado aqui caso um dia divirja. */
function brandLabel(brand: string): string {
  return brand
}

function expiry(method: MePaymentMethodDTO): string | null {
  if (!method.expiryMonth || !method.expiryYear) return null
  return `${String(method.expiryMonth).padStart(2, "0")}/${String(method.expiryYear).slice(-2)}`
}

/**
 * `/app/carteira/cartoes` — cartões salvos via Silent Order Post (F5.3). Esta
 * tela e o resto do app principal NUNCA veem PAN/CVV: o formulário de cartão
 * mora num documento isolado (`pagamento-cartao.html`), aberto numa aba nova
 * pelo `useAddCardFlow`. Ver `.claude/agent-memory/nova/
 * decisoes-f5-pagamento-cielo.md` §2.
 */
export function Cartoes() {
  const { data, isLoading, isError, error, refetch } = useMePaymentMethods()
  const addCardFlow = useAddCardFlow()
  const setDefault = useSetDefaultPaymentMethod()
  const removeMethod = useRemovePaymentMethod()
  const [removing, setRemoving] = useState<MePaymentMethodDTO | null>(null)

  const handleSetDefault = async (method: MePaymentMethodDTO) => {
    try {
      await setDefault.mutateAsync(method.id)
      toast.success("Cartão definido como padrão.")
    } catch (err) {
      toast.error("Não foi possível definir o cartão como padrão.", { description: getApiErrorMessage(err) })
    }
  }

  const confirmRemove = async () => {
    if (!removing) return
    try {
      await removeMethod.mutateAsync(removing.id)
      toast.success("Cartão removido.")
      setRemoving(null)
    } catch (err) {
      toast.error("Não foi possível remover o cartão.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-5">
      <Link to="/app/carteira" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-softer hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Carteira
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-black tracking-tight text-ink">Meus cartões</h1>
          <p className="text-sm text-ink-softer">Cadastre uma vez e só toque em "Iniciar" nas próximas recargas.</p>
        </div>
      </div>

      <Button type="button" className="mt-4 w-full" loading={addCardFlow.isBusy} onClick={() => addCardFlow.start()}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Adicionar cartão
      </Button>

      <div className="mt-6">
        {isLoading && (
          <div className="space-y-2.5" aria-hidden="true">
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
          </div>
        )}

        {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar seus cartões.")} onRetry={() => refetch()} />}

        {!isLoading && !isError && data && data.items.length === 0 && (
          <EmptyState icon={CreditCard} title="Nenhum cartão cadastrado" description="Adicione um cartão para pagar as recargas sem digitar os dados toda vez." />
        )}

        {!isLoading && !isError && data && data.items.length > 0 && (
          <ul className="space-y-2.5">
            {data.items.map((method, index) => {
              const exp = expiry(method)
              return (
                <li
                  key={method.id}
                  className={`stagger-${Math.min(index + 1, 4)} animate-fade-in-up flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface p-4 shadow-card`}
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
                    <CreditCard className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-bold text-ink">
                      {brandLabel(method.brand)} {method.last4 && <span className="font-normal text-ink-softer">•••• {method.last4}</span>}
                    </p>
                    <p className="text-xs text-ink-softer">
                      {method.holderName ? `${method.holderName}${exp ? " · " : ""}` : ""}
                      {exp ? `validade ${exp}` : ""}
                    </p>
                  </div>
                  {method.isDefault && (
                    <Badge variant="primary" className="shrink-0">
                      <Star className="h-3 w-3" aria-hidden="true" />
                      Padrão
                    </Badge>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-softer hover:bg-muted hover:text-ink"
                        aria-label={`Mais opções — cartão ${brandLabel(method.brand)} final ${method.last4 ?? ""}`}
                      >
                        <MoreVertical className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!method.isDefault && (
                        <DropdownMenuItem onSelect={() => handleSetDefault(method)}>
                          <Star className="h-4 w-4" aria-hidden="true" />
                          Tornar padrão
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="text-danger-700 data-[highlighted]:bg-danger-50 data-[highlighted]:text-danger-700"
                        onSelect={() => setRemoving(method)}
                      >
                        Remover
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remover este cartão?"
        description={removing ? `${brandLabel(removing.brand)} •••• ${removing.last4 ?? ""} não poderá mais ser usado para pagar recargas.` : undefined}
        confirmLabel="Remover"
        loading={removeMethod.isPending}
        onConfirm={confirmRemove}
      />
    </div>
  )
}
