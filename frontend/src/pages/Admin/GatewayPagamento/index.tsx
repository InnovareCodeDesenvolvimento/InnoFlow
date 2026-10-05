import { useEffect, useRef, useState } from "react"
import { CreditCard, Info, QrCode, RotateCcw, Save, TriangleAlert, Vault } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { Skeleton } from "@/components/ui/Skeleton"
import { cn } from "@/lib/utils"
import type { PaymentGatewayConfigDTO } from "@/types/api"
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

/** Esqueleto com a FORMA da tela pronta (banner de origem, 2 meios, ambiente, credenciais, teste, webhook): evita salto de layout quando os dados chegam. */
function GatewaySkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando configuração do gateway">
      <Skeleton className="h-14 w-full rounded-xl" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-56 w-full rounded-card" />
        <Skeleton className="h-56 w-full rounded-card" />
      </div>
      <Skeleton className="h-56 w-full rounded-card" />
      <Skeleton className="h-80 w-full rounded-card" />
      <Skeleton className="h-40 w-full rounded-card" />
      <Skeleton className="h-48 w-full rounded-card" />
    </div>
  )
}

const PAGE_TITLE = "Gateway de pagamento"
const PAGE_DESCRIPTION = "Conta Cielo da plataforma: credenciais, ambiente e meios de pagamento."

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
  const forbidden = getApiErrorStatus(error) === 403

  return (
    <div className="space-y-6">
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} icon={Vault} />

      {isLoading && <GatewaySkeleton />}

      {!isLoading && (isError || !dto) && (
        <ErrorState
          message={
            forbidden
              ? "Somente administradores podem ver e alterar o gateway de pagamento."
              : (parseGatewayLoadError(error) ?? getApiErrorMessage(error, "Não foi possível carregar a configuração do gateway."))
          }
          onRetry={forbidden ? undefined : () => void refetch()}
        />
      )}

      {!isLoading && !isError && dto && <GatewayEditor dto={dto} />}
    </div>
  )
}

/** O formulário em si. Só existe com o DTO carregado (o rascunho nasce vazio junto com ele) e devolve os blocos como irmãos, para herdarem o `space-y-6` da página. */
function GatewayEditor({ dto }: { dto: PaymentGatewayConfigDTO }) {
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
    <>
      {dto.secretsDecryptable === false && <UnreadableSecretsAlert />}
      {dto.sandboxRestricted && <SandboxRestrictedBanner />}

      <SourceBanner source={dto.source} updatedAt={dto.updatedAt} />

      {saveError && (
        <Alert ref={errorRef} tone="danger" role="alert" icon={TriangleAlert} data-testid="save-error" data-code={saveError.code}>
          <p className="font-semibold">{saveError.message}</p>
          {saveError.draftKept && <p className="mt-1 text-xs font-medium">O que você preencheu continua na tela.</p>}
          {saveError.requirements.length > 0 && saveError.code === "GATEWAY_NOT_READY" && (
            <div className="mt-3 rounded-lg bg-surface p-3 text-ink">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-softer">O que falta</p>
              <RequirementList codes={saveError.requirements} testId="save-error-missing" />
            </div>
          )}
        </Alert>
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
        <Alert tone="muted" size="sm" icon={Info}>
          <p>A prontidão considera só o que já está salvo. Preencha e salve as credenciais primeiro; depois o interruptor do meio fica disponível.</p>
        </Alert>
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

      {/* Barra de salvar: um card como os outros. Com alteração pendente ela gruda no fim da área de rolagem do shell (o <main> do admin), sempre ao alcance;
          sem alteração fica no fim da página, sem tapar conteúdo (a 375 px a barra grudada ocupava ~25% da tela mesmo sem nada a salvar). */}
      <Card className={cn("z-10", dirty && "sticky bottom-0 shadow-tinted-card")} data-testid="save-bar">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-4">
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
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button type="button" variant="outline" size="touch" onClick={handleDiscard} disabled={(!dirty && Object.keys(draft).length === 0) || mutation.isPending}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Descartar
            </Button>
            <Button
              type="button"
              size="touch"
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
        </CardContent>
      </Card>

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
    </>
  )
}
