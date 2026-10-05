import { useId, useState } from "react"
import { CircleHelp, Loader2, Send, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { useTestEmail } from "@/hooks/useCommunicationSettings"
import { parseCommunicationError, planEmailTest, type CommunicationError } from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO, TestChannelResult } from "@/types/api"
import { TestResultAlert } from "./ChannelTestPanel"

/**
 * "Enviar e-mail de teste": manda um e-mail simples pelo SMTP SALVO (sem `config`: nada de senha digitada trafega neste teste) e mostra o resultado por `code`.
 * Com alteração não salva na aba, avisa que o teste usa o que está salvo. O botão de ajuda abre/fecha a explicação (`aria-expanded`).
 */
export function EmailTestBox({ dto, hasUnsaved }: { dto: CommunicationSettingsDTO; hasUnsaved: boolean }) {
  const mutation = useTestEmail()
  const toId = useId()
  const helpId = useId()
  const [to, setTo] = useState("")
  const [toError, setToError] = useState<string | undefined>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [result, setResult] = useState<TestChannelResult | null>(null)
  const [failure, setFailure] = useState<CommunicationError | null>(null)
  const pending = mutation.isPending

  const run = async () => {
    if (pending) return
    setResult(null)
    setFailure(null)
    const { request, errors } = planEmailTest(dto, {}, to, {})
    setToError(errors.to)
    if (!request) return
    try {
      setResult(await mutation.mutateAsync(request))
    } catch (err) {
      setFailure(parseCommunicationError(err))
    } finally {
      mutation.reset()
    }
  }

  return (
    <div className="space-y-3 border-t border-border-subtle p-5 sm:p-6" data-testid="email-test">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={toId} className="block text-sm font-medium text-ink-soft">
            Enviar e-mail de teste
          </label>
          <Button
            type="button"
            variant="ghost"
            size="touch-sm"
            className="-my-1"
            aria-expanded={helpOpen}
            aria-controls={helpId}
            aria-label="O que é o e-mail de teste?"
            onClick={() => setHelpOpen((open) => !open)}
            data-testid="email-test-help-button"
          >
            <CircleHelp className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        {helpOpen && (
          <p id={helpId} className="rounded-lg bg-muted px-3 py-2 text-xs text-ink-soft" data-testid="email-test-help">
            O teste usa o servidor SMTP que está SALVO, não o que você está digitando: se mudou algo, salve primeiro. Se o servidor aceitar a mensagem, ela deve chegar em instantes (olhe também a caixa de spam).
          </p>
        )}
        <Input
          id={toId}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="voce@gmail.com"
          value={to}
          onChange={(e) => {
            setTo(e.target.value)
            setToError(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void run()
            }
          }}
          error={toError}
          hint="Manda um e-mail simples pelo SMTP salvo e mostra o que o servidor respondeu. Use o seu Gmail para ver se chega."
          data-testid="email-test-to"
        />
      </div>

      {hasUnsaved && (
        <Alert tone="warning" size="sm" role="status" icon={TriangleAlert} className="font-medium" data-testid="email-test-unsaved-note">
          <p>Há alterações não salvas: o teste usa o SMTP salvo.</p>
        </Alert>
      )}

      <Button type="button" variant="outline" size="touch" className="self-start" onClick={() => void run()} loading={pending} data-testid="email-test-button">
        {!pending && <Send className="h-4 w-4" aria-hidden="true" />}
        {pending ? "Enviando…" : "Enviar e-mail de teste"}
      </Button>

      <div aria-live="polite" className="space-y-3">
        {pending && (
          <p className="flex items-center gap-2 text-sm text-ink-softer">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Enviando o teste… pode levar alguns segundos.
          </p>
        )}
        {failure && !pending && (
          <Alert tone="danger" size="sm" role="alert" icon={TriangleAlert} className="font-medium" data-testid="email-test-request-error" data-code={failure.code}>
            <p>{failure.message}</p>
          </Alert>
        )}
        {result && !pending && <TestResultAlert testId="email-test" result={result} />}
      </div>
    </div>
  )
}
