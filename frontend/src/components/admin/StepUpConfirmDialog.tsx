import { type ReactNode, useState } from "react"
import { Alert } from "@/components/ui/Alert"
import { ConfirmSaveDialog, type ChangeSummaryItem } from "@/components/admin/ConfirmSaveDialog"
import { parseReversalError, type ReversalDomain, type ReversalError } from "@/lib/reversals"

/**
 * Passo de CONFIRMAÇÃO com SENHA das telas de dinheiro do Admin (estorno, chargeback, devolução de conta excluída): resumo do que vai acontecer + a senha do ADMIN (step-up) e
 * o verbo da ação no botão. Por cima de `ConfirmSaveDialog` (que guarda a senha só no estado local e a zera ao enviar); aqui entra o que é próprio destas rotas:
 *  - o erro vem SEMPRE por `code` (`parseReversalError`), nunca o texto do servidor;
 *  - 403 `INVALID_CURRENT_PASSWORD` aparece no campo de senha (e o foco volta a ele); qualquer outro erro vira um aviso `role="alert"` acima da senha, com o diálogo aberto;
 *  - `onFailure` deixa a tela tratar um erro de regra (ex.: o teto mudou) voltando ao formulário: devolva `true` e o aviso daqui não aparece.
 *
 * `run` recebe a senha digitada e faz a chamada. O sucesso é da tela (fecha o diálogo, avisa); o erro é lançado de volta para cá.
 */
export function StepUpConfirmDialog({
  title,
  description,
  items,
  extra,
  confirmLabel,
  cancelLabel,
  destructive,
  domain,
  run,
  onFailure,
  onCancel,
}: {
  title: string
  description: string
  items: ChangeSummaryItem[]
  extra?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  domain: ReversalDomain
  run: (currentPassword: string) => Promise<void>
  onFailure?: (error: ReversalError) => boolean
  onCancel: () => void
}) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<ReversalError | null>(null)

  const handleConfirm = async (currentPassword: string) => {
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      await run(currentPassword)
    } catch (err) {
      const parsed = parseReversalError(err, domain)
      if (!onFailure?.(parsed)) setFailure(parsed)
    } finally {
      setPending(false)
    }
  }

  const wrongPassword = failure?.code === "INVALID_CURRENT_PASSWORD"
  return (
    <ConfirmSaveDialog
      title={title}
      description={description}
      passwordHint="É a mesma senha do seu login. Ela não é guardada."
      items={items}
      extra={
        <>
          {extra}
          {failure && !wrongPassword && (
            <Alert tone="danger" size="sm" role="alert" className="mt-3">
              {failure.message}
            </Alert>
          )}
        </>
      }
      destructive={destructive}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      loading={pending}
      passwordError={wrongPassword ? failure.message : null}
      onConfirm={(password) => void handleConfirm(password)}
      onCancel={onCancel}
    />
  )
}
