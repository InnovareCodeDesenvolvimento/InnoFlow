import { Link } from "react-router-dom"
import { CheckCircle2, ShieldCheck, Wallet } from "lucide-react"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { Card, CardContent } from "@/components/ui/Card"
import { formatCents } from "@/lib/utils"
import type { MeTopupDTO } from "@/types/api"

/** Passo 3 — Pix confirmado. Decompõe o valor pago em quitação de dívida (se houve) + saldo livre, igual ao recibo de sessão (`SessaoDetalhe.tsx`) decompõe custo. */
export function TopupSuccessCard({ topup, walletBalanceCents }: { topup: MeTopupDTO; walletBalanceCents: number | undefined }) {
  const freeCreditedCents = topup.amountCents - topup.debtSettledCents

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success-100 text-success-700">
        <CheckCircle2 className="animate-pop-in h-9 w-9" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-xl font-black tracking-tight text-ink">Saldo adicionado!</h1>
      <p className="mt-1 text-sm text-ink-softer">Seu Pix de {formatCents(topup.amountCents)} foi confirmado.</p>

      <Card className="card-premium animate-fade-in-up mt-5 w-full">
        <CardContent className="p-5">
          <dl className="space-y-2.5 text-sm">
            {topup.debtSettledCents > 0 && (
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1.5 text-ink-softer">
                  <ShieldCheck className="h-4 w-4 text-warning-600" aria-hidden="true" />
                  Quitou dívida em aberto
                </dt>
                <dd className="font-semibold text-ink">{formatCents(topup.debtSettledCents)}</dd>
              </div>
            )}
            <div className="flex items-center justify-between">
              <dt className="text-ink-softer">Saldo livre creditado</dt>
              <dd className="font-semibold text-ink">{formatCents(freeCreditedCents)}</dd>
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle pt-2.5 text-base">
              <dt className="flex items-center gap-1.5 font-bold text-ink">
                <Wallet className="h-4 w-4 text-primary" aria-hidden="true" />
                Novo saldo disponível
              </dt>
              <dd className="text-lg font-black text-gradient-brand">{formatCents(walletBalanceCents)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="mt-6 flex w-full flex-col gap-2">
        <Link to="/app/carteira" className={buttonVariants({ size: "lg", className: "w-full" })}>
          Ver carteira
        </Link>
        <Link to="/app" className={buttonVariants({ variant: "ghost", className: "w-full" })}>
          Voltar para o início
        </Link>
      </div>
    </div>
  )
}
