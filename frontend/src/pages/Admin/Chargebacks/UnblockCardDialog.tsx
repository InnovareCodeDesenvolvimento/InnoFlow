import { useState } from "react"
import { ArrowRight, CreditCard } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Textarea } from "@/components/ui/Textarea"
import { StepUpConfirmDialog } from "@/components/admin/StepUpConfirmDialog"
import { useUnblockCard } from "@/hooks/useReversals"
import { formatCents } from "@/lib/utils"
import { REFUND_REASON_MAX, toSingleLine, validateUnblockReason } from "@/lib/reversals"
import type { ChargebackDTO } from "@/types/api"

/**
 * Desbloquear o cartão do motorista depois de um chargeback PERDIDO/ACEITO (P3, caso a caso; ADMIN, step-up). Não apaga nada: registro, desfecho, dossiê e dívida ficam. É por
 * chargeback — se o motorista tem outro perdido, o bloqueio continua por ele. O motivo fica gravado (sem nome do motorista).
 */
export function UnblockCardDialog({ chargeback, onClose }: { chargeback: ChargebackDTO; onClose: () => void }) {
  const [step, setStep] = useState<"form" | "confirm">("form")
  const [reason, setReason] = useState("")
  const [showError, setShowError] = useState(false)
  const mutation = useUnblockCard()
  const reasonError = validateUnblockReason(reason)

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent widthClassName="sm:max-w-md">
          <DialogHeader icon={CreditCard}>
            <DialogTitle>Desbloquear cartão</DialogTitle>
            <DialogDescription>
              Caso {chargeback.caseReference} · {chargeback.status === "ACCEPTED" ? "aceito" : "perdido"}. O bloqueio só sai por este chargeback.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              setShowError(true)
              if (reasonError === null) setStep("confirm")
            }}
          >
            <Textarea
              label="Por que liberar o cartão?"
              required
              rows={3}
              maxLength={REFUND_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(toSingleLine(e.target.value))}
              error={showError ? (reasonError ?? undefined) : undefined}
              hint="De 10 a 500 caracteres. Não escreva o nome do motorista: o texto fica gravado."
            />
            <DialogFooter>
              <Button type="button" variant="ghost" size="touch" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" size="touch">
                Revisar
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {step === "confirm" && (
        <StepUpConfirmDialog
          title="Confirmar desbloqueio do cartão"
          description="O motorista volta a poder pagar com cartão. O chargeback, o desfecho, o dossiê e a dívida (se houver) continuam como estão."
          domain="chargeback"
          confirmLabel="Desbloquear cartão"
          items={[
            { key: "case", label: "Caso", to: chargeback.caseReference },
            { key: "amount", label: "Valor contestado", to: formatCents(chargeback.amountCents) },
            { key: "reason", label: "Motivo", to: reason.trim() },
          ]}
          run={async (currentPassword) => {
            try {
              await mutation.mutateAsync({ chargebackId: chargeback.id, reason: reason.trim(), currentPassword })
              toast.success("Cartão desbloqueado.", { description: "O desbloqueio fica registrado na auditoria." })
              onClose()
            } finally {
              mutation.reset()
            }
          }}
          onCancel={() => setStep("form")}
        />
      )}
    </>
  )
}
