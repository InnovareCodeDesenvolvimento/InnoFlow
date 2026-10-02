import { type ReactNode, useId } from "react"
import { CheckCircle2, CircleDashed, KeyRound, Undo2 } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"

/**
 * Campo de SEGREDO (só de escrita). O servidor nunca devolve o valor — só se
 * existe (`isSet`) —, então este campo NUNCA é pré-preenchido: mostra um chip
 * "Configurada"/"Não configurada" e, só se o admin clicar em Substituir,
 * revela um input vazio.
 *  - `value === undefined` → admin não mexeu (nada será enviado);
 *  - `value` string (mesmo "") → admin está substituindo.
 * `type="password"` + `autoComplete="new-password"` impedem o gerenciador de
 * senhas do navegador de preencher/oferecer salvar. `revealed` troca para
 * texto simples (só o segredo recém-GERADO, que o admin precisa copiar).
 */
export function SecretField({
  name,
  isSet,
  value,
  onChange,
  revealed = false,
  error,
  hint,
  actions,
  testId,
}: {
  /** Nome legível do segredo ("MerchantKey"). */
  name: string
  isSet: boolean
  value: string | undefined
  onChange: (value: string | undefined) => void
  revealed?: boolean
  error?: string
  hint?: string
  /** Botões extras ao lado do input (ex.: gerar/copiar). */
  actions?: ReactNode
  testId: string
}) {
  const headingId = useId()
  const replacing = value !== undefined

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span id={headingId} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft">
            <KeyRound className="h-3.5 w-3.5 text-ink-subtle" aria-hidden="true" />
            {name}
          </span>
          {isSet ? (
            <Badge variant="success" className="whitespace-nowrap">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Configurada
            </Badge>
          ) : (
            <Badge variant="warning" className="whitespace-nowrap">
              <CircleDashed className="h-3 w-3" aria-hidden="true" />
              Não configurada
            </Badge>
          )}
        </div>
        {replacing ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            Cancelar
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange("")} aria-label={`${isSet ? "Substituir" : "Informar"} ${name}`}>
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            {isSet ? "Substituir" : "Informar"}
          </Button>
        )}
      </div>

      {replacing && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <Input
              type={revealed ? "text" : "password"}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              aria-labelledby={headingId}
              placeholder={isSet ? "Digite o novo valor" : "Digite o valor"}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              error={error}
              hint={hint}
              className={revealed ? "font-mono" : undefined}
            />
          </div>
          {actions}
        </div>
      )}

      {!replacing && !isSet && hint && <p className="text-xs text-ink-softer">{hint}</p>}
    </div>
  )
}
