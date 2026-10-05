import { useState } from "react"
import { ArrowRight, Gavel, Info } from "lucide-react"
import { toast } from "sonner"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { RadioCardGroup } from "@/components/admin/RadioCardGroup"
import { StepUpConfirmDialog } from "@/components/admin/StepUpConfirmDialog"
import { useResolveChargeback } from "@/hooks/useReversals"
import { formatCents } from "@/lib/utils"
import { CHARGEBACK_DEBT_HINT, CHARGEBACK_OUTCOME_HINTS, CHARGEBACK_STATUS_LABELS } from "@/lib/reversals"
import type { ChargebackDTO, ChargebackOutcome } from "@/types/api"

const OUTCOMES: ChargebackOutcome[] = ["WON", "LOST", "ACCEPTED"]

/**
 * Desfecho do chargeback (ADMIN, step-up). Dado UMA vez, não se refaz (409 `CHARGEBACK_ALREADY_RESOLVED`) — a tela avisa antes de pedir a senha.
 *  - Ganho: libera o cartão do motorista. Sem dívida.
 *  - Perdido/Aceito: a plataforma ABSORVE e o cartão continua bloqueado; "Criar dívida para o motorista" é ação manual, caso a caso (`debtPolicy: "CREATE_DEBT"`); desmarcado = `ABSORB`.
 */
export function ResolveChargebackDialog({ chargeback, onClose }: { chargeback: ChargebackDTO; onClose: () => void }) {
  const [step, setStep] = useState<"form" | "confirm">("form")
  const [outcome, setOutcome] = useState<ChargebackOutcome>("WON")
  const [createDebt, setCreateDebt] = useState(false)
  const mutation = useResolveChargeback()

  const lost = outcome !== "WON"
  const debt = lost && createDebt

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent widthClassName="sm:max-w-lg">
          <DialogHeader icon={Gavel}>
            <DialogTitle>Registrar desfecho</DialogTitle>
            <DialogDescription>
              Caso {chargeback.caseReference} · {formatCents(chargeback.amountCents)}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              setStep("confirm")
            }}
          >
            <RadioCardGroup<ChargebackOutcome>
              legend="Como terminou a disputa?"
              value={outcome}
              onChange={(value) => {
                setOutcome(value)
                if (value === "WON") setCreateDebt(false)
              }}
              options={OUTCOMES.map((value) => ({ value, label: CHARGEBACK_STATUS_LABELS[value], hint: CHARGEBACK_OUTCOME_HINTS[value] }))}
            />

            {lost && (
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
                <input type="checkbox" checked={createDebt} onChange={(e) => setCreateDebt(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-ink">Criar dívida para o motorista</span>
                  <span className="mt-0.5 block text-xs text-ink-softer">{CHARGEBACK_DEBT_HINT}</span>
                </span>
              </label>
            )}

            <Alert tone="info" size="sm" icon={Info}>
              {outcome === "WON" ? "O modo cartão do motorista volta sozinho." : "O modo cartão do motorista continua bloqueado. Você pode desbloqueá-lo depois, caso a caso."}
            </Alert>

            <DialogFooter>
              <Button type="button" variant="ghost" size="touch" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" size="touch">
                Revisar desfecho
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {step === "confirm" && (
        <StepUpConfirmDialog
          title="Confirmar desfecho"
          description="Depois de registrado, o desfecho não pode ser refeito."
          domain="chargeback"
          confirmLabel="Registrar desfecho"
          destructive={debt}
          items={[
            { key: "case", label: "Caso", to: chargeback.caseReference },
            { key: "amount", label: "Valor contestado", to: formatCents(chargeback.amountCents) },
            { key: "outcome", label: "Desfecho", to: CHARGEBACK_STATUS_LABELS[outcome] },
            ...(lost ? [{ key: "debt", label: "Dívida do motorista", to: debt ? `Criar dívida de ${formatCents(chargeback.amountCents)}` : "Não — a plataforma absorve" }] : []),
            { key: "card", label: "Cartão do motorista", to: lost ? "Continua bloqueado (dá para desbloquear depois, caso a caso)" : "Volta a ser liberado" },
          ]}
          run={async (currentPassword) => {
            try {
              await mutation.mutateAsync({ chargebackId: chargeback.id, outcome, ...(lost ? { debtPolicy: debt ? "CREATE_DEBT" : "ABSORB" } : {}), currentPassword })
              toast.success(`Desfecho registrado: ${CHARGEBACK_STATUS_LABELS[outcome]}.`)
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
