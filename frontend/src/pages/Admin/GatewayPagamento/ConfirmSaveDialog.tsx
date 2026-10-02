import { ArrowRight, Check, ShieldCheck, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import type { ChangeSummaryItem } from "@/lib/paymentGateway"

/**
 * Resumo do que vai ser enviado, antes do PUT. Segredos aparecem só como
 * "Será substituída" — o valor digitado nunca é renderizado aqui (nem em
 * atributo). `goesToProduction` acrescenta o aviso de cobrança real.
 */
export function ConfirmSaveDialog({
  items,
  goesToProduction,
  loading,
  onConfirm,
  onCancel,
}: {
  items: ChangeSummaryItem[]
  goesToProduction: boolean
  loading: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !loading && onCancel()}>
      <DialogContent widthClassName="sm:max-w-lg">
        <DialogHeader icon={ShieldCheck}>
          <DialogTitle>Confirmar alterações no gateway</DialogTitle>
          <DialogDescription>Revise o que será enviado ao servidor. Segredos nunca são exibidos.</DialogDescription>
        </DialogHeader>

        <dl className="divide-y divide-border-subtle rounded-xl border border-border bg-surface" data-testid="save-summary">
          {items.map((item) => (
            <div key={item.key} className="flex flex-col gap-0.5 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <dt className="text-sm font-medium text-ink-soft">{item.label}</dt>
              <dd className="min-w-0 break-words text-sm font-semibold text-ink sm:text-right">
                {item.from !== undefined && (
                  <>
                    <span className="font-normal text-ink-softer">{item.from}</span>
                    <ArrowRight className="mx-1.5 inline h-3.5 w-3.5 text-ink-subtle" aria-label="para" />
                  </>
                )}
                <span className={item.secret ? "italic" : undefined}>{item.to}</span>
              </dd>
            </div>
          ))}
        </dl>

        {goesToProduction && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Depois de salvar, a plataforma passa a cobrar de verdade (cartões e Pix reais).</span>
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
            <X className="h-4 w-4" aria-hidden="true" />
            Cancelar
          </Button>
          <Button type="button" variant={goesToProduction ? "destructive" : "default"} loading={loading} onClick={onConfirm}>
            {!loading && <Check className="h-4 w-4" aria-hidden="true" />}
            Confirmar e salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
