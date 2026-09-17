import { ArrowDownCircle, MinusCircle, PlusCircle, RotateCcw, Zap, type LucideIcon } from "lucide-react"
import type { WalletEntryType } from "@/types/api"

const ICON_BY_TYPE: Record<WalletEntryType, LucideIcon> = {
  TOPUP_PIX: ArrowDownCircle,
  TOPUP_REFUND: RotateCcw,
  CHARGE_DEBIT: Zap,
  ADJUSTMENT_CREDIT: PlusCircle,
  ADJUSTMENT_DEBIT: MinusCircle,
  REFUND: RotateCcw,
}

/** Ícone por tipo de lançamento; a cor segue o sinal real (`amountCents`), não o tipo — um `TOPUP_REFUND` também é crédito visualmente verde. */
export function WalletEntryIcon({ type, credit }: { type: WalletEntryType; credit: boolean }) {
  const Icon = ICON_BY_TYPE[type]
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${credit ? "bg-success-100 text-success-700" : "bg-danger-100 text-danger-700"}`}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
    </span>
  )
}
