import { forwardRef, type ButtonHTMLAttributes } from "react"
import { cn } from "@/lib/utils"

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "type"> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

/**
 * Interruptor (WAI-ARIA `role="switch"`): um botão com `aria-checked`, ativável
 * por Espaço/Enter como qualquer botão. O nome acessível vem de quem usa
 * (`aria-labelledby`/`aria-label`). A área de toque é ampliada com um
 * pseudo-elemento (o trilho visual é 44×24, o alvo clicável passa de 44px).
 */
const Switch = forwardRef<HTMLButtonElement, SwitchProps>(({ checked, onCheckedChange, className, disabled, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors before:absolute before:-inset-2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      // "desligado" em ink-softer (≈4,8:1 com branco): border-strong (#D1D5DB) some no fundo claro (1,5:1, reprova o 3:1 de componente de UI).
      checked ? "bg-accent" : "bg-state-off",
      className,
    )}
    {...props}
  >
    <span
      aria-hidden="true"
      className={cn("pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-5" : "translate-x-0.5")}
    />
  </button>
))
Switch.displayName = "Switch"

export { Switch }
