import { useState } from "react"
import { ArrowRight, Info, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Textarea } from "@/components/ui/Textarea"
import { RadioCardGroup } from "@/components/admin/RadioCardGroup"
import { StepUpConfirmDialog } from "@/components/admin/StepUpConfirmDialog"
import { useCreateRefund } from "@/hooks/useReversals"
import { formatCents } from "@/lib/utils"
import {
  centsToInput,
  PARQUE_ALERT_NOTICE,
  REFUND_DESTINATION_HINTS,
  REFUND_DESTINATION_LABELS,
  REFUND_REASON_HINT,
  REFUND_REASON_MAX,
  PORTAL_REFERENCE_MAX,
  toSingleLine,
  validateRefund,
  type RefundDraft,
  type ReversalError,
} from "@/lib/reversals"
import type { RefundDestination, SessionDetail } from "@/types/api"

/** Erros de regra que mandam o ADMIN de volta ao formulário (o que ele digitou não vale mais); o resto fica na confirmação, com a senha. */
const BACK_TO_FORM = new Set(["AMOUNT_EXCEEDS_REFUNDABLE", "NO_CARD_PAYMENT", "DRIVER_ACCOUNT_DELETED", "SESSION_NOT_BILLED", "SESSION_NOT_FOUND", "VALIDATION_ERROR"])

export function ParqueAlertNotice() {
  return (
    <Alert tone="warning" size="sm" icon={Info} data-testid="parque-alert-notice">
      {PARQUE_ALERT_NOTICE}
    </Alert>
  )
}

/**
 * Estornar uma sessão paga (ADMIN, L1.8). Dois passos, porque é DINHEIRO: (1) preencher, (2) confirmar o resumo com a SENHA. O teto (`refundableCents`) é do servidor — a tela só
 * evita a ida e volta e, se outra devolução entrou no meio (409 `AMOUNT_EXCEEDS_REFUNDABLE`), volta ao formulário com o teto atualizado (a lista é refeita pelo hook).
 * O motivo não pode citar o motorista (fica gravado). Nada é enviado antes da confirmação com senha.
 */
