import { type SelectHTMLAttributes, forwardRef, useId } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  label?: string
  error?: string
  options: SelectOption[]
  /** Texto do item vazio inicial (ex.: "Selecione..."). Omitido = sem opção vazia. */
  placeholder?: string
}

/**
 * `<select>` nativo estilizado, não Radix Select. Escolha deliberada: os
 * formulários admin desta fase são poucos e simples, e o `<select>` nativo já
 * dá teclado, leitor de tela e mobile de graça — sem puxar mais uma
 * dependência Radix para o mesmo resultado.
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, options, placeholder, id, required, ...props }, ref) => {
    const reactId = useId()
    const selectId = id ?? reactId
    const errorId = `${selectId}-error`

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={selectId} className="block text-sm font-medium text-ink-soft">
            {label} {required && <span className="text-danger">*</span>}
          </label>
        )}
        <div className="relative">
          <select
            id={selectId}
            ref={ref}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(
              "w-full appearance-none rounded-lg border border-border bg-surface px-3.5 py-2.5 pr-9 text-[16px] text-ink transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary disabled:bg-muted disabled:text-ink-subtle sm:text-sm",
              error && "border-danger focus:border-danger focus:ring-danger/30",
              className,
            )}
            {...props}
          >
            {placeholder && (
              <option value="" disabled={required}>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden="true"
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    )
  },
)
Select.displayName = "Select"

export { Select }
