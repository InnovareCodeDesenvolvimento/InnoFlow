import { useEffect, useId, useRef, useState, type RefObject } from "react"
import { Building2, Check, FileText, Info, RotateCcw, Save, TriangleAlert, Users, X } from "lucide-react"
import { toast } from "sonner"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/Card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { IconBadge } from "@/components/ui/IconBadge"
import { InlineCode } from "@/components/ui/InlineCode"
import { Input } from "@/components/ui/Input"
import { Skeleton } from "@/components/ui/Skeleton"
import { useCompanyProfile, useUpdateCompanyProfile } from "@/hooks/useCompanyProfile"
import {
  FIELD_LABELS,
  MSG_COMPANY_FORBIDDEN,
  buildCompanyPayload,
  describeCompanyChanges,
  hasCompanyChanges,
  normalizeCnpj,
  parseCompanyError,
  shownValue,
  validateCompanyDraft,
  versionWouldChange,
  type CompanyDraft,
  type CompanyError,
  type CompanyField,
} from "@/lib/companyProfile"
import { cn, formatDateTime } from "@/lib/utils"
import { getApiErrorStatus } from "@/services/api"
import type { CompanyProfileDTO, VersionChangeDetail, LegalDataSource, UpdateCompanyProfileRequest } from "@/types/api"
import { useReportDirty } from "./dirtyContext"

/** Alturas MEDIDAS no cartão real (persona "pronta"): 375 px = 1759, de 640 px = 1003, a 1440 px (lg) = 919. */
function GeralSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando dados da empresa">
      <Skeleton className="h-[1759px] w-full rounded-card sm:h-[1003px] lg:h-[919px]" />
    </div>
  )
}

/**
 * Aba Geral: dados da empresa (controlador) e versões dos Termos e da Privacidade. Alimentam a página pública de termos, o rodapé do site e os e-mails ao motorista.
 * Sem segredo e sem step-up de senha; a confirmação explícita só existe para MUDAR A VERSÃO dos documentos (todos os motoristas aceitam de novo). Estado: o servidor é a fonte (`useQuery`);
 * o que se edita é um RASCUNHO de sobreposições por cima do DTO (sem efeito copiando dado assíncrono para estado).
 */
export default function GeralTab() {
  const { data: dto, isLoading, isError, error, refetch } = useCompanyProfile()
  const forbidden = getApiErrorStatus(error) === 403
  if (isLoading) return <GeralSkeleton />
  if (isError || !dto) return <ErrorState message={forbidden ? MSG_COMPANY_FORBIDDEN : parseCompanyError(error).message} onRetry={forbidden ? undefined : () => void refetch()} />
  return <GeralEditor dto={dto} />
}

const SOURCE_TEXT: Record<LegalDataSource, string> = { db: "Salvo no painel", env: "Vem do servidor (variáveis LEGAL_*)" }

