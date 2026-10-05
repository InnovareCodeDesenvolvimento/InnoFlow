import { useEffect, useRef, useState } from "react"
import { CreditCard, Info, QrCode, RotateCcw, Save, TriangleAlert, Vault } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { Button } from "@/components/ui/Button"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { Skeleton } from "@/components/ui/Skeleton"
import { usePaymentGatewayConfig, useUpdatePaymentGateway } from "@/hooks/usePaymentGateway"
import { getApiErrorMessage, getApiErrorStatus } from "@/services/api"
import {
  buildUpdatePayload,
  describeChanges,
  hasChanges,
  parseGatewayLoadError,
  parseGatewaySaveError,
  validateCredentialPairs,
  validateDraft,
  withCurrentPassword,
  type GatewayDraft,
  type GatewaySaveError,
} from "@/lib/paymentGateway"
import { ConfirmProductionDialog } from "./ConfirmProductionDialog"
import { ConnectionTestSection } from "./ConnectionTestSection"
import { ConfirmSaveDialog } from "./ConfirmSaveDialog"
import { CredentialsSection } from "./CredentialsSection"
import { EnvironmentSection } from "./EnvironmentSection"
import { MethodCard } from "./MethodCard"
import { RequirementList } from "./RequirementList"
import { SourceBanner } from "./SourceBanner"
import { SandboxRestrictedBanner, UnreadableSecretsAlert } from "./StatusBanners"
import { WebhookSection } from "./WebhookSection"

function GatewaySkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando configuração do gateway">
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-56 w-full rounded-card" />
        <Skeleton className="h-56 w-full rounded-card" />
      </div>
      <Skeleton className="h-48 w-full rounded-card" />
      <Skeleton className="h-64 w-full rounded-card" />
    </div>
  )
}

/**
 * Admin → Gateway de pagamento (F5.5). ADMIN-ONLY (a conta Cielo é única da
 * plataforma): o guarda de papel mora na ROTA (`RequireAuth roles=["ADMIN"]`)
 * e o servidor confere de novo (403 `FORBIDDEN`).
 *
 * Estado: o servidor é a fonte da verdade (`useQuery`); o que o admin edita é
 * um RASCUNHO de sobreposições (`GatewayDraft`) por cima do DTO carregado — não
 * uma cópia dele, então não há efeito sincronizando estado a partir de dado
 * assíncrono. Salvar envia só o diff; segredos só existem no rascunho
 * enquanto o admin os digita e são descartados junto com ele depois do PUT.
 */
