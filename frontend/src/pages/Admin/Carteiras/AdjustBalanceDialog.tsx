import { useState } from "react"
import { ArrowLeft, ArrowRight, Check, HandCoins, MinusCircle, PlusCircle, ScrollText } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Textarea } from "@/components/ui/Textarea"
import { useWalletAdjustment } from "@/hooks/useDrivers"
import { getApiErrorCode } from "@/services/api"
import { formatCents, cn } from "@/lib/utils"
import {
  ADJUSTMENT_KIND_LABELS,
  adjustmentSummary,
  balanceAfter,
  toSignedCents,
  validateAdjustment,
  walletAdjustmentErrorMessage,
  WALLET_ADJUSTMENT_MAX_CENTS,
  WALLET_DESCRIPTION_MAX,
  WALLET_DESCRIPTION_MIN,
  type AdjustmentKind,
} from "@/lib/walletAdjustment"

/**
 * Ajuste manual de saldo (ADMIN-only — quem chama já decide mostrar o botão só
 * para ADMIN; o servidor confere de novo com `requireRole('ADMIN')`). É DINHEIRO
 * REAL, então são dois passos: (1) preencher, (2) CONFIRMAR uma frase
 * inequívoca — "Creditar R$ 50,00 para Fulano" — antes de qualquer envio.
 * O valor é convertido de texto pra centavos por aritmética de inteiros
 * (`lib/money.ts`), nunca por float.
 */
export function AdjustBalanceDialog({
  driver,
  balanceCents,
  onOpenChange,
}: {
  driver: { id: string; name: string }
  /** Saldo conhecido agora (do extrato aberto) — só pra pré-checar débito e mostrar a previsão. */
  balanceCents: number
  onOpenChange: (open: boolean) => void
}) {
  const [step, setStep] = useState<"form" | "confirm">("form")
  const [kind, setKind] = useState<AdjustmentKind>("credit")
  const [amountInput, setAmountInput] = useState("")
  const [description, setDescription] = useState("")
  const [showErrors, setShowErrors] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const mutation = useWalletAdjustment(driver.id)
  const validation = validateAdjustment({ kind, amountInput, description }, balanceCents)
  const errors = showErrors ? validation.errors : {}
  const amountCents = validation.amountCents ?? 0
  const isCredit = kind === "credit"

  const handleReview = () => {
    setShowErrors(true)
    setServerError(null)
    if (validation.valid) setStep("confirm")
  }

  const handleConfirm = async () => {
    if (!validation.valid || validation.amountCents === null || mutation.isPending) return
    setServerError(null)
    try {
      const entry = await mutation.mutateAsync({ amountCents: toSignedCents(kind, validation.amountCents), description: validation.description })
      toast.success(`${isCredit ? "Crédito" : "Débito"} de ${formatCents(validation.amountCents)} registrado.`, {
        description: `Novo saldo de ${driver.name}: ${formatCents(entry.balanceAfterCents)}.`,
      })
      onOpenChange(false)
    } catch (err) {
      setServerError(walletAdjustmentErrorMessage(getApiErrorCode(err)))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !mutation.isPending && onOpenChange(open)}>
      <DialogContent widthClassName="sm:max-w-md">
        <DialogHeader icon={HandCoins}>
          <DialogTitle>Ajustar saldo</DialogTitle>
          <DialogDescription>
            {driver.name} · saldo atual <strong className="tabular-nums text-ink">{formatCents(balanceCents)}</strong>
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              handleReview()
            }}
          >
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-ink-soft">Tipo do lançamento</legend>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo do lançamento">
                {(["credit", "debit"] as const).map((value) => {
                  const Icon = value === "credit" ? PlusCircle : MinusCircle
                  return (
                    <label key={value} className="relative cursor-pointer">
                      <input
                        type="radio"
                        name="adjustment-kind"
                        value={value}
                        checked={kind === value}
                        onChange={() => setKind(value)}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-bold transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2",
                          kind === value
                            ? value === "credit"
                              ? "border-success-600 bg-success-100 text-success-700"
                              : "border-danger-600 bg-danger-100 text-danger-700"
                            : "border-border bg-surface text-ink-softer hover:bg-muted",
                        )}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {ADJUSTMENT_KIND_LABELS[value]}
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>

            <Input
              label="Valor (R$)"
              inputMode="decimal"
              autoComplete="off"
              placeholder="50,00"
              required
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              leftIcon={<span className="text-sm font-semibold">R$</span>}
              className="pl-11"
              error={errors.amount}
              hint={`Máximo de ${formatCents(WALLET_ADJUSTMENT_MAX_CENTS)} por lançamento.`}
            />

            <Textarea
              label="Motivo"
              required
              rows={3}
              maxLength={WALLET_DESCRIPTION_MAX}
              placeholder="Ex.: saldo de teste para validação do fluxo de recarga"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              error={errors.description}
              hint={`Mínimo de ${WALLET_DESCRIPTION_MIN} caracteres.`}
            />

            <p className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-ink-softer">
              <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>O motivo fica registrado na auditoria, junto com o seu nome, o valor e o horário.</span>
            </p>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit">
                Revisar lançamento
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "confirm" && (
          <div className="space-y-4">
            <div className={cn("rounded-xl border p-4", isCredit ? "border-success-600/30 bg-success-50" : "border-danger-600/30 bg-danger-50")}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Confirme o lançamento</p>
              <p className="mt-1 text-lg font-black tracking-tight text-ink" data-testid="adjust-summary">
                {adjustmentSummary(kind, amountCents, driver.name)}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Saldo atual</dt>
                  <dd className="font-semibold tabular-nums text-ink">{formatCents(balanceCents)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Saldo previsto</dt>
                  <dd className="font-semibold tabular-nums text-ink" data-testid="adjust-balance-after">
                    {formatCents(balanceAfter(kind, amountCents, balanceCents))}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Motivo</dt>
                  <dd className="break-words text-ink-soft">{validation.description}</dd>
                </div>
              </dl>
            </div>

            <p className="text-xs leading-relaxed text-ink-softer">
              Isto altera o saldo REAL do motorista e fica registrado na auditoria. Não dá para desfazer — só compensar com um lançamento contrário.
            </p>

            {serverError && (
              <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
                {serverError}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setStep("form")}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Voltar
              </Button>
              <Button type="button" variant={isCredit ? "default" : "destructive"} loading={mutation.isPending} onClick={handleConfirm}>
                {!mutation.isPending && <Check className="h-4 w-4" aria-hidden="true" />}
                Confirmar {isCredit ? "crédito" : "débito"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
