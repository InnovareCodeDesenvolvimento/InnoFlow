import { useId, useState } from "react"
import { CheckCircle2, CircleAlert, CircleHelp, CircleMinus, Loader2, ShieldCheck, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { IconBadge } from "@/components/ui/IconBadge"
import { InlineCode } from "@/components/ui/InlineCode"
import { Input } from "@/components/ui/Input"
import { useDomainCheck } from "@/hooks/useCommunicationSettings"
import { parseCommunicationError, type CommunicationError } from "@/lib/communicationSettings"
import { formatDateTime } from "@/lib/utils"
import type { CommunicationSettingsDTO, DnsInstruction, DnsRecordCheck, DnsRecordStatus, DomainCheckResponse } from "@/types/api"

/** Seletor DKIM: UM rótulo DNS (letras, números e hífen, sem hífen nas pontas, até 63). Em branco = não informado. */
const SELECTOR_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
const SELECTOR_ERROR = "Seletor inválido: use só letras, números e hífen (até 63 caracteres)."

const STATUS: Record<DnsRecordStatus, { label: string; variant: "success" | "warning" | "danger" | "neutral"; icon: typeof CheckCircle2 }> = {
  OK: { label: "Configurado", variant: "success", icon: CheckCircle2 },
  ATENCAO: { label: "Atenção", variant: "warning", icon: CircleAlert },
  AUSENTE: { label: "Ausente", variant: "danger", icon: CircleAlert },
  ERRO: { label: "Sem resposta", variant: "neutral", icon: CircleHelp },
}

const RECORDS: ReadonlyArray<{ key: "spf" | "dkim" | "dmarc"; title: string; what: string }> = [
  { key: "spf", title: "SPF", what: "Diz quais servidores podem enviar e-mail em nome do seu domínio." },
  { key: "dkim", title: "DKIM", what: "Assina cada e-mail, para provar que ele não foi alterado no caminho." },
  { key: "dmarc", title: "DMARC", what: "Diz o que fazer com e-mail que falha nas duas checagens e envia relatórios para você." },
]

function RecordStatusBadge({ record }: { record: DnsRecordCheck }) {
  // DKIM sem seletor: o servidor não consultou nada (`nomeConsultado: null`). Não é erro: é "não verificado".
  if (record.nomeConsultado === null) {
    return (
      <Badge variant="neutral">
        <CircleMinus className="h-3 w-3" aria-hidden="true" />
        Não verificado
      </Badge>
    )
  }
  const { label, variant, icon: Icon } = STATUS[record.status]
  return (
    <Badge variant={variant}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  )
}

function InstructionBlock({ instruction }: { instruction: DnsInstruction }) {
  return (
    <div className="space-y-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-ink-soft">
      <p>{instruction.texto}</p>
      <dl className="space-y-1">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <dt className="shrink-0 font-semibold text-ink sm:w-24">Tipo</dt>
          <dd>{instruction.tipo}</dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <dt className="shrink-0 font-semibold text-ink sm:w-24">Nome</dt>
          <dd className="min-w-0">
            <InlineCode>{instruction.nome}</InlineCode>
          </dd>
        </div>
        {instruction.valorSugerido && (
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="shrink-0 font-semibold text-ink sm:w-24">Valor sugerido</dt>
            <dd className="min-w-0">
              <InlineCode>{instruction.valorSugerido}</InlineCode>
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

function RecordRow({ title, what, record, instruction }: { title: string; what: string; record: DnsRecordCheck; instruction: DnsInstruction | undefined }) {
  const detailsId = useId()
  const [open, setOpen] = useState(false)
  const needsAction = record.status !== "OK"
  return (
    <li className="space-y-2 px-4 py-3" data-testid={`domain-${title.toLowerCase()}`} data-status={record.nomeConsultado === null ? "NAO_VERIFICADO" : record.status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="text-sm font-bold text-ink">{title}</h4>
        <RecordStatusBadge record={record} />
      </div>
      <p className="text-xs text-ink-softer">{what}</p>
      <p className="text-sm text-ink-soft">{record.recomendacao}</p>
      {record.valorEncontrado && (
        <p className="text-xs text-ink-softer">
          Encontrado: <InlineCode>{record.valorEncontrado}</InlineCode>
        </p>
      )}
      {instruction && needsAction && (
        <div className="space-y-2">
          <Button type="button" variant="ghost" size="touch-sm" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)}>
            {open ? "Esconder como configurar" : "Como configurar"}
          </Button>
          {open && (
            <div id={detailsId}>
              <InstructionBlock instruction={instruction} />
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Verificação do domínio do remetente (SPF, DKIM, DMARC): consulta o DNS público do domínio do e-mail remetente SALVO e explica, em linguagem simples, o que falta.
 * O domínio nunca vem da tela (o servidor usa o remetente salvo); só o seletor DKIM, opcional. Resultado em estado do componente (a requisição não leva segredo).
 */
export function DomainCheckPanel({ dto }: { dto: CommunicationSettingsDTO }) {
  const mutation = useDomainCheck()
  const selectorId = useId()
  const [selector, setSelector] = useState("")
  const [selectorError, setSelectorError] = useState<string | undefined>()
  const [result, setResult] = useState<DomainCheckResponse | null>(null)
  const [failure, setFailure] = useState<CommunicationError | null>(null)
  const pending = mutation.isPending
  const savedDomain = dto.email.fromAddress?.split("@")[1] ?? null

  const run = async () => {
    if (pending) return
    const typed = selector.trim()
    if (typed && !SELECTOR_RE.test(typed)) {
      setSelectorError(SELECTOR_ERROR)
      return
    }
    setSelectorError(undefined)
    setResult(null)
    setFailure(null)
    try {
      setResult(await mutation.mutateAsync(typed || undefined))
    } catch (err) {
      setFailure(parseCommunicationError(err))
    } finally {
      mutation.reset()
    }
  }

  return (
    <Card data-testid="section-domain-check">
      <CardHeader className="flex flex-row items-start gap-3">
        <IconBadge icon={ShieldCheck} size="md" tinted />
        <div className="min-w-0">
          <CardTitle as="h2">Verificação do domínio do remetente (SPF, DKIM, DMARC)</CardTitle>
          <CardDescription>
            Confere se o domínio do e-mail remetente tem os registros que ajudam seus e-mails a chegar na caixa de entrada, e não no spam.
            {savedDomain ? (
              <>
                {" "}
                Domínio verificado: <strong className="font-semibold text-ink">{savedDomain}</strong> (o remetente salvo).
              </>
            ) : (
              " Salve primeiro o remetente, acima: a verificação usa o domínio dele."
            )}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <Input
              id={selectorId}
              label="Seletor DKIM (opcional)"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="ex.: default, google, s1"
              value={selector}
              onChange={(e) => {
                setSelector(e.target.value)
                setSelectorError(undefined)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void run()
                }
              }}
              error={selectorError}
              hint="O seletor aparece no painel do seu provedor de e-mail quando você ativa o DKIM. Sem ele, o DKIM não é verificado."
              data-testid="domain-selector"
            />
          </div>
          <Button type="button" variant="outline" size="touch" className="sm:mt-[1.625rem]" onClick={() => void run()} loading={pending} data-testid="domain-check-button">
            {!pending && <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            {pending ? "Verificando…" : "Verificar"}
          </Button>
        </div>

        <div aria-live="polite" className="space-y-3">
          {pending && (
            <p className="flex items-center gap-2 text-sm text-ink-softer">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Consultando o DNS do domínio… pode levar alguns segundos.
            </p>
          )}

          {failure && !pending && (
            <Alert tone="danger" size="sm" role="alert" icon={TriangleAlert} className="font-medium" data-testid="domain-check-error" data-code={failure.code}>
              <p>{failure.message}</p>
            </Alert>
          )}

          {result && !pending && (
            <div className="space-y-3" data-testid="domain-check-result" data-overall={result.overallStatus ?? "NENHUM"}>
              {result.warnings.map((warning) => (
                <Alert key={warning} tone="warning" size="sm" role="status" icon={TriangleAlert} className="font-medium">
                  <p>{warning}</p>
                </Alert>
              ))}
              {result.senderConfigured && result.spf && result.dkim && result.dmarc && (
                <>
                  <p className="text-sm text-ink-soft">
                    Domínio <InlineCode>{result.domain}</InlineCode>
                    {result.smtpProvider ? ` · provedor ${result.smtpProvider}` : ""} · verificado em {formatDateTime(result.checkedAt)}
                  </p>
                  <ul className="divide-y divide-border-subtle rounded-xl border border-border bg-surface">
                    {RECORDS.map(({ key, title, what }) => (
                      <RecordRow key={key} title={title} what={what} record={result[key] as DnsRecordCheck} instruction={result.instructions?.[key]} />
                    ))}
                  </ul>
                  <p className="text-xs text-ink-softer">{result.note}</p>
                </>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
