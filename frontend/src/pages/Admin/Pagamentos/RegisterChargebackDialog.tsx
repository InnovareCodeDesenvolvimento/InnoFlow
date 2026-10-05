import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, CheckCircle2, Info, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { DossierButton } from "@/components/admin/DossierButton"
import { useRegisterChargeback } from "@/hooks/useReversals"
import { formatCents } from "@/lib/utils"
import {
  CASE_REFERENCE_MAX,
  centsToInput,
  CHARGEBACK_CARD_BLOCKED_NOTICE,
  CHARGEBACK_DEADLINE_HINT,
  deadlineDateToIso,
  noticeDateToIso,
  parseReversalError,
  PARQUE_ALERT_CHARGEBACK_NOTICE,
  REASON_CODE_MAX,
  todayInputValue,
  toSingleLine,
  validateChargeback,
  type ChargebackDraft,
} from "@/lib/reversals"
import type { CreateChargebackResponse, PaymentListRow } from "@/types/api"

/**
 * Registrar o chargeback que a Cielo avisou ao dono (ADMIN, L1.8). SEM senha (contrato): é o que abre o caso, e o desfecho `WON` (que pede senha) o desfaz. O efeito é grande e
 * imediato — o modo cartão do motorista é BLOQUEADO e o dossiê é gravado — então o formulário diz isso antes, e depois do registro mostra o que aconteceu e oferece o dossiê.
 */
export function RegisterChargebackDialog({ row, onClose }: { row: PaymentListRow; onClose: () => void }) {
  const capturedCents = row.amountCapturedCents ?? 0
  const [draft, setDraft] = useState<ChargebackDraft>({ amountInput: centsToInput(capturedCents), notifiedDate: todayInputValue(), caseReference: "", reasonCode: "", deadlineDate: "" })
  const [showErrors, setShowErrors] = useState(false)
  const [failure, setFailure] = useState<{ code: string | undefined; message: string; chargebackId?: string } | null>(null)
  const [done, setDone] = useState<CreateChargebackResponse | null>(null)
  const mutation = useRegisterChargeback()

  const validation = validateChargeback(draft, capturedCents)
  const errors = showErrors ? validation.errors : {}
  const update = (patch: Partial<ChargebackDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setFailure(null)
  }

  const handleSubmit = async () => {
    setShowErrors(true)
    setFailure(null)
    if (!validation.valid || validation.amountCents === null) return
    try {
      const result = await mutation.mutateAsync({
        paymentIntentId: row.id,
        amountCents: validation.amountCents,
        notifiedAt: noticeDateToIso(draft.notifiedDate),
        caseReference: draft.caseReference.trim(),
        ...(draft.reasonCode.trim() ? { reasonCode: draft.reasonCode.trim() } : {}),
        ...(draft.deadlineDate ? { responseDeadline: deadlineDateToIso(draft.deadlineDate) } : {}),
      })
      toast.success("Chargeback registrado.")
      setDone(result)
    } catch (err) {
      const parsed = parseReversalError(err, "chargeback")
      setFailure({ code: parsed.code, message: parsed.message })
    } finally {
      mutation.reset()
    }
  }

  if (done) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent widthClassName="sm:max-w-md">
          <DialogHeader icon={CheckCircle2}>
            <DialogTitle>Chargeback registrado</DialogTitle>
            <DialogDescription>
              Caso {draft.caseReference.trim()} · {formatCents(validation.amountCents)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Alert tone="warning" size="sm" icon={ShieldAlert} role="status" data-testid="chargeback-card-blocked">
              {CHARGEBACK_CARD_BLOCKED_NOTICE}
            </Alert>
            <Alert tone="info" size="sm" icon={Info}>
              {PARQUE_ALERT_CHARGEBACK_NOTICE}
            </Alert>
            <p className="text-sm text-ink-soft">O dossiê já foi gravado. Baixe-o para anexar à sua resposta no portal da Cielo e registre o desfecho quando houver.</p>
          </div>
          <DialogFooter>
            <Link to="/admin/chargebacks" className={buttonVariants({ variant: "ghost", size: "touch" })} onClick={onClose}>
              Ver chargebacks
            </Link>
            <DossierButton chargebackId={done.chargebackId} caseReference={draft.caseReference.trim()} size="touch" />
            <Button type="button" size="touch" onClick={onClose}>
              Concluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent widthClassName="sm:max-w-lg">
        <DialogHeader icon={ShieldAlert}>
          <DialogTitle>Registrar chargeback</DialogTitle>
          <DialogDescription>
            Venda de {row.userName} · capturado <strong className="tabular-nums text-ink">{formatCents(capturedCents)}</strong>
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <Alert tone="warning" size="sm" icon={ShieldAlert}>
            Ao registrar, o modo cartão deste motorista é bloqueado na hora (Pix e carteira continuam) e o dossiê da venda é gravado. Só o desfecho “Ganho” libera o cartão sozinho.
          </Alert>

          {failure && (
            <Alert tone="danger" size="sm" role="alert">
              {failure.message}{" "}
              {failure.code === "CHARGEBACK_ALREADY_REGISTERED" && (
                <Link to="/admin/chargebacks" className="font-semibold underline" onClick={onClose}>
                  Ver chargebacks
                </Link>
              )}
            </Alert>
          )}

          <Input
            label="Valor contestado (R$)"
            inputMode="decimal"
            autoComplete="off"
            required
            value={draft.amountInput}
            onChange={(e) => update({ amountInput: e.target.value })}
            leftIcon={<span className="text-sm font-semibold">R$</span>}
            className="pl-11"
            error={errors.amount}
            hint={`No máximo o capturado: ${formatCents(capturedCents)}.`}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Data do aviso da Cielo"
              type="date"
              required
              max={todayInputValue()}
              value={draft.notifiedDate}
              onChange={(e) => update({ notifiedDate: e.target.value })}
              error={errors.notifiedDate}
            />
            <Input label="Prazo de resposta" type="date" value={draft.deadlineDate} onChange={(e) => update({ deadlineDate: e.target.value })} error={errors.deadlineDate} />
          </div>
          <p className="-mt-2 text-xs text-ink-softer">{CHARGEBACK_DEADLINE_HINT}</p>

          <Input
            label="Referência do caso na Cielo"
            required
            autoComplete="off"
            maxLength={CASE_REFERENCE_MAX}
            value={draft.caseReference}
            onChange={(e) => update({ caseReference: toSingleLine(e.target.value) })}
            error={errors.caseReference}
          />
          <Input
            label="Código do motivo (opcional)"
            autoComplete="off"
            maxLength={REASON_CODE_MAX}
            value={draft.reasonCode}
            onChange={(e) => update({ reasonCode: toSingleLine(e.target.value) })}
            error={errors.reasonCode}
            hint="O código que a Cielo informou, se houver."
          />

          <DialogFooter>
            <Button type="button" variant="ghost" size="touch" disabled={mutation.isPending} onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" size="touch" loading={mutation.isPending}>
              {!mutation.isPending && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              Registrar chargeback
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
