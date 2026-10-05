import { useEffect, useRef } from "react"
import { RotateCcw, Save, TriangleAlert } from "lucide-react"
import { ConfirmSaveDialog } from "@/components/admin/ConfirmSaveDialog"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { CardFooter } from "@/components/ui/Card"
import { CHANNEL_NAMES } from "@/lib/communicationSettings"
import { formatDateTime } from "@/lib/utils"
import type { CommunicationEditor } from "./useCommunicationEditor"

/** Aviso de falha do PUT (o servidor recusou): texto por `code`, pendências de `CHANNEL_INCOMPLETE` em lista e a garantia de que o que foi digitado continua na tela. */
export function SaveErrorAlert({ editor }: { editor: CommunicationEditor }) {
  const { saveError } = editor
  const ref = useRef<HTMLDivElement>(null)
  // O aviso aparece acima do cartão: traz para a vista (o admin está no rodapé quando clica em Salvar).
  useEffect(() => {
    if (saveError) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [saveError])
  if (!saveError) return null
  return (
    <Alert ref={ref} tone="danger" role="alert" icon={TriangleAlert} data-testid="save-error" data-code={saveError.code}>
      <p className="font-semibold">{saveError.message}</p>
      {saveError.problems.some((p) => p.problems.length > 0) && (
        <div className="mt-3 rounded-lg bg-surface p-3 text-ink" data-testid="save-error-problems">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-softer">O que falta</p>
          <ul className="space-y-2 text-sm">
            {saveError.problems.map((p) => (
              <li key={p.channel}>
                <span className="font-semibold">{CHANNEL_NAMES[p.channel]}</span>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                  {p.problems.map((problem, i) => (
                    <li key={`${i}-${problem}`}>{problem}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      {saveError.draftKept && <p className="mt-1 text-xs font-medium">O que você preencheu continua na tela.</p>}
    </Alert>
  )
}

/**
 * Rodapé do cartão: "Salvar" (abre o resumo + senha atual), "Descartar" e o estado ("N alterações não salvas" / "Nenhuma alteração pendente"). O botão fica desabilitado sem
 * alteração ou com campo inválido (e a barra diz por quê). `updatedAt` = quando a configuração foi gravada pela última vez.
 */
export function SaveFooter({ editor, updatedAt }: { editor: CommunicationEditor; updatedAt?: string | null }) {
  const { dirty, errorCount, changes, canSave, saving, touched } = editor
  return (
    <>
      <CardFooter className="flex-wrap gap-x-3 gap-y-2" data-testid="save-bar">
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button type="submit" size="touch" disabled={!canSave} loading={saving} data-testid="save-button">
            {!saving && <Save className="h-4 w-4" aria-hidden="true" />}
            {saving ? "Salvando…" : "Salvar"}
          </Button>
          {(dirty || touched) && (
            <Button type="button" variant="outline" size="touch" onClick={editor.discard} disabled={saving}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Descartar
            </Button>
          )}
        </div>
        <p className="min-w-0 text-sm text-ink-softer" aria-live="polite" data-testid="save-bar-status">
          {dirty ? (
            <>
              <span className="font-semibold text-ink">
                {changes.length} {changes.length === 1 ? "alteração não salva" : "alterações não salvas"}
              </span>
              {errorCount > 0 && (
                <span className="font-semibold text-danger-700" data-testid="save-bar-errors">
                  {" "}
                  — corrija os campos marcados para salvar.
                </span>
              )}
            </>
          ) : (
            "Nenhuma alteração pendente."
          )}
        </p>
      </CardFooter>
      <p className="px-5 pb-5 text-xs text-ink-softer sm:px-6" data-testid="save-bar-propagation">
        Depois de salvar, a mudança vale na API na hora e nos outros serviços em até 1 minuto.
        {updatedAt ? ` Última alteração em ${formatDateTime(updatedAt)}.` : ""}
      </p>
    </>
  )
}

/** Diálogo de confirmação com a senha atual (step-up). Só monta com alteração pendente. */
export function SaveDialog({ editor, title }: { editor: CommunicationEditor; title: string }) {
  if (!editor.saveDialogOpen || !editor.dirty) return null
  return (
    <ConfirmSaveDialog
      title={title}
      description="Revise o que será enviado ao servidor. Senha e apikey nunca são exibidas."
      passwordHint="Pedida em toda alteração, para que só quem conhece a senha possa mudar para onde os avisos do sistema vão."
      items={editor.changes}
      loading={editor.saving}
      passwordError={editor.passwordError}
      onCancel={editor.closeSaveDialog}
      onConfirm={(currentPassword) => void editor.save(currentPassword)}
    />
  )
}
