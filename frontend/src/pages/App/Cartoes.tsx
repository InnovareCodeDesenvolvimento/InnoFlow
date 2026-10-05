import { useState } from "react"
import { CreditCard, MoreVertical, Plus, Star, TriangleAlert } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { AppBand } from "@/components/pwa/AppBand"
import { Button } from "@/components/ui/Button"
import { IconBadge } from "@/components/ui/IconBadge"
import { Badge } from "@/components/ui/Badge"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu"
import { useMePaymentMethods, useRemovePaymentMethod, useSetDefaultPaymentMethod } from "@/hooks/useMePaymentMethods"
import { useAddCardFlow } from "@/hooks/useAddCardFlow"
import { getApiErrorMessage } from "@/services/api"
import { CARD_GATEWAY_DISABLED_ADD_MESSAGE } from "@/lib/paymentMethodDisabled"
import { CardEligibilityNotice } from "@/components/carteira/CardEligibilityNotice"
import { disabledCardReason, issueFromEligibility } from "@/lib/cardEligibility"
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

  // I-7: o que o servidor diz agora (GET) ou o que acabou de recusar ao tentar adicionar (403/429) - o mais recente manda.
  const issue = addCardFlow.eligibilityIssue ?? issueFromEligibility(data?.cardEligibility)
  const cardsDisabled = issue !== null

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
    <div>
      <AppBand back={{ to: "/app/carteira", label: "Carteira" }} className="pb-7">
        <h1 className="text-lg font-black tracking-tight text-ink">Meus cartões</h1>
        <p className="text-sm text-ink-softer">Cadastre uma vez e só toque em "Iniciar" nas próximas recargas.</p>
      </AppBand>

      <div className="mx-auto max-w-md px-4 pb-5">
        {/* Sem identidade verificada ou bloqueado: NÃO se oferece "Adicionar cartão" - o card explica o motivo (Pix e carteira seguem normais). */}
        {issue ? (
          <CardEligibilityNotice issue={issue} className="mt-5" onLinked={addCardFlow.clearEligibilityIssue} />
        ) : (
          <Button type="button" variant="lime" size="lg" className="mt-5 w-full" loading={addCardFlow.isBusy} onClick={() => addCardFlow.start()}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Adicionar cartão
          </Button>
        )}
        {addCardFlow.unavailable && (
          <p role="alert" data-testid="add-card-unavailable" className="mt-3 flex items-start gap-2 rounded-2xl bg-warning-50 px-4 py-3 text-sm font-medium text-warning-700">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {CARD_GATEWAY_DISABLED_ADD_MESSAGE}
          </p>
        )}

        <div className="mt-6">
          {isLoading && (
            <div className="space-y-2.5" aria-hidden="true">
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </div>
          )}

          {isError && (
            <ErrorState
              tone="page"
              art={<MascotFace size={64} />}
              message={getApiErrorMessage(error, "Não foi possível carregar seus cartões.")}
              onRetry={() => refetch()}
            />
          )}

          {!isLoading && !isError && data && data.items.length === 0 && (
            <EmptyState
              tone="brand"
              art={<MascotFace size={64} />}
              title="Nenhum cartão cadastrado"
              description={cardsDisabled ? "Quando o cartão estiver disponível, ele aparece aqui. Por enquanto, use o Pix ou a carteira." : "Adicione um cartão para pagar as recargas sem digitar os dados toda vez."}
            />
          )}

          {!isLoading && !isError && data && data.items.length > 0 && (
            <ul className="space-y-2.5">
              {data.items.map((method, index) => {
                const exp = expiry(method)
                return (
                  <li
                    key={method.id}
                    data-disabled={cardsDisabled || undefined}
                    className={`card-elevated stagger-${Math.min(index + 1, 4)} animate-fade-in-up flex items-center gap-3 p-4`}
                  >
                    <IconBadge icon={CreditCard} size="lg" className={cardsDisabled ? "opacity-50 grayscale" : undefined} />
                    <div className="min-w-0 flex-1">
                      <p className={`flex items-center gap-2 text-sm font-bold ${cardsDisabled ? "text-ink-softer" : "text-ink"}`}>
                        {brandLabel(method.brand)} {method.last4 && <span className="whitespace-nowrap font-normal text-ink-softer">•••• {method.last4}</span>}
                      </p>
                      <p className="text-xs text-ink-softer">
                        {method.holderName ? `${method.holderName}${exp ? " · " : ""}` : ""}
                        {exp ? `validade ${exp}` : ""}
                      </p>
                      {issue && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Badge variant="neutral">Indisponível</Badge>
                          <span className="text-xs font-medium text-ink-soft" data-testid="card-disabled-reason">
                            {disabledCardReason(issue)}
                          </span>
                        </div>
                      )}
                    </div>
                    {method.isDefault && !cardsDisabled && (
                      <Badge variant="primary" className="shrink-0">
                        <Star className="h-3 w-3" aria-hidden="true" />
                        Padrão
                      </Badge>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--field-radius)] text-ink-softer hover:bg-muted hover:text-ink"
                          aria-label={`Mais opções — cartão ${brandLabel(method.brand)} final ${method.last4 ?? ""}`}
                        >
                          <MoreVertical className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {!method.isDefault && !cardsDisabled && (
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
