import { CircleCheck, CircleMinus, CircleX, Loader2, PlugZap, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { useTestPaymentGatewayConnection } from "@/hooks/usePaymentGateway"
import { ENVIRONMENT_LABELS } from "@/lib/paymentGateway"
import {
  TEST_STATUS_INFO,
  TEST_STEP_LABELS,
  TEST_VERDICT_TEXT,
  isTestFailure,
  testRequestErrorMessage,
  testSupportText,
  testVerdict,
  type TestStatusTone,
} from "@/lib/paymentGatewayTest"
import { cn, formatDateTime } from "@/lib/utils"
import type { PaymentGatewayEnvironment, PaymentGatewayTestStepResult } from "@/types/api"

const TONE_CLASSES: Record<TestStatusTone, { box: string; badge: string }> = {
  success: { box: "border-success-600/30 bg-success-50", badge: "bg-success-100 text-success-700" },
  danger: { box: "border-danger-600/40 bg-danger-50", badge: "bg-danger-100 text-danger-700" },
  warning: { box: "border-warning-600/40 bg-warning-50", badge: "bg-warning-100 text-warning-700" },
  neutral: { box: "border-border bg-muted/40", badge: "bg-muted text-muted-foreground" },
}

function StepIcon({ tone, skipped }: { tone: TestStatusTone; skipped: boolean }) {
  if (tone === "success") return <CircleCheck className="h-5 w-5 text-success-600" aria-hidden="true" />
  if (tone === "neutral") return <CircleMinus className={cn("h-5 w-5", skipped ? "text-ink-subtle" : "text-ink-softer")} aria-hidden="true" />
  if (tone === "warning") return <TriangleAlert className="h-5 w-5 text-warning-600" aria-hidden="true" />
  return <CircleX className="h-5 w-5 text-danger-600" aria-hidden="true" />
}

function StepRow({ result, environment }: { result: PaymentGatewayTestStepResult; environment: PaymentGatewayEnvironment }) {
  const info = TEST_STATUS_INFO[result.status]
  const labels = TEST_STEP_LABELS[result.step]
  const support = testSupportText(result.status, environment)
  const tone = TONE_CLASSES[info.tone]

  return (
    <li className={cn("rounded-xl border p-3.5", tone.box)} data-testid={`test-step-${result.step}`} data-status={result.status}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          <StepIcon tone={info.tone} skipped={result.status === "SKIPPED"} />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-bold text-ink">{labels.title}</p>
            <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide", tone.badge)} data-testid="test-step-status">
              {info.label}
            </span>
          </div>
          <p className="text-xs text-ink-softer">{labels.hint}</p>
          <p className="break-words text-sm text-ink-soft" data-testid="test-step-message">
            {result.message}
          </p>
          {support && isTestFailure(result.status) && (
            <p className="rounded-lg bg-white/70 px-3 py-2 text-xs font-medium text-ink" data-testid="test-step-support">
              {support}
            </p>
          )}
          {support && !isTestFailure(result.status) && result.status === "NOT_CONFIGURED" && <p className="text-xs text-ink-softer">{support}</p>}
          {(result.host || result.httpStatus !== null || result.durationMs > 0) && (
            <p className="text-xs text-ink-softer">
              {[result.host, result.httpStatus !== null ? `HTTP ${result.httpStatus}` : null, result.durationMs > 0 ? `${result.durationMs} ms` : null].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * "Testar conexão" (C2.1): roda os passos reais contra a Cielo com a credencial SALVA e mostra, passo a passo, o que está certo e o que consertar -
 * em vez de descobrir o erro quando o motorista tenta pagar. O teste só LÊ (consulta de venda inexistente + os dois passos do cadastro de cartão), por isso
 * não pede a senha. Credencial errada NÃO é erro de tela: o servidor responde 200 com o status por passo. Só falhas de verdade do botão (429 limite de
 * 6/min, 503 config ilegível, 403 não admin) viram o aviso vermelho. Nada além do contrato é exibido: o servidor nunca devolve segredo nem token.
 */
export function ConnectionTestSection({ hasUnsavedCredentials }: { hasUnsavedCredentials: boolean }) {
  const test = useTestPaymentGatewayConnection()
  const result = test.data
  const verdict = result ? testVerdict(result) : null

  return (
    <Card data-testid="section-connection-test">
      <CardHeader>
        <CardTitle>Testar conexão</CardTitle>
        <CardDescription>Confere agora, na Cielo, se as credenciais salvas funcionam. Não cobra nada e não altera nada.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasUnsavedCredentials && (
          <p role="status" className="flex items-start gap-2 rounded-lg bg-warning-50 px-3 py-2 text-xs font-medium text-warning-700" data-testid="test-unsaved-note">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>O teste usa o que está SALVO, não o que você digitou e ainda não salvou. Salve as alterações antes de testar.</span>
          </p>
        )}

        <Button type="button" variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
          {!test.isPending && <PlugZap className="h-4 w-4" aria-hidden="true" />}
          {test.isPending ? "Testando…" : result ? "Testar de novo" : "Testar conexão"}
        </Button>

        <div aria-live="polite" className="space-y-3">
          {test.isPending && (
            <p className="flex items-center gap-2 text-sm text-ink-softer">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Falando com a Cielo… pode levar alguns segundos.
            </p>
          )}

          {test.isError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700" data-testid="test-request-error">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{testRequestErrorMessage(test.error)}</span>
            </p>
          )}

          {result && verdict && !test.isPending && (
            <div className="space-y-3" data-testid="test-result" data-verdict={verdict}>
              <div
                className={cn(
                  "flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5",
                  TONE_CLASSES[verdict === "ok" ? "success" : verdict === "failed" ? "danger" : "neutral"].box,
                )}
              >
                <p className="text-sm font-bold text-ink" data-testid="test-verdict">
                  {TEST_VERDICT_TEXT[verdict]}
                </p>
                <p className="text-xs text-ink-softer">
                  Ambiente: <span className="font-semibold text-ink-soft">{ENVIRONMENT_LABELS[result.environment]}</span> · {formatDateTime(result.testedAt)}
                </p>
              </div>
              <ol className="space-y-2" aria-label="Resultado por passo">
                {result.steps.map((step) => (
                  <StepRow key={step.step} result={step} environment={result.environment} />
                ))}
              </ol>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
