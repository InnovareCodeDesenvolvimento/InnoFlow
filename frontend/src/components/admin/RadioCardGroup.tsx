import { type ReactNode, useId } from "react"
import { cn } from "@/lib/utils"

export interface RadioCardOption<T extends string> {
  value: T
  label: string
  /** Explicação sob o rótulo (o que acontece se escolher). */
  hint?: ReactNode
  /** Quando preenchido, a opção fica desabilitada e este texto explica por quê. */
  disabledReason?: string
}

/**
 * Grupo de rádio em cartões (uma opção por linha, com a explicação ao lado) — para escolhas que mudam o DINHEIRO ou o ESTADO e que o ADMIN precisa ler antes
 * ("Carteira" x "Cartão no portal", "Ganho" x "Perdido" x "Aceito"). `<input type="radio">` nativo escondido (`sr-only`): teclado (setas), leitor de tela e `name` de graça;
 * o foco aparece no cartão (`peer-focus-visible`). Alvo de toque >= 44 px (`min-h-11`). Mesmo vocabulário visual dos cartões do ajuste de saldo.
 */
export function RadioCardGroup<T extends string>({
  legend,
  value,
  options,
  onChange,
  disabled,
}: {
  legend: string
  value: T
  options: Array<RadioCardOption<T>>
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const name = useId()
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 block text-sm font-medium text-ink-soft">{legend}</legend>
      <div className="space-y-2" role="radiogroup" aria-label={legend}>
        {options.map((option) => {
          const checked = value === option.value
          const isDisabled = Boolean(option.disabledReason)
          const hintId = `${name}-${option.value}-hint`
          return (
            <label key={option.value} className={cn("relative block", isDisabled ? "cursor-not-allowed" : "cursor-pointer")}>
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                disabled={isDisabled}
                onChange={() => onChange(option.value)}
                aria-describedby={option.hint || option.disabledReason ? hintId : undefined}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "flex min-h-11 items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2",
                  checked ? "border-primary bg-primary/10" : "border-border bg-surface hover:bg-muted",
                  isDisabled && "opacity-60",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-primary" : "border-border")}
                >
                  {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-ink">{option.label}</span>
                  {(option.hint || option.disabledReason) && (
                    <span id={hintId} className="mt-0.5 block text-xs text-ink-softer">
                      {option.disabledReason ?? option.hint}
                    </span>
                  )}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
