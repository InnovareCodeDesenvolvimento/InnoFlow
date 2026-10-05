import { CircleCheck, CircleMinus, CircleX, Loader2, PlugZap, TriangleAlert, type LucideIcon } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
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
import { formatDateTime } from "@/lib/utils"
import type { PaymentGatewayEnvironment, PaymentGatewayTestStepResult } from "@/types/api"

/** Tom do passo (`TestStatusTone`, do contrato de textos) -> tom do `Alert`/`Badge` do design system e ícone do passo. */
const TONE: Record<TestStatusTone, { alert: "success" | "danger" | "warning" | "muted"; badge: "success" | "danger" | "warning" | "neutral"; icon: LucideIcon }> = {
  success: { alert: "success", badge: "success", icon: CircleCheck },
  danger: { alert: "danger", badge: "danger", icon: CircleX },
  warning: { alert: "warning", badge: "warning", icon: TriangleAlert },
  neutral: { alert: "muted", badge: "neutral", icon: CircleMinus },
}

function StepRow({ result, environment }: { result: PaymentGatewayTestStepResult; environment: PaymentGatewayEnvironment }) {
  const info = TEST_STATUS_INFO[result.status]
  const labels = TEST_STEP_LABELS[result.step]
  const support = testSupportText(result.status, environment)
  const tone = TONE[info.tone]

  return (
    <li data-testid={`test-step-${result.step}`} data-status={result.status}>
      <Alert tone={tone.alert} icon={tone.icon} iconClassName={result.status === "SKIPPED" ? "text-ink-softer" : undefined}>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-bold text-ink">{labels.title}</p>
            <Badge variant={tone.badge} data-testid="test-step-status">
              {info.label}
            </Badge>
          </div>
          <p className="text-xs text-ink-softer">{labels.hint}</p>
          <p className="break-words text-sm text-ink-soft" data-testid="test-step-message">
            {result.message}
          </p>
          {support && isTestFailure(result.status) && (
            <p className="rounded-lg bg-surface px-3 py-2 text-xs font-medium text-ink" data-testid="test-step-support">
              {support}
            </p>
          )}
          {support && !isTestFailure(result.status) && result.status === "NOT_CONFIGURED" && <p className="text-xs text-ink-softer">{support}</p>}
          {(result.host || result.httpStatus !== null || result.durationMs > 0) && (
            <p className="text-xs text-ink-softer [overflow-wrap:anywhere]">
              {[result.host, result.httpStatus !== null ? `HTTP ${result.httpStatus}` : null, result.durationMs > 0 ? `${result.durationMs} ms` : null].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </Alert>
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
        <CardTitle as="h2">Testar conexão</CardTitle>
        <CardDescription>Confere agora, na Cielo, se as credenciais salvas funcionam. Não cobra nada e não altera nada.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasUnsavedCredentials && (
          <Alert tone="warning" size="sm" role="status" icon={TriangleAlert} className="font-medium" data-testid="test-unsaved-note">
            <p>O teste usa o que está SALVO, não o que você digitou e ainda não salvou. Salve as alterações antes de testar.</p>
          </Alert>
        )}

        <Button type="button" variant="outline" size="touch" onClick={() => test.mutate()} loading={test.isPending}>
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
            <Alert tone="danger" size="sm" role="alert" icon={TriangleAlert} className="font-medium" data-testid="test-request-error">
              <p>{testRequestErrorMessage(test.error)}</p>
            </Alert>
          )}

          {result && verdict && !test.isPending && (
            <div className="space-y-3" data-testid="test-result" data-verdict={verdict}>
              <Alert tone={TONE[verdict === "ok" ? "success" : verdict === "failed" ? "danger" : "neutral"].alert}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="text-sm font-bold text-ink" data-testid="test-verdict">
                    {TEST_VERDICT_TEXT[verdict]}
                  </p>
                  <p className="text-xs text-ink-softer">
                    Ambiente: <span className="font-semibold text-ink-soft">{ENVIRONMENT_LABELS[result.environment]}</span> · {formatDateTime(result.testedAt)}
                  </p>
                </div>
              </Alert>
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
