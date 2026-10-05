import { useId, useState } from "react"
import { CircleCheck, CircleX, Copy, Link2, TriangleAlert, Unlink } from "lucide-react"
import { toast } from "sonner"
import { SecretControl } from "@/components/admin/SecretControl"
import { ConfirmSaveDialog } from "@/components/admin/ConfirmSaveDialog"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { InlineCode } from "@/components/ui/InlineCode"
import { Input } from "@/components/ui/Input"
import { useGoogleDisconnect, useGoogleStart } from "@/hooks/useBackup"
import { connectBlockReason, formatBrasilia, isSafeGoogleUrl, parseBackupError, type BackupDraft, type BackupError, type DraftErrors } from "@/lib/backup"
import type { BackupConfigDTO } from "@/types/api"
import { HelpPanel, HelpToggle } from "./parts"

async function copyText(text: string, okMessage: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(okMessage)
  } catch {
    toast.error("O navegador não deixou copiar. Selecione o texto e copie à mão.")
  }
}

/** Conectar/reconectar/desconectar a conta Google (cada uma pede a senha atual). A senha vive só no diálogo; a mutation é zerada (`reset`) depois. */
function DriveConnection({ dto, dirty, disabled }: { dto: BackupConfigDTO; dirty: boolean; disabled: boolean }) {
  const start = useGoogleStart()
  const disconnect = useGoogleDisconnect()
  const [dialog, setDialog] = useState<null | "connect" | "disconnect">(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [error, setError] = useState<BackupError | null>(null)
  const connected = dto.drive.connected
  const reason = connectBlockReason(dto, dirty)
  const pending = start.isPending || disconnect.isPending

  const close = () => {
    setDialog(null)
    setPasswordError(null)
  }

  async function handleConnect(currentPassword: string) {
    setError(null)
    setPasswordError(null)
    try {
      const { url } = await start.mutateAsync({ currentPassword })
      if (!isSafeGoogleUrl(url)) {
        close()
        setError({ code: "UNEXPECTED_URL", status: undefined, message: "O servidor devolveu um endereço inesperado para o login do Google. Nada foi feito. Avise quem cuida da infraestrutura.", fields: [], draftKept: true })
        return
      }
      // A página sai daqui: o diálogo fica "carregando" até o navegador trocar de endereço.
      window.location.assign(url)
    } catch (err) {
      const parsed = parseBackupError(err)
      if (parsed.code === "INVALID_CURRENT_PASSWORD") setPasswordError(parsed.message)
      else {
        close()
        setError(parsed)
      }
    } finally {
      start.reset()
    }
  }

  async function handleDisconnect(currentPassword: string) {
    setError(null)
    setPasswordError(null)
    try {
      await disconnect.mutateAsync({ currentPassword })
      close()
      toast.success("Conta Google desconectada.")
    } catch (err) {
      const parsed = parseBackupError(err)
      if (parsed.code === "INVALID_CURRENT_PASSWORD") setPasswordError(parsed.message)
      else {
        close()
        setError(parsed)
      }
    } finally {
      disconnect.reset()
    }
  }

  return (
    <div className="space-y-3" data-testid="drive-connection">
      {connected ? (
        <Alert tone="success" role="status" icon={CircleCheck} data-testid="drive-connected">
          <p>
            <span className="font-bold">Conectado como {dto.drive.accountEmail ?? "uma conta Google"}</span>
            {dto.drive.connectedAt ? ` desde ${formatBrasilia(dto.drive.connectedAt)}` : ""}.
          </p>
          <p className="mt-0.5 text-xs">As cópias vão para a pasta “Backups InnoFlow” no Drive dessa conta. O sistema só enxerga o que ele mesmo criou ali.</p>
        </Alert>
      ) : (
        <Alert tone="info" role="status" icon={CircleX} data-testid="drive-disconnected">
          <p>
            <span className="font-bold">Conta Google não conectada.</span> Sem ela o destino Google Drive não funciona.
          </p>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <Button
          type="button"
          size="touch"
          variant={connected ? "outline" : "default"}
          onClick={() => setDialog("connect")}
          disabled={disabled || pending || reason !== null}
          aria-describedby="drive-connect-reason"
          data-testid="drive-connect"
        >
          <Link2 className="h-4 w-4" aria-hidden="true" />
          {connected ? "Reconectar com Google" : "Conectar com Google"}
        </Button>
        {connected && (
          <Button type="button" size="touch" variant="outline" onClick={() => setDialog("disconnect")} disabled={disabled || pending} data-testid="drive-disconnect">
            <Unlink className="h-4 w-4" aria-hidden="true" />
            Desconectar
          </Button>
        )}
      </div>
      <p id="drive-connect-reason" className="text-xs font-medium text-ink-soft" data-testid="drive-connect-reason" hidden={reason === null}>
        {reason}
      </p>

      {error && (
        <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="drive-error" data-code={error.code}>
          <p>{error.message}</p>
        </Alert>
      )}

      {dialog === "connect" && (
        <ConfirmSaveDialog
          title="Conectar com o Google"
          description="Você vai para o Google autorizar o acesso a uma pasta de backups no seu Drive. Depois volta para esta tela."
          passwordHint="Pedida para que só quem conhece a senha possa ligar o backup a uma conta Google."
          confirmLabel="Confirmar e ir ao Google"
          items={[{ key: "action", label: "O que acontece", to: "Abre o Google para você autorizar" }]}
          loading={start.isPending}
          passwordError={passwordError}
          onCancel={close}
          onConfirm={(password) => void handleConnect(password)}
        />
      )}
      {dialog === "disconnect" && (
        <ConfirmSaveDialog
          title="Desconectar a conta Google"
          description="O acesso é revogado no Google e a conexão é apagada aqui. O Client ID e o Client Secret ficam salvos."
          passwordHint="Pedida em toda alteração do destino do backup."
          confirmLabel="Confirmar e desconectar"
          destructive
          items={[{ key: "action", label: "Conta Google", from: dto.drive.accountEmail ?? "Conectada", to: "Será desconectada" }]}
          extra={
            dto.enabled && dto.destination === "DRIVE" ? (
              <Alert tone="warning" size="sm" role="status" icon={TriangleAlert} className="mt-4 font-medium" data-testid="disconnect-warning">
                <p>O backup automático está ligado com o destino Google Drive: o próximo backup agendado vai FALHAR até você conectar a conta de novo.</p>
              </Alert>
            ) : undefined
          }
          loading={disconnect.isPending}
          passwordError={passwordError}
          onCancel={close}
          onConfirm={(password) => void handleDisconnect(password)}
        />
      )}
    </div>
  )
}

/** Campos do destino Google Drive: "Como acessar o Drive ⓘ" (passo a passo + dica "Em produção"), o endereço de retorno a cadastrar no Google Cloud (com "Copiar"), Client ID, Client Secret (só-escrita) e a conexão da conta. */
export function DriveFields({
  dto,
  draft,
  errors,
  onChange,
  onMarkClear,
  disabled,
  dirty,
}: {
  dto: BackupConfigDTO
  draft: BackupDraft
  errors: DraftErrors
  onChange: (patch: Partial<BackupDraft["drive"]>) => void
  onMarkClear: (marked: boolean) => void
  disabled: boolean
  dirty: boolean
}) {
  const clientId = draft.drive.clientId ?? dto.drive.clientId ?? ""
  const clientIdChanging = draft.drive.clientId !== undefined && draft.drive.clientId.trim() !== (dto.drive.clientId ?? "")
  const redirectUri = dto.drive.redirectUri
  // O "ⓘ" do passo a passo é estado local deste bloco (nada fora dele precisa saber se está aberto).
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = useId()

  return (
    <div className="space-y-5" data-testid="drive-fields">
      <div>
        <div className="flex items-center gap-1">
          <p className="text-sm font-medium text-ink-soft">Como acessar o Drive</p>
          <HelpToggle open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} panelId={helpId} label="Como acessar o Drive" testId="drive-help" className="-my-1.5" />
        </div>
        <HelpPanel id={helpId} open={helpOpen} testId="drive-help-panel">
          <ol className="list-decimal space-y-1 pl-5 text-xs">
            <li>No Google Cloud, crie um app OAuth do tipo “Aplicativo da Web” e ative a API do Google Drive.</li>
            <li>Cadastre o endereço de retorno abaixo como “URI de redirecionamento autorizado”.</li>
            <li>Cole o Client ID e o Client Secret aqui e salve.</li>
            <li>Clique em “Conectar com Google” e autorize.</li>
          </ol>
          <Alert tone="warning" size="sm" role="note" icon={TriangleAlert} className="font-medium" data-testid="drive-production-tip">
            <p>O app do Google Cloud precisa estar “Em produção”. Em modo “Teste” o acesso expira em 7 dias e o backup passa a falhar (conta desconectada).</p>
          </Alert>
        </HelpPanel>
      </div>

      {redirectUri ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <Input label="Endereço de retorno (cadastre no Google Cloud)" readOnly value={redirectUri} onFocus={(e) => e.currentTarget.select()} data-testid="drive-redirect-uri" className="font-mono" />
          </div>
          <Button type="button" variant="outline" size="field" className="sm:mt-[1.625rem]" onClick={() => void copyText(redirectUri, "Endereço de retorno copiado.")} data-testid="drive-redirect-copy">
            <Copy className="h-4 w-4" aria-hidden="true" />
            Copiar
          </Button>
        </div>
      ) : (
        <Alert tone="warning" role="status" icon={TriangleAlert} data-testid="drive-redirect-unknown">
          <p>
            <span className="font-bold">O servidor não sabe o próprio endereço público.</span> Por isso não dá para mostrar o endereço de retorno. Quem cuida da infraestrutura precisa definir <InlineCode>PUBLIC_API_BASE_URL</InlineCode> (e{" "}
            <InlineCode>PUBLIC_APP_URL</InlineCode>) no deploy.
          </p>
        </Alert>
      )}

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <Input
          label="Client ID"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={clientId}
          onChange={(e) => onChange({ clientId: e.target.value })}
          error={errors["drive.clientId"]}
          hint="Trocar o Client ID desconecta a conta Google (o acesso é por app)."
          disabled={disabled}
          data-testid="drive-client-id"
        />
        <SecretControl
          testId="secret-driveClientSecret"
          name="Client Secret"
          removeLabel="Apagar o Client Secret salvo"
          isSet={dto.drive.clientSecretSet}
          unreadable={!dto.secretsReadable}
          value={draft.drive.clientSecret}
          onChange={(value) => onChange({ clientSecret: value })}
          markedForRemoval={Boolean(draft.clear.driveClientSecret)}
          onMarkRemoval={onMarkClear}
          error={errors["drive.clientSecret"]}
          hint="Guardado cifrado no servidor; nunca volta para esta tela."
        />
      </div>
      {clientIdChanging && dto.drive.connected && (
        <Alert tone="warning" size="sm" role="status" icon={TriangleAlert} className="font-medium" data-testid="drive-client-id-disconnects">
          <p>Ao salvar com outro Client ID, a conta Google conectada ({dto.drive.accountEmail ?? "atual"}) será desconectada e você precisará conectar de novo.</p>
        </Alert>
      )}

      <DriveConnection dto={dto} dirty={dirty} disabled={disabled} />
    </div>
  )
}
