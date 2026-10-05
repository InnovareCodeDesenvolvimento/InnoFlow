import { RotateCcw, Save } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { CardFooter } from "@/components/ui/Card"

/**
 * Rodapé de um cartão de configuração (Agendamento, Destino): o "Salvar" é POR CARTÃO, como no InnoChat, mas o aviso de alteração não salva, o "Descartar" e a nota de senha são do InnoFlow.
 * O botão só habilita com alteração e sem campo inválido; a nota diz se esta alteração pede a senha atual. `prefix` dá os ids de teste (`schedule-save`, `destination-save-status`...).
 */
export function SaveFooter({
  prefix,
  count,
  errorCount,
  needsPassword,
  idleNote,
  canSave,
  canDiscard,
  loading,
  onSave,
  onDiscard,
}: {
  prefix: string
  count: number
  errorCount: number
  needsPassword: boolean
  /** O que dizer quando não há alteração (quais mudanças pedem senha). */
  idleNote: string
  canSave: boolean
  canDiscard: boolean
  loading: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  const dirty = count > 0
  return (
    <CardFooter className="mt-auto flex-col items-stretch gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between sm:pt-4">
      <div className="min-w-0 space-y-0.5" aria-live="polite">
        <p className="text-sm text-ink-softer" data-testid={`${prefix}-save-status`}>
          {dirty ? (
            <>
              <span className="font-semibold text-ink">{count === 1 ? "1 alteração não salva" : `${count} alterações não salvas`}</span>
              {errorCount > 0 && (
                <span className="font-semibold text-danger-700" data-testid={`${prefix}-save-errors`}>
                  {" "}
                  — corrija os campos marcados para salvar.
                </span>
              )}
            </>
          ) : (
            "Nenhuma alteração pendente."
          )}
        </p>
        <p className="text-xs text-ink-softer" data-testid={`${prefix}-save-note`}>
          {dirty ? (needsPassword ? "Esta alteração pede a sua senha atual ao salvar." : "Esta alteração não pede senha.") : idleNote}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button type="button" variant="outline" size="touch" onClick={onDiscard} disabled={!canDiscard} data-testid={`${prefix}-discard`}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Descartar
        </Button>
        <Button type="button" size="touch" onClick={onSave} loading={loading} disabled={!canSave} data-testid={`${prefix}-save`}>
          {!loading && <Save className="h-4 w-4" aria-hidden="true" />}
          Salvar
        </Button>
      </div>
    </CardFooter>
  )
}
