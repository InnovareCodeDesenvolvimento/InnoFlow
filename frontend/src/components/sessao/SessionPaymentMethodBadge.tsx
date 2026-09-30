import { CreditCard, Wallet } from "lucide-react"
import type { MeSessionPaymentInfo } from "@/types/api"

/**
 * Ícone + rótulo da forma de pagamento usada numa sessão (F5.4) — mesmo
 * componente na tela de sessão ativa (`Sessao.tsx`) e no recibo
 * (`SessaoDetalhe.tsx`), para nunca divergir a forma de exibir. `payment.card`
 * pode faltar mesmo com `paymentMode === "CARD"` em teoria (campo opcional no
 * contrato) — cai num rótulo genérico "Cartão" em vez de quebrar a tela.
 */
export function SessionPaymentMethodBadge({
  paymentMode,
  payment,
}: {
  paymentMode: "WALLET" | "CARD"
  payment?: MeSessionPaymentInfo
}) {
  if (paymentMode === "CARD") {
    const card = payment?.card
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-softer">
        <CreditCard className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {card ? (
          <>
            {card.brand} {card.last4 && <span>•••• {card.last4}</span>}
          </>
        ) : (
          "Cartão"
        )}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-softer">
      <Wallet className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Carteira
    </span>
  )
}
