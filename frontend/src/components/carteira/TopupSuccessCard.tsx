import { Link } from "react-router-dom"
import { CheckCircle2, ShieldCheck, Wallet } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { Card, CardContent } from "@/components/ui/Card"
import { formatCents } from "@/lib/utils"
import type { MeTopupDTO } from "@/types/api"

/**
 * Passo 3 — Pix confirmado. Decompõe o valor pago em quitação de dívida (se houve) + saldo livre, igual ao recibo de sessão (`SessaoDetalhe.tsx`) decompõe custo.
 * Momento de marca (D3): o mesmo gesto do recibo de recarga — o robô com o check lima (pop de um tiro só) sobre superfície escura.
 */
export function TopupSuccessCard({ topup, walletBalanceCents }: { topup: MeTopupDTO; walletBalanceCents: number | undefined }) {
  const freeCreditedCents = topup.amountCents - topup.debtSettledCents

  return (
    <div className="mx-auto flex max-w-md flex-col items-center pt-5 text-center">
      <div className="surface-dark surface-dark-rich flex w-full flex-col items-center rounded-feature px-6 pb-9 pt-8 shadow-tinted-card ring-1 ring-white/10">
        <span className="relative">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
            <MascotFace size={64} />
          </span>
          <CheckCircle2 className="animate-pop absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-night text-lime" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-xl font-black tracking-tight text-ink">Saldo adicionado!</h1>
        <p className="mt-1 text-sm text-ink-softer">Seu Pix de {formatCents(topup.amountCents)} foi confirmado.</p>
      </div>

      <Card className="animate-enter -mt-5 w-[calc(100%-1rem)] text-left">
        <CardContent className="p-5 sm:p-5">
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
              <dd className="text-lg font-black tracking-tight text-primary-700">{formatCents(walletBalanceCents)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="mt-6 flex w-full flex-col gap-2">
        <Link to="/app/carteira" className={buttonVariants({ variant: "lime", size: "lg", className: "w-full" })}>
          Ver carteira
        </Link>
        <Link to="/app" className={buttonVariants({ variant: "ghost", className: "w-full" })}>
          Voltar para o início
        </Link>
      </div>
    </div>
  )
}