function GeralEditor({ dto }: { dto: CompanyProfileDTO }) {
  const mutation = useUpdateCompanyProfile()
  const [draft, setDraft] = useState<CompanyDraft>({})
  const [cnpjBlurred, setCnpjBlurred] = useState(false)
  const [saveError, setSaveError] = useState<CompanyError | null>(null)
  const [versionChange, setVersionChange] = useState<VersionChangeDetail | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)

  const payload = buildCompanyPayload(dto, draft)
  const dirty = hasCompanyChanges(payload)
  const errors = validateCompanyDraft(draft)
  const errorCount = Object.keys(errors).length
  const changes = describeCompanyChanges(dto, payload)
  const willChangeVersion = versionWouldChange(dto, payload)
  const canSave = dirty && errorCount === 0 && !mutation.isPending
  useReportDirty("geral", dirty)

  useEffect(() => {
    if (saveError) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [saveError])

  const set = (field: CompanyField, value: string) => {
    setSaveError(null)
    setDraft((prev) => ({ ...prev, [field]: value }))
  }
  const value = (field: CompanyField) => shownValue(dto, draft, field)
  // O CNPJ só acusa erro depois de completo (14 caracteres) ou ao sair do campo: não grita enquanto a pessoa ainda digita.
  const cnpjVisible = cnpjBlurred || normalizeCnpj(draft.cnpj ?? "").length >= 14
  const fieldError = (field: CompanyField): string | undefined => (saveError?.fields.includes(field) ? saveError.message : undefined) ?? (field === "cnpj" && !cnpjVisible ? undefined : errors[field])

  const discard = () => {
    setDraft({})
    setCnpjBlurred(false)
    setSaveError(null)
  }

  const send = async (body: UpdateCompanyProfileRequest) => {
    setSaveError(null)
    try {
      await mutation.mutateAsync(body)
      setDraft({})
      setCnpjBlurred(false)
      setVersionChange(null)
      toast.success("Dados da empresa salvos.")
    } catch (err) {
      const parsed = parseCompanyError(err)
      if (parsed.code === "VERSION_CHANGE_NOT_CONFIRMED" && parsed.versionChange) {
        // Nada foi gravado: pede a confirmação explícita (com o número de motoristas) e reenvia o MESMO corpo com `confirmVersionChange`.
        setVersionChange(parsed.versionChange)
      } else {
        setVersionChange(null)
        setSaveError(parsed)
      }
    } finally {
      mutation.reset()
    }
  }

  return (
    <div className="space-y-6">
      {dto.source === "env" && (
        <Alert tone="info" role="status" icon={Info} data-testid="company-source-env">
          <p>
            <span className="font-bold">Usando as variáveis do servidor.</span> Nada foi salvo nesta tela ainda: valem as variáveis <InlineCode>LEGAL_*</InlineCode> do ambiente. Ao salvar, o painel passa a mandar e o que a variável já informava e você não mexeu é
            copiado para cá.
          </p>
        </Alert>
      )}
      {dto.invalidEnvFields.length > 0 && (
        <Alert tone="warning" role="status" icon={TriangleAlert} data-testid="company-invalid-env">
          <p>
            <span className="font-bold">Variáveis do servidor com valor inválido:</span> {dto.invalidEnvFields.join(", ")}. Esses campos aparecem vazios na página pública até você preenchê-los aqui.
          </p>
        </Alert>
      )}
      {saveError && (
        <Alert ref={errorRef} tone="danger" role="alert" icon={TriangleAlert} data-testid="company-save-error" data-code={saveError.code}>
          <p className="font-semibold">{saveError.message}</p>
          {saveError.draftKept && <p className="mt-1 text-xs font-medium">O que você preencheu continua na tela.</p>}
        </Alert>
      )}

      <Card data-testid="section-company">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge icon={Building2} size="md" tinted />
            <div className="min-w-0">
              <CardTitle as="h2">Dados da empresa</CardTitle>
              <CardDescription>Aparecem nos Termos de Uso, na Política de Privacidade, no rodapé do site e nos e-mails ao motorista.</CardDescription>
            </div>
          </div>
          <Badge variant="neutral" data-testid="company-source">
            {SOURCE_TEXT[dto.source]}
          </Badge>
        </CardHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (canSave) void send(payload)
          }}
        >
          <CardContent className="space-y-5 pt-3 sm:pt-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label={FIELD_LABELS.legalName} autoComplete="off" value={value("legalName")} onChange={(e) => set("legalName", e.target.value)} error={fieldError("legalName")} data-testid="company-legalName" />
              <Input label={FIELD_LABELS.tradeName} autoComplete="off" value={value("tradeName")} onChange={(e) => set("tradeName", e.target.value)} error={fieldError("tradeName")} data-testid="company-tradeName" />
              <Input
                label={FIELD_LABELS.cnpj}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="00.000.000/0000-00"
                value={value("cnpj")}
                onChange={(e) => set("cnpj", e.target.value)}
                onBlur={() => setCnpjBlurred(true)}
                error={fieldError("cnpj")}
                hint="Com ou sem pontuação. O CNPJ novo, com letras, também vale."
                data-testid="company-cnpj"
              />
              <Input
                label={FIELD_LABELS.website}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                placeholder="https://www.suaempresa.com.br"
                value={value("website")}
                onChange={(e) => set("website", e.target.value)}
                error={fieldError("website")}
                data-testid="company-website"
              />
              <Input
                label={FIELD_LABELS.supportEmail}
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="suporte@suaempresa.com.br"
                value={value("supportEmail")}
                onChange={(e) => set("supportEmail", e.target.value)}
                error={fieldError("supportEmail")}
                data-testid="company-supportEmail"
              />
              <Input
                label={FIELD_LABELS.supportPhone}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="(11) 4000-0000"
                value={value("supportPhone")}
                onChange={(e) => set("supportPhone", e.target.value)}
                error={fieldError("supportPhone")}
                data-testid="company-supportPhone"
              />
            </div>
            <Input label={FIELD_LABELS.address} autoComplete="off" value={value("address")} onChange={(e) => set("address", e.target.value)} error={fieldError("address")} data-testid="company-address" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={FIELD_LABELS.dpoName}
                autoComplete="off"
                value={value("dpoName")}
                onChange={(e) => set("dpoName", e.target.value)}
                error={fieldError("dpoName")}
                hint="Pessoa que responde pelos dados pessoais (LGPD)."
                data-testid="company-dpoName"
              />
              <Input
                label={FIELD_LABELS.dpoEmail}
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={value("dpoEmail")}
                onChange={(e) => set("dpoEmail", e.target.value)}
                error={fieldError("dpoEmail")}
                hint="Para onde o motorista escreve sobre os dados dele."
                data-testid="company-dpoEmail"
              />
            </div>

            <div className="space-y-4 border-t border-border-subtle pt-5">
              <div className="flex items-start gap-3">
                <IconBadge icon={FileText} size="md" tinted />
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-ink">Versões dos documentos</h3>
                  <p className="mt-1 text-sm text-ink-softer">A versão é o que o motorista aceita ao entrar. Em branco, vale a versão do servidor.</p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={FIELD_LABELS.termsVersion}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={dto.versions.envTermsVersion}
                  value={value("termsVersion")}
                  onChange={(e) => set("termsVersion", e.target.value)}
                  error={fieldError("termsVersion")}
                  hint={`Vigente agora: ${dto.versions.termsVersion} (${dto.versions.termsSource === "db" ? "do painel" : "do servidor"}). Em branco: ${dto.versions.envTermsVersion}.`}
                  data-testid="company-termsVersion"
                />
                <Input
                  label={FIELD_LABELS.privacyVersion}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={dto.versions.envPrivacyVersion}
                  value={value("privacyVersion")}
                  onChange={(e) => set("privacyVersion", e.target.value)}
                  error={fieldError("privacyVersion")}
                  hint={`Vigente agora: ${dto.versions.privacyVersion} (${dto.versions.privacySource === "db" ? "do painel" : "do servidor"}). Em branco: ${dto.versions.envPrivacyVersion}.`}
                  data-testid="company-privacyVersion"
                />
              </div>
              <Alert tone={willChangeVersion ? "warning" : "muted"} size="sm" role="status" icon={Users} className={cn(willChangeVersion && "font-medium")} data-testid="company-version-note" data-active={willChangeVersion ? "true" : "false"}>
                <p>
                  {willChangeVersion
                    ? "Esta alteração muda a versão dos documentos: todos os motoristas terão de aceitar de novo no próximo acesso. Você confirma antes de salvar."
                    : "Mudar a versão obriga todos os motoristas a aceitar os documentos de novo. Só mude a versão no momento em que o texto novo dos Termos ou da Privacidade for ao ar."}
                </p>
              </Alert>
            </div>
          </CardContent>

          <CardFooter className="flex-wrap gap-x-3 gap-y-2" data-testid="save-bar">
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Button ref={saveRef} type="submit" size="touch" disabled={!canSave} loading={mutation.isPending} data-testid="save-button">
                {!mutation.isPending && <Save className="h-4 w-4" aria-hidden="true" />}
                {mutation.isPending ? "Salvando…" : "Salvar"}
              </Button>
              {(dirty || Object.keys(draft).length > 0) && (
                <Button type="button" variant="outline" size="touch" onClick={discard} disabled={mutation.isPending}>
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
            A mudança vale na hora para a página pública de termos e para os próximos e-mails.{dto.updatedAt ? ` Última alteração em ${formatDateTime(dto.updatedAt)}.` : ""}
          </p>
        </form>
      </Card>

      {versionChange && <VersionChangeDialog detail={versionChange} returnFocusTo={saveRef} loading={mutation.isPending} onCancel={() => setVersionChange(null)} onConfirm={() => void send({ ...payload, confirmVersionChange: true })} />}
    </div>
  )
}