export function RefundFormDialog({
  session,
  refundableCents,
  cardAvailable,
  onClose,
}: {
  session: SessionDetail
  refundableCents: number
  /** A sessão tem uma venda de cartão capturada (senão o servidor devolve `NO_CARD_PAYMENT`). */
  cardAvailable: boolean
  onClose: () => void
}) {
  const [step, setStep] = useState<"form" | "confirm">("form")
  const [draft, setDraft] = useState<RefundDraft>({ amountInput: centsToInput(refundableCents), reason: "", destination: "WALLET", portalReference: "" })
  const [showErrors, setShowErrors] = useState(false)
  const [formAlert, setFormAlert] = useState<string | null>(null)
  const mutation = useCreateRefund(session.id)

  const validation = validateRefund(draft, { refundableCents, driverName: session.driver.name, driverEmail: session.driver.email })
  const errors = showErrors ? validation.errors : {}
  const isCard = draft.destination === "CARD_VIA_PORTAL"
  const update = (patch: Partial<RefundDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setFormAlert(null)
  }

  const handleReview = () => {
    setShowErrors(true)
    setFormAlert(null)
    if (validation.valid) setStep("confirm")
  }

  const run = async (currentPassword: string) => {
    if (!validation.valid || validation.amountCents === null) return
    const portalReference = draft.portalReference.trim()
    try {
      const result = await mutation.mutateAsync({
        amountCents: validation.amountCents,
        reason: draft.reason.trim(),
        destination: draft.destination,
        ...(isCard && portalReference !== "" ? { portalReference } : {}),
        currentPassword,
      })
      toast.success(result.status === "CONFIRMED" ? `Estorno de ${formatCents(validation.amountCents)} creditado na carteira do motorista.` : "Devolução registrada.", {
        description: result.status === "CONFIRMED" ? undefined : "Fica aguardando a Cielo mostrar o estorno.",
      })
      onClose()
    } finally {
      // O corpo leva a senha: sai da memória do TanStack Query na hora (também no erro).
      mutation.reset()
    }
  }

  const handleFailure = (error: ReversalError): boolean => {
    if (!error.code || !BACK_TO_FORM.has(error.code)) return false
    setFormAlert(error.message)
    setShowErrors(true)
    setStep("form")
    return true
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent widthClassName="sm:max-w-lg">
          <DialogHeader icon={Undo2}>
            <DialogTitle>Estornar sessão #{session.ocppTransactionId}</DialogTitle>
            <DialogDescription>
              Ainda dá para estornar <strong className="tabular-nums text-ink">{formatCents(refundableCents)}</strong> desta sessão.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              handleReview()
            }}
          >
            {formAlert && (
              <Alert tone="danger" size="sm" role="alert">
                {formAlert}
              </Alert>
            )}

            <Input
              label="Valor (R$)"
              inputMode="decimal"
              autoComplete="off"
              required
              value={draft.amountInput}
              onChange={(e) => update({ amountInput: e.target.value })}
              leftIcon={<span className="text-sm font-semibold">R$</span>}
              className="pl-11"
              error={errors.amount}
              hint={`Máximo de ${formatCents(refundableCents)}. Pode ser parcial.`}
            />

            <RadioCardGroup<RefundDestination>
              legend="Devolver para"
              value={draft.destination}
              onChange={(destination) => update({ destination })}
              options={[
                { value: "WALLET", label: REFUND_DESTINATION_LABELS.WALLET, hint: REFUND_DESTINATION_HINTS.WALLET },
                {
                  value: "CARD_VIA_PORTAL",
                  label: REFUND_DESTINATION_LABELS.CARD_VIA_PORTAL,
                  hint: REFUND_DESTINATION_HINTS.CARD_VIA_PORTAL,
                  disabledReason: cardAvailable ? undefined : "Esta sessão não foi paga com cartão: não há venda na Cielo para devolver.",
                },
              ]}
            />

            {isCard && (
              <>
                <Input
                  label="Referência do estorno no portal (opcional)"
                  autoComplete="off"
                  maxLength={PORTAL_REFERENCE_MAX}
                  value={draft.portalReference}
                  onChange={(e) => update({ portalReference: toSingleLine(e.target.value) })}
                  error={errors.portalReference}
                  hint="O código que o portal da Cielo mostrou para este estorno, se houver."
                />
                <ParqueAlertNotice />
              </>
            )}

            <Textarea
              label="Motivo"
              required
              rows={3}
              maxLength={REFUND_REASON_MAX}
              placeholder="Ex.: carregador interrompeu a sessão com falha de energia"
              value={draft.reason}
              onChange={(e) => update({ reason: toSingleLine(e.target.value) })}
              error={errors.reason}
              hint={REFUND_REASON_HINT}
            />

            <DialogFooter>
              <Button type="button" variant="ghost" size="touch" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" size="touch">
                Revisar estorno
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {step === "confirm" && validation.amountCents !== null && (
        <StepUpConfirmDialog
          title="Confirmar estorno"
          description="Isto mexe em dinheiro e fica registrado na auditoria. Confira antes de seguir."
          domain="refund"
          confirmLabel="Registrar estorno"
          items={[
            { key: "session", label: "Sessão", to: `#${session.ocppTransactionId}` },
            { key: "amount", label: "Valor", to: formatCents(validation.amountCents) },
            { key: "destination", label: "Destino", to: REFUND_DESTINATION_LABELS[draft.destination] },
            ...(isCard && draft.portalReference.trim() ? [{ key: "portal", label: "Referência do portal", to: draft.portalReference.trim() }] : []),
            { key: "reason", label: "Motivo", to: draft.reason.trim() },
          ]}
          extra={isCard ? <ParqueAlertNotice /> : undefined}
          run={run}
          onFailure={handleFailure}
          onCancel={() => setStep("form")}
        />
      )}
    </>
  )
}
