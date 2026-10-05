import { useState } from "react"
import { ArrowRight, HandCoins, Info } from "lucide-react"
import { toast } from "sonner"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { StepUpConfirmDialog } from "@/components/admin/StepUpConfirmDialog"
import { CopyButton } from "@/pages/Admin/GatewayPagamento/CopyButton"
import { useRefundAccountDeletion } from "@/hooks/useAccountDeletions"
import { DELETION_PROOF_MAX, toSingleLine, validateDeletionProof, type ReversalError } from "@/lib/reversals"
import { formatCents } from "@/lib/utils"
import type { AdminAccountDeletionRow } from "@/types/api"

/** Erros que dizem "o pedido mudou desde que a lista carregou": a tela refaz a lista (uma leitura) para o ADMIN ver o estado de verdade. */
const STALE_CODES = new Set(["ALREADY_REFUNDED", "NOT_FOUND", "REFUND_NOT_REQUIRED", "AMOUNT_EXCEEDS_BALANCE", "PARTIAL_REFUND_NOT_ALLOWED"])

/**
 * Registrar a devolução do saldo de uma conta excluída (ADMIN, L1.4). O Pix é feito POR FORA (no app do banco); aqui se registra: valor INTEGRAL (não existe devolução parcial: o resto
 * ficaria numa carteira sem dono), comprovante e a senha. O servidor lança o `TOPUP_REFUND` e APAGA a chave Pix guardada. Dois passos, como todo dinheiro do Admin.
 */
export function RefundDeletionDialog({ row, onClose, onStale }: { row: AdminAccountDeletionRow; onClose: () => void; onStale: () => void }) {
  const [step, setStep] = useState<"form" | "confirm">("form")
  const [proof, setProof] = useState("")
  const [showError, setShowError] = useState(false)
  const mutation = useRefundAccountDeletion()
  const proofError = validateDeletionProof(proof)

  const handleFailure = (error: ReversalError): boolean => {
    if (error.code && STALE_CODES.has(error.code)) onStale()
    return false
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent widthClassName="sm:max-w-md">
          <DialogHeader icon={HandCoins}>
            <DialogTitle>Devolver saldo</DialogTitle>
            <DialogDescription>
              Faça o Pix de <strong className="tabular-nums text-ink">{formatCents(row.balanceCentsAtRequest)}</strong> no app do seu banco e registre aqui.
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
            {row.refundPixKey && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle p-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Chave Pix do titular</p>
                  <p className="break-all font-mono text-sm text-ink">{row.refundPixKey}</p>
                </div>
                <CopyButton value={row.refundPixKey} label="Copiar chave Pix" />
              </div>
            )}

            <Alert tone="info" size="sm" icon={Info}>
              A devolução é do saldo integral: o InnoFlow não aceita devolução parcial.
            </Alert>

            <Input
              label="Comprovante do Pix"
              required
              autoComplete="off"
              maxLength={DELETION_PROOF_MAX}
              value={proof}
              onChange={(e) => setProof(toSingleLine(e.target.value))}
              error={showError ? (proofError ?? undefined) : undefined}
              hint="O código ou identificador do Pix que você fez (até 120 caracteres). Não cole CPF nem número de cartão."
            />

            <DialogFooter>
              <Button type="button" variant="ghost" size="touch" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" size="touch">
                Revisar devolução
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {step === "confirm" && (
        <StepUpConfirmDialog
          title="Confirmar devolução do saldo"
          description="O Pix já foi feito? Registrar lança a devolução do saldo integral e apaga a chave Pix guardada. Não dá para desfazer."
          domain="deletion"
          confirmLabel="Registrar devolução"
          items={[
            { key: "amount", label: "Valor (saldo integral)", to: formatCents(row.balanceCentsAtRequest) },
            { key: "proof", label: "Comprovante", to: proof.trim() },
          ]}
          run={async (currentPassword) => {
            try {
              await mutation.mutateAsync({ requestId: row.id, amountCents: row.balanceCentsAtRequest, proofReference: proof.trim(), currentPassword })
              toast.success(`Devolução de ${formatCents(row.balanceCentsAtRequest)} registrada.`, { description: "A chave Pix foi apagada do servidor." })
              onClose()
            } finally {
              mutation.reset()
            }
          }}
          onFailure={handleFailure}
          onCancel={() => setStep("form")}
        />
      )}
    </>
  )
}