/**
 * Confirmação EXPLÍCITA de mudança de versão: explica a consequência (todos os motoristas aceitam de novo), mostra a versão de antes e de depois e o número de motoristas, e só habilita
 * "Confirmar" depois de marcar que entendeu. Fechar/voltar não grava nada (o 409 já não gravou). O foco entra no diálogo (Radix) e volta ao "Salvar" ao fechar (explícito: ele abre depois de uma resposta assíncrona).
 */
function VersionChangeDialog({ detail, returnFocusTo, loading, onCancel, onConfirm }: { detail: VersionChangeDetail; returnFocusTo: RefObject<HTMLButtonElement | null>; loading: boolean; onCancel: () => void; onConfirm: () => void }) {
  const checkId = useId()
  const [understood, setUnderstood] = useState(false)
  const drivers = detail.driversAffected
  const termsChanged = detail.currentTermsVersion !== detail.newTermsVersion
  const privacyChanged = detail.currentPrivacyVersion !== detail.newPrivacyVersion
  return (
    <Dialog open onOpenChange={(open) => !open && !loading && onCancel()}>
      <DialogContent
        widthClassName="sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          // O diálogo abre DEPOIS da resposta 409 (o "Salvar" estava desabilitado e sem foco): o foco volta ao botão, não ao <body>.
          event.preventDefault()
          returnFocusTo.current?.focus()
        }}
      >
        <DialogHeader icon={Users}>
          <DialogTitle>Mudar a versão dos documentos?</DialogTitle>
          <DialogDescription>
            {drivers === 1 ? "1 motorista" : `Todos os ${drivers} motoristas`} {drivers === 1 ? "terá" : "terão"} de aceitar os documentos de novo no próximo acesso ao aplicativo.
          </DialogDescription>
        </DialogHeader>
        <dl className="divide-y divide-border-subtle rounded-xl border border-border bg-surface" data-testid="version-change-summary">
          {termsChanged && (
            <div className="flex flex-col gap-0.5 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <dt className="text-sm font-medium text-ink-soft">Termos de Uso</dt>
              <dd className="text-sm font-semibold text-ink">
                <span className="font-normal text-ink-softer">{detail.currentTermsVersion}</span> para {detail.newTermsVersion}
              </dd>
            </div>
          )}
          {privacyChanged && (
            <div className="flex flex-col gap-0.5 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <dt className="text-sm font-medium text-ink-soft">Política de Privacidade</dt>
              <dd className="text-sm font-semibold text-ink">
                <span className="font-normal text-ink-softer">{detail.currentPrivacyVersion}</span> para {detail.newPrivacyVersion}
              </dd>
            </div>
          )}
        </dl>
        <label htmlFor={checkId} className="mt-4 flex min-h-11 items-start gap-3 text-sm text-ink">
          <input
            id={checkId}
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            disabled={loading}
            className="mt-0.5 h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
            data-testid="version-change-understood"
          />
          <span>Entendo que todos os motoristas terão de aceitar os documentos de novo.</span>
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" size="touch" onClick={onCancel} disabled={loading}>
            <X className="h-4 w-4" aria-hidden="true" />
            Voltar
          </Button>
          <Button type="button" size="touch" loading={loading} disabled={!understood} onClick={onConfirm} data-testid="version-change-confirm">
            {!loading && <Check className="h-4 w-4" aria-hidden="true" />}
            Confirmar e salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
