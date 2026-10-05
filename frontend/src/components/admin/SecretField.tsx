import { type ReactNode, useId } from "react"
import { CheckCircle2, CircleDashed, KeyRound, ShieldAlert, Undo2 } from "lucide-react"
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
 * `unreadable` (F5.7): o servidor tem o segredo salvo mas não consegue decifrá-lo —
 * o chip deixa de ser o verde de "Configurada" e passa a "Configurada (ilegível)" em
 * perigo (não é só cor: o texto e o ícone mudam).
 * `type="password"` + `autoComplete="new-password"` impedem o gerenciador de
 * senhas do navegador de preencher/oferecer salvar. `revealed` troca para
 * texto simples (só o segredo recém-GERADO, que o admin precisa copiar).
 */
export function SecretField({
  name,
  isSet,
  unreadable = false,
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
  /** `true` = salvo, porém ilegível no servidor (`secretsDecryptable === false`). Só faz sentido com `isSet`. */
  unreadable?: boolean
  value: string | undefined
  onChange: (value: string | undefined) => void
  revealed?: boolean
  error?: string
  hint?: string
  /** Botões extras ao lado do input (ex.: gerar/copiar). */
  actions?: ReactNode
  testId: string
}) {
  const inputId = useId()
  const replacing = value !== undefined

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* <label> de verdade (htmlFor): o nome acessível do campo vem dele quando o campo existe; antes era aria-labelledby num <span> e o axe acusava `label-title-only`. */}
          <label htmlFor={inputId} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft">
            <KeyRound className="h-3.5 w-3.5 text-ink-subtle" aria-hidden="true" />
            {name}
          </label>
          {isSet && unreadable ? (
            <Badge variant="danger" data-testid={`${testId}-chip`}>
              <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              Configurada (ilegível)
            </Badge>
          ) : isSet ? (
            <Badge variant="success" data-testid={`${testId}-chip`}>
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Configurada
            </Badge>
          ) : (
            <Badge variant="warning" data-testid={`${testId}-chip`}>
              <CircleDashed className="h-3 w-3" aria-hidden="true" />
              Não configurada
            </Badge>
          )}
        </div>
        {replacing ? (
          <Button type="button" variant="ghost" size="touch-sm" onClick={() => onChange(undefined)}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            Cancelar
          </Button>
        ) : (
          <Button type="button" variant="outline" size="touch-sm" onClick={() => onChange("")} aria-label={`${isSet ? "Substituir" : "Informar"} ${name}`}>
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
              id={inputId}
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

      {!replacing && error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
      {!replacing && !error && !isSet && hint && <p className="text-xs text-ink-softer">{hint}</p>}
    </div>
  )
}
