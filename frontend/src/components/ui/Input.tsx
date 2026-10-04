import { type InputHTMLAttributes, forwardRef, useId } from "react"
import { cn } from "@/lib/utils"

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
}

/** Campo de texto com label associado, mensagem de erro (`role="alert"`, `aria-describedby`) e dica opcional. */
const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, leftIcon, id, required, ...props }, ref) => {
    const reactId = useId()
    const inputId = id ?? reactId
    const errorId = `${inputId}-error`
    const hintId = `${inputId}-hint`

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-ink-soft">
            {label} {required && <span className="text-danger">*</span>}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-softer">
              {leftIcon}
            </div>
          )}
          <input
            id={inputId}
            ref={ref}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={cn(error && errorId, hint && hintId) || undefined}
            className={cn(
              // text-[16px] evita zoom automático do iOS ao focar o campo
              "w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[16px] text-ink transition-colors placeholder:text-ink-subtle focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary disabled:bg-muted disabled:text-ink-subtle sm:text-sm",
              leftIcon && "pl-10",
              error && "border-danger focus:border-danger focus:ring-danger/30",
              className,
            )}
            {...props}
          />
        </div>
        {hint && !error && (
          <p id={hintId} className="text-xs text-ink-softer">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    )
  },
)
Input.displayName = "Input"

export { Input }
