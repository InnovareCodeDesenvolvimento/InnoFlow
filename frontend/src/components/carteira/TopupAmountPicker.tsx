import { useState } from "react"
import { AlertTriangle, QrCode } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { cn, formatCents } from "@/lib/utils"
import { onlyDigits, formatCpf, isValidCpf } from "@/lib/cpf"
import { TOPUP_SUGGESTED_AMOUNTS_CENTS, debtWarningMessage, freeBalancePreviewCents, validateTopupAmount } from "@/lib/topupAmount"

/**
 * Passo 1 do fluxo de recarga Pix — escolher o valor (chip ou livre),
 * ver o efeito da dívida (se houver) e confirmar. CPF é OPCIONAL (D3 em
 * aberto com o dono, ver PROGRESSO.md) — o campo existe mas nunca bloqueia o
 * envio sozinho, só quando preenchido e mal formatado.
 */
export function TopupAmountPicker({
  openDebtCents,
  loading,
  serverError,
  onSubmit,
}: {
  openDebtCents: number
  loading: boolean
  serverError?: string | null
  onSubmit: (amountCents: number, cpf: string | undefined) => void
}) {
  const [selectedChipCents, setSelectedChipCents] = useState<number | null>(null)
  const [amountInput, setAmountInput] = useState("")
  const [cpfInput, setCpfInput] = useState("")
  const [showErrors, setShowErrors] = useState(false)

  const amountValidation = validateTopupAmount(selectedChipCents, amountInput)
  const cpfDigits = onlyDigits(cpfInput)
  const cpfError = cpfDigits !== "" && !isValidCpf(cpfDigits) ? "CPF inválido — confira os números." : undefined
  const errors = showErrors ? { amount: amountValidation.error, cpf: cpfError } : {}

  const debtMessage = debtWarningMessage(amountValidation.amountCents, openDebtCents)
  const freeBalanceCents = freeBalancePreviewCents(amountValidation.amountCents, openDebtCents)

  const handleSelectChip = (cents: number) => {
    setSelectedChipCents(cents)
    setAmountInput("")
  }

  const handleCustomAmountChange = (value: string) => {
    setAmountInput(value)
    setSelectedChipCents(null)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setShowErrors(true)
    if (!amountValidation.valid || amountValidation.amountCents === null) return
    if (cpfDigits !== "" && !isValidCpf(cpfDigits)) return
    onSubmit(amountValidation.amountCents, cpfDigits === "" ? undefined : cpfDigits)
  }

  return (
    <form className="space-y-5" noValidate onSubmit={handleSubmit}>
      <fieldset>
        <legend className="mb-2 block text-sm font-bold text-ink">Quanto você quer adicionar?</legend>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Valores sugeridos">
          {TOPUP_SUGGESTED_AMOUNTS_CENTS.map((cents) => (
            <label key={cents} className="relative cursor-pointer">
              <input
                type="radio"
                name="topup-amount-chip"
                value={cents}
                checked={selectedChipCents === cents}
                onChange={() => handleSelectChip(cents)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "flex min-h-12 items-center justify-center rounded-[var(--field-radius)] border text-base font-bold transition-[transform,background-color,border-color] duration-150 active:scale-[0.97] peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-2",
                  selectedChipCents === cents
                    ? "border-primary bg-primary/10 text-primary-700 shadow-tinted"
                    : "border-border bg-surface text-ink-softer hover:bg-muted",
                )}
              >
                {formatCents(cents)}
              </span>
            </label>
          ))}
        </div>

        <div className="mt-4">
          <Input
            label="Ou digite outro valor (R$)"
            inputMode="decimal"
            autoComplete="off"
            placeholder="35,00"
            value={amountInput}
            onChange={(e) => handleCustomAmountChange(e.target.value)}
            leftIcon={<span className="text-sm font-semibold">R$</span>}
            error={errors.amount}
            hint={!errors.amount ? "De R$ 10,00 a R$ 500,00." : undefined}
          />
        </div>
      </fieldset>

      {debtMessage && (
        <div className="animate-fade-in-up flex items-start gap-2.5 rounded-2xl bg-warning-50 px-4 py-3.5">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-600" aria-hidden="true" />
          <div>
            <p className="text-sm font-bold text-warning-700">{debtMessage}</p>
            <p className="mt-0.5 text-xs text-warning-600">Saldo livre depois do pagamento: {formatCents(freeBalanceCents)}.</p>
          </div>
        </div>
      )}

      <Input
        label="CPF (opcional)"
        inputMode="numeric"
        autoComplete="off"
        placeholder="000.000.000-00"
        value={formatCpf(cpfInput)}
        onChange={(e) => setCpfInput(e.target.value)}
        error={errors.cpf}
        hint={!errors.cpf ? "Só se o Pix pedir — a maioria das recargas não precisa." : undefined}
      />

      {serverError && (
        <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
          {serverError}
        </p>
      )}

      <Button type="submit" variant="lime" size="lg" className="w-full" loading={loading} disabled={loading}>
        {!loading && <QrCode className="h-4 w-4" aria-hidden="true" />}
        Gerar código Pix
      </Button>
    </form>
  )
}
