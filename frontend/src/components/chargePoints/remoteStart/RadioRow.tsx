import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Linha de escolha única (radio nativo + visual de cartão): teclado e leitor de tela de graça (setas dentro do grupo), alvo de 44 px, foco visível por `peer-focus-visible`.
 * O `<input>` é `sr-only` e o `<label>` inteiro é o alvo. Desabilitada: fundo `muted` e texto `ink-softer` (nada de opacidade, que derrubaria o contraste) — o MOTIVO de estar
 * desabilitada vai escrito dentro da linha (`children`), não só na cor.
 */
export function RadioRow({
  name,
  value,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string
  value: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
  children: ReactNode
}) {
  return (
    <label className={cn("relative block", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} className="peer sr-only" />
      <span
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2",
          disabled ? "border-border-subtle bg-muted text-ink-softer" : checked ? "border-primary bg-primary/5 text-ink" : "border-border bg-surface text-ink hover:bg-muted",
        )}
      >
        <span
          aria-hidden="true"
          className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2", checked ? "border-primary" : "border-border")}
        >
          {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        <span className="min-w-0 flex-1">{children}</span>
      </span>
    </label>
  )
}
