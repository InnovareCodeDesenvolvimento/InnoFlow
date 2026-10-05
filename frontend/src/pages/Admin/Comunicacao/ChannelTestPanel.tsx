import { type ReactNode, useId, useState } from "react"
import { CircleCheck, CircleX, Loader2, Send, TriangleAlert } from "lucide-react"
import type { UseMutationResult } from "@tanstack/react-query"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { parseCommunicationError, testErrorText, type CommunicationError, type DraftErrors, type TestPlan } from "@/lib/communicationSettings"
import { formatDateTime } from "@/lib/utils"
import type { TestChannelResult } from "@/types/api"

/**
 * "Enviar teste" de um canal. Genérico no pedido (`TReq`): o e-mail e o WhatsApp só diferem no que `plan` monta.
 *  - `plan(toText)` valida e monta o pedido (ou devolve `errors`; os de campo do canal sobem por `onFieldErrors`, o do destino aparece aqui);
 *  - o resultado ok/falha é GUARDADO AQUI e a mutation é zerada (`reset()`) logo depois: o pedido pode carregar a senha SMTP/apikey digitadas e não deve ficar em `variables`;
 *  - o servidor responde SEMPRE 200 com `ok: false` para falha do provedor (é o resultado do teste, não erro da rota); só 400/403/429/503 viram o aviso de erro de requisição.
 * O texto de cada falha é por `code` (`testErrorText`), nunca o `message` do servidor.
 */
export function ChannelTestPanel<TReq>({
  testId,
  channelLabel,
  buttonLabel,
  toLabel,
  toPlaceholder,
  toHint,
  inputMode,
  usesUnsaved,
  plan,
  mutation,
  onFieldErrors,
  idle,
}: {
  testId: string
  channelLabel: string
  buttonLabel: string
  toLabel: string
  toPlaceholder: string
  toHint: string
  inputMode: "email" | "tel"
  /** O teste vai usar valores digitados e ainda não salvos? (muda o aviso acima do botão.) */
  usesUnsaved: boolean
  plan: (toText: string) => TestPlan<TReq>
  mutation: UseMutationResult<TestChannelResult, Error, TReq>
  onFieldErrors: (errors: DraftErrors) => void
  /** Conteúdo extra acima do botão (opcional). */
  idle?: ReactNode
}) {
  const toId = useId()
  const [toText, setToText] = useState("")
  const [toError, setToError] = useState<string | undefined>()
  const [result, setResult] = useState<TestChannelResult | null>(null)
  const [failure, setFailure] = useState<CommunicationError | null>(null)
  const pending = mutation.isPending

  const run = async () => {
    setResult(null)
    setFailure(null)
    const { request, errors } = plan(toText)
    setToError(errors.to)
    onFieldErrors(Object.fromEntries(Object.entries(errors).filter(([key]) => key !== "to")))
    if (!request) return
    try {
      setResult(await mutation.mutateAsync(request))
    } catch (err) {
      setFailure(parseCommunicationError(err))
    } finally {
      // O pedido pode ter a senha SMTP / apikey digitadas: `variables` não pode sobreviver na memória do TanStack Query.
      mutation.reset()
    }
  }

  const text = result && !result.ok ? testErrorText(result.error?.code) : null

  return (
    <div className="space-y-4 border-t border-border-subtle pt-5" data-testid={testId}>
      <div className="space-y-1">
        <h3 className="text-sm font-bold text-ink">Testar {channelLabel}</h3>
        <p className="text-xs text-ink-softer">Envia uma mensagem de verificação agora. Não altera nada na configuração.</p>
      </div>

      {usesUnsaved && (
        <Alert tone="warning" size="sm" role="status" icon={TriangleAlert} className="font-medium" data-testid={`${testId}-unsaved-note`}>
          <p>O teste usa os valores que você digitou e ainda não salvou. Nada é gravado por testar.</p>
        </Alert>
      )}
      {idle}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <Input
            id={toId}
            label={toLabel}
            inputMode={inputMode}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={toPlaceholder}
            value={toText}
            onChange={(e) => {
              setToText(e.target.value)
              setToError(undefined)
            }}
            error={toError}
            hint={toHint}
            data-testid={`${testId}-to`}
          />
        </div>
        <Button type="button" variant="outline" size="touch" className="sm:mt-[1.625rem]" onClick={() => void run()} loading={pending} data-testid={`${testId}-button`}>
          {!pending && <Send className="h-4 w-4" aria-hidden="true" />}
          {pending ? "Enviando…" : buttonLabel}
        </Button>
      </div>

      <div aria-live="polite" className="space-y-3">
        {pending && (
          <p className="flex items-center gap-2 text-sm text-ink-softer">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Enviando o teste… pode levar alguns segundos.
          </p>
        )}

        {failure && !pending && (
          <Alert tone="danger" size="sm" role="alert" icon={TriangleAlert} className="font-medium" data-testid={`${testId}-request-error`} data-code={failure.code}>
            <p>{failure.message}</p>
          </Alert>
        )}

        {result && !pending && (
          <Alert
            tone={result.ok ? "success" : "danger"}
            icon={result.ok ? CircleCheck : CircleX}
            data-testid={`${testId}-result`}
            data-ok={result.ok ? "true" : "false"}
            data-code={result.error?.code}
          >
            {result.ok ? (
              <div className="space-y-1">
                <p className="text-sm font-bold text-ink">Teste enviado com sucesso.</p>
                <p className="text-sm text-ink-soft">
                  {result.to ? (
                    <>
                      Enviado para <span className="font-semibold text-ink">{result.to}</span>. Confira se chegou{result.channel === "email" ? " (olhe também o spam)." : "."}
                    </>
                  ) : (
                    "Confira se a mensagem chegou."
                  )}
                </p>
                <p className="text-xs text-ink-softer">
                  {formatDateTime(result.testedAt)} · {result.durationMs} ms
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-bold text-ink">{text?.title}</p>
                <p className="text-sm text-ink-soft">{text?.action}</p>
                <p className="break-words text-xs text-ink-softer">
                  {[result.error ? `Código: ${result.error.code}` : null, result.to ? `Destino: ${result.to}` : null, `${result.durationMs} ms`].filter(Boolean).join(" · ")}
                </p>
              </div>
            )}
          </Alert>
        )}
      </div>
    </div>
  )
}
