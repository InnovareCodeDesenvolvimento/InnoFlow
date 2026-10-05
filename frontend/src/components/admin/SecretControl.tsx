import { KeyRound, Trash2, Undo2 } from "lucide-react"
import { SecretField } from "@/components/admin/SecretField"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"

/**
 * Segredo de um canal (senha SMTP / apikey da Evolution): o `SecretField` do gateway (só escrita, nunca pré-preenchido) + "apagar o segredo salvo" (`clearSecrets`).
 * Marcar para apagar é um estado do rascunho (nada vai ao servidor até salvar) e é DESFEITO ao começar a digitar um valor novo (apagar e trocar ao mesmo tempo não faz sentido).
 */
export function SecretControl({
  testId,
  name,
  removeLabel,
  isSet,
  unreadable,
  value,
  onChange,
  markedForRemoval,
  onMarkRemoval,
  error,
  hint,
  note,
}: {
  testId: string
  name: string
  /** Nome acessível do botão de apagar ("Apagar a senha SMTP salva"). */
  removeLabel: string
  isSet: boolean
  unreadable: boolean
  value: string | undefined
  onChange: (value: string | undefined) => void
  markedForRemoval: boolean
  onMarkRemoval: (marked: boolean) => void
  error?: string
  hint?: string
  note?: string | null
}) {
  if (markedForRemoval) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" data-testid={testId}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft">
            <KeyRound className="h-3.5 w-3.5 text-ink-subtle" aria-hidden="true" />
            {name}
          </span>
          <Badge variant="warning" data-testid={`${testId}-chip`}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Será apagada ao salvar
          </Badge>
        </div>
        <Button type="button" variant="ghost" size="touch-sm" onClick={() => onMarkRemoval(false)}>
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          Desfazer
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <SecretField testId={testId} name={name} isSet={isSet} unreadable={unreadable} value={value} onChange={onChange} error={error} hint={hint} setNote={note} />
      {isSet && value === undefined && (
        <Button type="button" variant="ghost" size="touch-sm" className="text-danger-700" onClick={() => onMarkRemoval(true)} aria-label={removeLabel}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Apagar
        </Button>
      )}
    </div>
  )
}
