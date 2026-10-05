import { CircleCheck, CircleX, HardDriveUpload, TriangleAlert } from "lucide-react"
import { SecretControl } from "@/components/admin/SecretControl"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Segmented } from "@/components/ui/Segmented"
import { DESTINATION_LABELS, effectiveOf, s3HostChanged, type BackupDraft, type DraftErrors } from "@/lib/backup"
import type { BackupConfigDTO, BackupDestination } from "@/types/api"
import { DriveFields } from "./DriveFields"
import { SectionHeader } from "./parts"

type ClearKey = "s3AccessKey" | "s3SecretKey" | "driveClientSecret"
export interface DestinationPatch {
  destination?: BackupDestination | null
  s3?: Partial<BackupDraft["s3"]>
  drive?: Partial<BackupDraft["drive"]>
}

type Choice = "NONE" | BackupDestination

/**
 * Destino: UM por vez (Bucket S3-compatível ou Google Drive) ou nenhum. O destino escolhido é o que o backup usa; trocar de destino NÃO apaga o que está preenchido no outro.
 * S3: endereço, região, bucket, pasta, chave de acesso e segredo (só-escrita; a tela mostra "Configurada"). Trocar o ENDEREÇO do bucket com credencial salva abre os dois campos de
 * credencial: as duas precisam ser digitadas de novo (o servidor recusa se não, `SECRET_REQUIRED_FOR_NEW_DESTINATION`).
 */
export function DestinationSection({
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
  onChange: (patch: DestinationPatch) => void
  onMarkClear: (key: ClearKey, marked: boolean) => void
  disabled: boolean
  dirty: boolean
}) {
  const eff = effectiveOf(dto, draft)
  const choice: Choice = eff.destination ?? "NONE"
  const hostChanged = s3HostChanged(dto, draft)

  return (
    <Card data-testid="section-destination">
      <SectionHeader
        icon={HardDriveUpload}
        title="Destino"
        description="Onde as cópias ficam guardadas, fora do servidor do banco. Um destino por vez."
        aside={
          dto.destination === null ? (
            <Badge variant="neutral" data-testid="destination-status">
              Nenhum destino
            </Badge>
          ) : dto.destinationReady ? (
            <Badge variant="success" data-testid="destination-status">
              <CircleCheck className="h-3 w-3" aria-hidden="true" />
              {DESTINATION_LABELS[dto.destination]}: pronto
            </Badge>
          ) : (
            <Badge variant="warning" data-testid="destination-status">
              <CircleX className="h-3 w-3" aria-hidden="true" />
              {DESTINATION_LABELS[dto.destination]}: incompleto
            </Badge>
          )
        }
      />
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-ink-soft">Guardar as cópias em</p>
          <Segmented<Choice>
            label="Destino do backup"
            value={choice}
            onChange={(value) => onChange({ destination: value === "NONE" ? null : value })}
            options={[
              { value: "NONE", label: "Nenhum" },
              { value: "S3", label: "Bucket S3" },
              { value: "DRIVE", label: "Google Drive" },
            ]}
          />
          {errors.destination && (
            <p role="alert" className="text-xs font-medium text-danger-700" data-testid="destination-error">
              {errors.destination}
            </p>
          )}
          {choice === "NONE" && (
            <p className="text-xs text-ink-softer" data-testid="destination-none-note">
              Sem destino, “Fazer backup agora” só testa o pg_dump (copia, confere e descarta) e o automático não liga. Uma cópia que fica no mesmo servidor do banco morre junto com ele.
            </p>
          )}
        </div>

        {choice === "S3" && (
          <div className="space-y-5" data-testid="s3-fields">
            <Input
              label="Endereço do bucket"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
              placeholder="https://SEU-ID.r2.cloudflarestorage.com"
              value={eff.s3.endpoint}
              onChange={(e) => onChange({ s3: { endpoint: e.target.value } })}
              error={errors["s3.endpoint"]}
              hint="O endereço público do serviço (R2, Backblaze, AWS…), com https. Endereço da rede interna é recusado."
              disabled={disabled}
              data-testid="s3-endpoint"
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                label="Bucket"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={eff.s3.bucket}
                onChange={(e) => onChange({ s3: { bucket: e.target.value } })}
                error={errors["s3.bucket"]}
                disabled={disabled}
                data-testid="s3-bucket"
              />
              <Input
                label="Região (opcional)"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="auto"
                value={eff.s3.region}
                onChange={(e) => onChange({ s3: { region: e.target.value } })}
                error={errors["s3.region"]}
                hint="Ex.: us-east-1. No Cloudflare R2, use auto."
                disabled={disabled}
                data-testid="s3-region"
              />
            </div>
            <Input
              label="Pasta dentro do bucket (opcional)"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="producao"
              value={eff.s3.prefix}
              onChange={(e) => onChange({ s3: { prefix: e.target.value } })}
              error={errors["s3.prefix"]}
              disabled={disabled}
              data-testid="s3-prefix"
            />
            {hostChanged && (
              <Alert tone="warning" size="sm" role="status" icon={TriangleAlert} className="font-medium" data-testid="s3-host-changed">
                <p>Você mudou o endereço do bucket: digite a chave de acesso E o segredo de novo. Elas só valem para o destino em que foram salvas.</p>
              </Alert>
            )}
            <div className="grid gap-5 sm:grid-cols-2">
              <SecretControl
                testId="secret-s3AccessKey"
                name="Chave de acesso"
                removeLabel="Apagar a chave de acesso salva"
                isSet={dto.s3.accessKeySet}
                unreadable={!dto.secretsReadable}
                value={draft.s3.accessKey}
                onChange={(value) => onChange({ s3: { accessKey: value } })}
                markedForRemoval={Boolean(draft.clear.s3AccessKey)}
                onMarkRemoval={(marked) => onMarkClear("s3AccessKey", marked)}
                error={errors["s3.accessKey"]}
                hint="Guardada cifrada no servidor; nunca volta para esta tela."
              />
              <SecretControl
                testId="secret-s3SecretKey"
                name="Segredo"
                removeLabel="Apagar o segredo salvo"
                isSet={dto.s3.secretKeySet}
                unreadable={!dto.secretsReadable}
                value={draft.s3.secretKey}
                onChange={(value) => onChange({ s3: { secretKey: value } })}
                markedForRemoval={Boolean(draft.clear.s3SecretKey)}
                onMarkRemoval={(marked) => onMarkClear("s3SecretKey", marked)}
                error={errors["s3.secretKey"]}
                hint="Guardado cifrado no servidor; nunca volta para esta tela."
              />
            </div>
          </div>
        )}

        {choice === "DRIVE" && (
          <DriveFields
            dto={dto}
            draft={draft}
            errors={errors}
            onChange={(patch) => onChange({ drive: patch })}
            onMarkClear={(marked) => onMarkClear("driveClientSecret", marked)}
            disabled={disabled}
            dirty={dirty}
          />
        )}
      </CardContent>
    </Card>
  )
}
