import { useState } from "react"
import { toast } from "sonner"
import { Check, Clock, Copy, Loader2, QrCode } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { TopupCountdown } from "./TopupCountdown"
import type { MeTopupDTO } from "@/types/api"

/**
 * Passo 2 — Pix gerado, aguardando o motorista pagar. `useMeTopup` (polling,
 * ver o hook) é quem detecta a mudança de status; este componente só exibe o
 * que já veio em `topup`.
 */
export function TopupPendingCard({ topup }: { topup: MeTopupDTO }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!topup.qrCodeString) return
    try {
      await navigator.clipboard.writeText(topup.qrCodeString)
      setCopied(true)
      toast.success("Código Pix copiado.")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Não foi possível copiar. Selecione o código manualmente.")
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-8 text-center">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-50 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-warning-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Aguardando pagamento
      </span>

      <h1 className="mt-4 text-lg font-black tracking-tight text-ink">Escaneie o QR code Pix</h1>
      <p className="mt-1 text-sm text-ink-softer">Abra o app do seu banco e escaneie, ou use o código copia e cola abaixo.</p>

      <Card className="card-premium animate-fade-in-up mt-5 w-full">
        <CardContent className="flex flex-col items-center p-5">
          {topup.qrCodeImageBase64 ? (
            <img
              src={`data:image/png;base64,${topup.qrCodeImageBase64}`}
              alt="QR code Pix para pagar a recarga de saldo"
              className="h-56 w-56 rounded-xl border border-border-subtle bg-white p-2"
            />
          ) : (
            <div className="flex h-56 w-56 items-center justify-center rounded-xl border border-dashed border-border-strong text-ink-subtle" aria-hidden="true">
              <QrCode className="h-10 w-10" />
            </div>
          )}

          <div className="mt-4 w-full rounded-xl bg-muted px-3.5 py-2.5 text-left">
            <p className="text-[10px] font-bold uppercase tracking-wide text-ink-subtle">Pix copia e cola</p>
            <p className="mt-0.5 truncate text-xs text-ink-softer" title={topup.qrCodeString ?? undefined}>
              {topup.qrCodeString ?? "Indisponível"}
            </p>
          </div>

          <Button type="button" variant="outline" className="mt-3 w-full" onClick={handleCopy} disabled={!topup.qrCodeString}>
            {copied ? <Check className="h-4 w-4 text-success-600" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copied ? "Copiado" : "Copiar código"}
          </Button>
        </CardContent>
      </Card>

      {topup.expiresAt && (
        <p className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-ink-softer">
          <Clock className="h-4 w-4" aria-hidden="true" />
          Expira em <span className="tabular-nums text-ink"><TopupCountdown expiresAt={topup.expiresAt} /></span>
        </p>
      )}

      <p className="mt-2 text-xs text-ink-subtle">Assim que o pagamento for confirmado, esta tela atualiza sozinha.</p>
    </div>
  )
}
