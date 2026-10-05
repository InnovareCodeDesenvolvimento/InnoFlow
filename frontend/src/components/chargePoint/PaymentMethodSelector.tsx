import { Link } from "react-router-dom"
import { CreditCard, Star, Wallet } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { UNREADABLE_CARD_BADGE, UNREADABLE_CARD_MESSAGE, isUnreadable } from "@/lib/cardUnreadable"
import { cn } from "@/lib/utils"
import type { MePaymentMethodDTO } from "@/types/api"

export type PaymentSelection = { mode: "WALLET" } | { mode: "CARD"; paymentMethodId: string }

/**
 * Seletor de forma de pagamento da tela de iniciar recarga (F5.4, ver
 * `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2). SÓ existe
 * quando o motorista tem 1+ cartão salvo — com 0 cartões o chamador nem
 * monta este componente, o fluxo fica IDÊNTICO ao de sempre (Carteira), sem
 * forçar cadastro (decisão de produto: nunca bloquear quem só quer usar
 * carteira). Mesmo padrão de chip `sr-only` de `TopupAmountPicker` (rótulo
 * clicável — Playwright clica no `<span>` visível, nunca no input escondido,
 * ver `[[padrao-recarga-pix-f5]]`), mas em lista VERTICAL: cada opção tem
 * texto mais longo (bandeira + final + badge "Padrão"), não cabe em chips
 * lado a lado como o valor do Pix.
 *
 * Cartão ILEGÍVEL (`unreadable`, ver `lib/cardUnreadable.ts`): aparece na lista com o selo
 * "Cadastre de novo" e o aviso, mas o radio fica DESABILITADO (não dá para escolher nem
 * pré-selecionar — quem decide a seleção é o chamador). Se todos estiverem assim, só a
 * Carteira é escolhível e o aviso explica o resto.
 */
export function PaymentMethodSelector({
  methods,
  value,
  onChange,
}: {
  methods: MePaymentMethodDTO[]
  value: PaymentSelection
  onChange: (next: PaymentSelection) => void
}) {
  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-bold uppercase tracking-wide text-ink-softer">Forma de pagamento</legend>
      <div className="space-y-2" role="radiogroup" aria-label="Forma de pagamento">
        <label htmlFor="payment-option-wallet" className="relative block cursor-pointer">
          <input
            id="payment-option-wallet"
            type="radio"
            name="payment-method"
            checked={value.mode === "WALLET"}
            onChange={() => onChange({ mode: "WALLET" })}
            className="peer sr-only"
          />
          <span
            className={cn(
              "press flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-bold peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2",
              value.mode === "WALLET" ? "border-primary bg-primary/10 text-primary-700" : "border-border bg-surface text-ink hover:bg-muted",
            )}
          >
            <Wallet className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">Carteira</span>
          </span>
        </label>

        {methods.map((method) => {
          const unreadable = isUnreadable(method)
          const selected = !unreadable && value.mode === "CARD" && value.paymentMethodId === method.id
          const inputId = `payment-option-${method.id}`
          const noteId = `payment-option-${method.id}-note`
          return (
            <div key={method.id} data-unreadable={unreadable || undefined}>
              <label htmlFor={inputId} className={cn("relative block", unreadable ? "cursor-not-allowed" : "cursor-pointer")}>
                <input
                  id={inputId}
                  type="radio"
                  name="payment-method"
                  checked={selected}
                  disabled={unreadable}
                  aria-describedby={unreadable ? noteId : undefined}
                  onChange={() => onChange({ mode: "CARD", paymentMethodId: method.id })}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    "press flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-bold peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2",
                    unreadable
                      ? "border-border bg-muted text-ink-softer"
                      : selected
                        ? "border-primary bg-primary/10 text-primary-700"
                        : "border-border bg-surface text-ink hover:bg-muted",
                  )}
                >
                  <CreditCard className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">
                    {method.brand} {method.last4 && <span className="font-normal text-ink-softer">•••• {method.last4}</span>}
                  </span>
                  {unreadable ? (
                    <Badge variant="neutral" className="shrink-0">
                      {UNREADABLE_CARD_BADGE}
                    </Badge>
                  ) : (
                    method.isDefault && (
                      <Badge variant="primary" className="shrink-0">
                        <Star className="h-3 w-3" aria-hidden="true" />
                        Padrão
                      </Badge>
                    )
                  )}
                </span>
              </label>
              {unreadable && (
                <p id={noteId} data-testid="unreadable-card-note" className="mt-1.5 px-1 text-xs font-medium text-ink-soft">
                  {UNREADABLE_CARD_MESSAGE}{" "}
                  <Link to="/app/carteira/cartoes" className="font-semibold text-primary-700 underline underline-offset-2">
                    Ver meus cartões
                  </Link>
                </p>
              )}
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}
