import { useState } from "react"
import { CircleCheck, CircleMinus, CircleX, Loader2, PlugZap, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { useTestSmtpConnection } from "@/hooks/useCommunicationSettings"
import {
  emailTestUsesDraft,
  parseCommunicationError,
  planSmtpConnectionTest,
  smtpStageStates,
  testErrorText,
  type CommunicationError,
  type DraftErrors,
  type EmailDraft,
  type StageState,
} from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO, TestSmtpConnectionResult } from "@/types/api"

const STAGE_TEXT: Record<StageState, string> = { ok: "ok", failed: "falhou", skipped: "não testado" }

/**
 * "Testar conexão": conecta ao servidor SMTP, negocia o TLS e autentica, SEM enviar e-mail. Testa o que está na tela (rascunho sobre o salvo; sem alteração, o salvo). O resultado mostra
 * em que etapa parou (Conexão, TLS, Autenticação) e o texto vem do `code` (`testErrorText`), nunca do `message` do servidor. O pedido pode levar a senha SMTP digitada: o resultado fica
 * em estado local e a mutation é zerada (`reset()`) logo depois.
 */
export function SmtpConnectionTest({ dto, draft, errors, onFieldErrors }: { dto: CommunicationSettingsDTO; draft: EmailDraft; errors: DraftErrors; onFieldErrors: (errors: DraftErrors) => void }) {
  const mutation = useTestSmtpConnection()
  const [result, setResult] = useState<TestSmtpConnectionResult | null>(null)
  const [failure, setFailure] = useState<CommunicationError | null>(null)
  const pending = mutation.isPending

  const run = async () => {
    setResult(null)
    setFailure(null)
    const { request, errors: planErrors } = planSmtpConnectionTest(dto, draft, errors)
    onFieldErrors(planErrors)
    if (!request) return
    try {
      setResult(await mutation.mutateAsync(request))
    } catch (err) {
      setFailure(parseCommunicationError(err))
    } finally {
      mutation.reset()
    }
  }

  const text = result && !result.ok ? testErrorText(result.code ?? undefined) : null

  return (
    <div className="space-y-3" data-testid="smtp-connection-test">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button type="button" variant="outline" size="touch" className="self-start" onClick={() => void run()} loading={pending} data-testid="smtp-connection-button">
          {!pending && <PlugZap className="h-4 w-4" aria-hidden="true" />}
          {pending ? "Testando…" : "Testar conexão"}
        </Button>
        <p className="text-xs text-ink-softer">
          {emailTestUsesDraft(draft) ? "Testa os valores que você digitou, sem salvar. Não envia e-mail." : "Confere servidor, TLS e login. Não envia e-mail."}
        </p>
      </div>

      <div aria-live="polite" className="space-y-3">
        {pending && (
          <p className="flex items-center gap-2 text-sm text-ink-softer">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Testando a conexão… pode levar alguns segundos.
          </p>
        )}

        {failure && !pending && (
          <Alert tone="danger" size="sm" role="alert" icon={TriangleAlert} className="font-medium" data-testid="smtp-connection-request-error" data-code={failure.code}>
            <p>{failure.message}</p>
          </Alert>
        )}

        {result && !pending && (
          <Alert
            tone={result.ok ? "success" : "danger"}
            icon={result.ok ? CircleCheck : CircleX}
            data-testid="smtp-connection-result"
            data-ok={result.ok ? "true" : "false"}
            data-stage={result.stage}
            data-code={result.code ?? undefined}
          >
            <div className="space-y-2">
              {result.ok ? (
                <>
                  <p className="text-sm font-bold text-ink">Conexão funcionando.</p>
                  <p className="text-sm text-ink-soft">
                    {result.authenticated ? "O servidor respondeu, aceitou a conexão segura e o login." : "O servidor respondeu e aceitou a conexão. Sem usuário e senha configurados, o login não foi testado."}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold text-ink">{text?.title}</p>
                  <p className="text-sm text-ink-soft">{text?.action}</p>
                </>
              )}
              <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-ink-soft" aria-label="Etapas do teste">
                {smtpStageStates(result).map(({ stage, label, state }) => (
                  <li key={stage} className="flex items-center gap-1" data-stage={stage} data-state={state}>
                    {state === "ok" ? <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" /> : state === "failed" ? <CircleX className="h-3.5 w-3.5" aria-hidden="true" /> : <CircleMinus className="h-3.5 w-3.5" aria-hidden="true" />}
                    {label}: {STAGE_TEXT[state]}
                  </li>
                ))}
              </ol>
              <p className="break-words text-xs text-ink-softer">{[result.code ? `Código: ${result.code}` : null, `${result.durationMs} ms`].filter(Boolean).join(" · ")}</p>
            </div>
          </Alert>
        )}
      </div>
    </div>
  )
}
