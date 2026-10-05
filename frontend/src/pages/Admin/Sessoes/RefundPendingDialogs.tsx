import { useState } from "react"
import { ArrowRight, BadgeCheck } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { StepUpConfirmDialog } from "@/components/admin/StepUpConfirmDialog"
import { useCancelRefund, useConfirmRefund } from "@/hooks/useReversals"
import { formatCents, formatDateTime } from "@/lib/utils"
import { PROOF_REFERENCE_MAX, validateProofReference } from "@/lib/reversals"
import type { SessionRefundDTO } from "@/types/api"

/** Resumo da devolução pendente, igual nos dois diálogos (valor, quando foi registrada, referência do portal e o motivo). */
function refundItems(refund: SessionRefundDTO) {
  return [
    { key: "amount", label: "Valor", to: formatCents(refund.amountCents) },
    { key: "createdAt", label: "Registrada em", to: formatDateTime(refund.createdAt) },
    ...(refund.portalReference ? [{ key: "portal", label: "Referência do portal", to: refund.portalReference }] : []),
    { key: "reason", label: "Motivo", to: refund.reason },
  ]
}

/**
 * "Confirmar à mão" (runbook §1.4): a devolução no cartão que o sistema NÃO consegue confirmar sozinho (estorno parcial, ou venda com mais de ~3 meses). Só quem VIU o estorno
 * no portal/extrato da Cielo confirma — por isso a referência do comprovante é obrigatória (e validada como CÓDIGO: sem espaço, e-mail, CPF ou número de cartão).
 */
export function ConfirmRefundDialog({ sessionId, refund, onClose }: { sessionId: string; refund: SessionRefundDTO; onClose: () => void }) {
  const [step, setStep] = useState<"form" | "confirm">("form")
  const [proof, setProof] = useState("")
  const [showError, setShowError] = useState(false)
  const mutation = useConfirmRefund(sessionId)
  const proofError = validateProofReference(proof)

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent widthClassName="sm:max-w-md">
          <DialogHeader icon={BadgeCheck}>
            <DialogTitle>Confirmar devolução à mão</DialogTitle>
            <DialogDescription>
              Use quando a devolução de {formatCents(refund.amountCents)} no cartão é parcial ou a venda tem mais de 3 meses: o sistema não confirma essas sozinho.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              setShowError(true)
              if (proofError === null) setStep("confirm")
            }}
          >
            <Input
              label="Referência do comprovante no portal da Cielo"
              required
              autoComplete="off"
              maxLength={PROOF_REFERENCE_MAX}
              value={proof}
              onChange={(e) => setProof(e.target.value)}
              error={showError ? (proofError ?? undefined) : undefined}
              hint="De 5 a 120 caracteres: letras, números e . _ - / # : — sem espaço. Não cole nome, CPF nem número de cartão."
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
          title="Confirmar devolução à mão"
          description="Você viu o estorno no portal ou no extrato da Cielo? Só então confirme. O valor não muda e a conciliação financeira também não."
          domain="refund"
          confirmLabel="Confirmar devolução"
          items={[...refundItems(refund), { key: "proof", label: "Comprovante", to: proof.trim() }]}
          run={async (currentPassword) => {
            try {
              await mutation.mutateAsync({ refundId: refund.id, proofReference: proof.trim(), currentPassword })
              toast.success("Devolução confirmada à mão.")
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

/**
 * "Cancelar registro": só desfaz o REGISTRO no InnoFlow (digitou errado, desistiu, o estorno nunca foi feito no portal) e libera o valor para estornar de novo. Não fala com a
 * Cielo. Se o estorno JÁ foi feito no portal, o caminho certo é confirmar à mão — cancelar liberaria o teto indevidamente.
 */
export function CancelRefundDialog({ sessionId, refund, onClose }: { sessionId: string; refund: SessionRefundDTO; onClose: () => void }) {
  const mutation = useCancelRefund(sessionId)
  return (
    <StepUpConfirmDialog
      title="Cancelar registro da devolução"
      description="Só cancele se o estorno NÃO foi feito no portal da Cielo. Se foi feito, use “Confirmar à mão”: cancelar libera o valor para estornar de novo."
      domain="refund"
      confirmLabel="Cancelar registro"
      cancelLabel="Voltar"
      destructive
      items={refundItems(refund)}
      run={async (currentPassword) => {
        try {
          await mutation.mutateAsync({ refundId: refund.id, currentPassword })
          toast.success("Registro cancelado. O valor voltou a ficar disponível para estorno.")
          onClose()
        } finally {
          mutation.reset()
        }
      }}
      onCancel={onClose}
    />
  )
}