export default function GatewayPagamentoPage() {
  const { data: dto, isLoading, isError, error, refetch } = usePaymentGatewayConfig()
  const mutation = useUpdatePaymentGateway()

  const [draft, setDraft] = useState<GatewayDraft>({})
  const [productionDialogOpen, setProductionDialogOpen] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState<GatewaySaveError | null>(null)
  // 403 INVALID_CURRENT_PASSWORD: o erro vive no diálogo de salvar (que continua aberto), não no alerta da página.
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (saveError) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [saveError])

  const patchDraft = (patch: Partial<GatewayDraft>) => setDraft((prev) => ({ ...prev, ...patch }))

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <PageHeader title="Gateway de pagamento" description="Conta Cielo da plataforma: credenciais, ambiente e meios de pagamento." icon={Vault} />
        <GatewaySkeleton />
      </div>
    )
  }

  if (isError || !dto) {
    const forbidden = getApiErrorStatus(error) === 403
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <PageHeader title="Gateway de pagamento" description="Conta Cielo da plataforma: credenciais, ambiente e meios de pagamento." icon={Vault} />
        <ErrorState
          message={
            forbidden
              ? "Somente administradores podem ver e alterar o gateway de pagamento."
              : (parseGatewayLoadError(error) ?? getApiErrorMessage(error, "Não foi possível carregar a configuração do gateway."))
          }
          onRetry={forbidden ? undefined : () => void refetch()}
        />
      </div>
    )
  }

  const payload = buildUpdatePayload(dto, draft)
  const changes = describeChanges(dto, payload)
  const errors = { ...validateDraft(draft), ...validateCredentialPairs(dto, payload) }
  const dirty = hasChanges(payload)
  const canSave = dirty && Object.keys(errors).length === 0 && !mutation.isPending

  const environment = draft.environment ?? dto.environment
  const pendingProduction = environment === "production" && dto.environment !== "production"
  const cardEnabled = draft.cardEnabled ?? dto.cardEnabled
  const pixEnabled = draft.pixEnabled ?? dto.pixEnabled

  const handleRequestProduction = () => {
    // Já está em produção no servidor (voltando atrás num rascunho): não há o que confirmar.
    if (dto.environment === "production") patchDraft({ environment: "production", productionConfirmed: undefined })
    else setProductionDialogOpen(true)
  }

  const handleDiscard = () => {
    setDraft({})
    setSaveError(null)
  }

  const closeSaveDialog = () => {
    setSaveDialogOpen(false)
    setPasswordError(null)
  }

  const handleSave = async (currentPassword: string) => {
    if (!dirty || mutation.isPending) return
    setSaveError(null)
    setPasswordError(null)
    try {
      await mutation.mutateAsync(withCurrentPassword(payload, currentPassword))
      // Segredos digitados morrem aqui: o rascunho inteiro é descartado (o DTO novo já está no cache).
      setDraft({})
      closeSaveDialog()
      toast.success("Configuração do gateway salva.")
    } catch (err) {
      const parsed = parseGatewaySaveError(err)
      if (parsed.code === "INVALID_CURRENT_PASSWORD") {
        // Senha errada: o diálogo fica aberto com o erro; o rascunho (e a sessão — é 403, não 401) seguem intactos.
        setPasswordError(parsed.message)
      } else {
        closeSaveDialog()
        setSaveError(parsed)
      }
    } finally {
      // Órion B7: `mutation.variables` guardaria o corpo do PUT (segredos + senha) na memória até o próximo envio.
      mutation.reset()
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Gateway de pagamento" description="Conta Cielo da plataforma: credenciais, ambiente e meios de pagamento." icon={Vault} />

      {dto.secretsDecryptable === false && <UnreadableSecretsAlert />}
      {dto.sandboxRestricted && <SandboxRestrictedBanner />}

      <SourceBanner source={dto.source} updatedAt={dto.updatedAt} />

      {saveError && (
        <div ref={errorRef} role="alert" className="space-y-3 rounded-xl border border-danger-600/40 bg-danger-50 p-4 text-danger-700" data-testid="save-error" data-code={saveError.code}>
          <p className="flex items-start gap-2 text-sm font-semibold">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{saveError.message}</span>
          </p>
          {saveError.draftKept && <p className="pl-6 text-xs font-medium">O que você preencheu continua na tela.</p>}
          {saveError.requirements.length > 0 && saveError.code === "GATEWAY_NOT_READY" && (
            <div className="rounded-lg bg-white/70 p-3 text-ink">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-softer">O que falta</p>
              <RequirementList codes={saveError.requirements} testId="save-error-missing" />
            </div>
          )}
        </div>
      )}

      <section aria-label="Meios de pagamento" className="space-y-3">
        <div className="grid gap-4 md:grid-cols-2">
          <MethodCard
            id="pix"
            title="Pix"
            icon={QrCode}
            readiness={dto.readiness.pix}
            enabled={pixEnabled}
            onEnabledChange={(value) => patchDraft({ pixEnabled: value })}
            offEffect="Desabilitar bloqueia apenas NOVAS recargas por Pix; as que já foram geradas seguem valendo até terminar."
            disabled={mutation.isPending}
          />
          <MethodCard
            id="card"
            title="Cartão"
            icon={CreditCard}
            readiness={dto.readiness.card}
            enabled={cardEnabled}
            onEnabledChange={(value) => patchDraft({ cardEnabled: value })}
            offEffect="Desabilitar bloqueia apenas NOVAS cobranças e NOVOS cadastros de cartão; sessões e cobranças já em andamento terminam normalmente."
            disabled={mutation.isPending}
          />
        </div>
        <p className="flex items-start gap-2 text-xs text-ink-softer">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>A prontidão considera só o que já está salvo. Preencha e salve as credenciais primeiro; depois o interruptor do meio fica disponível.</span>
        </p>
      </section>

      <EnvironmentSection
        value={environment}
        savedValue={dto.environment}
        pendingProduction={pendingProduction}
        onSelectSandbox={() => patchDraft({ environment: "sandbox", productionConfirmed: undefined })}
        onRequestProduction={handleRequestProduction}
      />

      <CredentialsSection dto={dto} draft={draft} errors={errors} onChange={patchDraft} />

      <ConnectionTestSection hasUnsavedCredentials={dirty} />

      <WebhookSection dto={dto} draft={draft} errors={errors} onChange={patchDraft} />

      {/* Barra de salvar: gruda no fim da área de rolagem do shell (o <main> do admin), sempre ao alcance. */}
      <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-surface px-4 py-3 shadow-[0_-10px_24px_-18px_rgb(var(--color-primary)/0.4)] sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" data-testid="save-bar">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-softer" aria-live="polite" data-testid="save-bar-status">
            {dirty ? (
              <>
                <span className="font-semibold text-ink">
                  {changes.length} {changes.length === 1 ? "alteração não salva" : "alterações não salvas"}
                </span>
                {Object.keys(errors).length > 0 && (
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
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={handleDiscard} disabled={(!dirty && Object.keys(draft).length === 0) || mutation.isPending}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Descartar
            </Button>
            <Button
              type="button"
              onClick={() => {
                setSaveError(null)
                setPasswordError(null)
                setSaveDialogOpen(true)
              }}
              disabled={!canSave}
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              Salvar alterações
            </Button>
          </div>
        </div>
      </div>

      {productionDialogOpen && (
        <ConfirmProductionDialog
          onCancel={() => setProductionDialogOpen(false)}
          onConfirm={() => {
            patchDraft({ environment: "production", productionConfirmed: true })
            setProductionDialogOpen(false)
          }}
        />
      )}

      {saveDialogOpen && dirty && (
        <ConfirmSaveDialog
          items={changes}
          goesToProduction={payload.environment === "production"}
          loading={mutation.isPending}
          passwordError={passwordError}
          onCancel={closeSaveDialog}
          onConfirm={(currentPassword) => void handleSave(currentPassword)}
        />
      )}
    </div>
  )
}
