import { type TextareaHTMLAttributes, forwardRef, useId } from "react"
import { cn } from "@/lib/utils"

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
}

/** Área de texto no mesmo padrão do `Input`: label associado, erro (`role="alert"`, `aria-describedby`) e dica. */
const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, label, error, hint, id, required, ...props }, ref) => {
  const reactId = useId()
  const textareaId = id ?? reactId
  const errorId = `${textareaId}-error`
  const hintId = `${textareaId}-hint`

  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label htmlFor={textareaId} className="block text-sm font-medium text-ink-soft">
          {label} {required && <span className="text-danger">*</span>}
        </label>
      )}
      <textarea
        id={textareaId}
        ref={ref}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(error && errorId, hint && hintId) || undefined}
        className={cn(
          // text-[16px] evita zoom automático do iOS ao focar o campo
          "min-h-20 w-full resize-y rounded-[var(--field-radius)] border border-border bg-surface px-3.5 py-2.5 text-[16px] text-ink transition-colors placeholder:text-ink-subtle focus:outline-none focus:ring-2 focus:ring-focus/40 focus:border-focus disabled:bg-muted disabled:text-ink-subtle sm:text-sm",
          error && "border-danger focus:border-danger focus:ring-danger/30",
          className,
        )}
        {...props}
      />
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
})
Textarea.displayName = "Textarea"

export { Textarea }
