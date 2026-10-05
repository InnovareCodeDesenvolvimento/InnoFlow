import { Dices, Info, Webhook } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { InlineCode } from "@/components/ui/InlineCode"
import { Input } from "@/components/ui/Input"
import { generateRandomSecret, WEBHOOK_SECRET_MIN, type DraftErrors, type GatewayDraft } from "@/lib/paymentGateway"
import type { PaymentGatewayConfigDTO } from "@/types/api"
import { CopyButton } from "./CopyButton"
import { SecretField } from "@/components/admin/SecretField"

/**
 * Webhook da Cielo — NÃO USADO nesta instalação. A conta Cielo é COMPARTILHADA com o Parque (decisão do dono): o InnoFlow não recebe notificação da Cielo
 * (o Pix é creditado por consulta periódica), e a URL de notificação do Site Cielo pertence ao Parque. Cadastrar uma URL lá a SOBRESCREVERIA. Por isso a
 * seção NUNCA instrui a cadastrar nada: quando o servidor ainda devolve URL/segredo (variável de ambiente ou segredo antigo), os dados continuam aqui, só
 * para consulta e limpeza, sob um aviso permanente.
 *
 * A URL e o nome do header são só leitura (com copiar); o segredo do header é só de escrita como os outros — com um atalho para GERAR um aleatório e MOSTRÁ-LO
 * (único momento em que um segredo aparece em texto: o admin precisa copiar ANTES de salvar, porque depois de salvo ele nunca mais volta).
 */
export function WebhookSection({
  dto,
  draft,
  errors,
  onChange,
}: {
  dto: PaymentGatewayConfigDTO
  draft: GatewayDraft
  errors: DraftErrors
  onChange: (patch: Partial<GatewayDraft>) => void
}) {
  // Nada configurado e nada a cadastrar: situação normal desta conta compartilhada, não pendência. Se ALGO já está configurado (URL ou segredo),
  // os campos continuam aparecendo (somente para consulta) para o admin conferir ou limpar.
  const notInUse = dto.webhookInUse === false && !dto.webhookUrl && !dto.webhookHeaderSecretSet && draft.webhookHeaderSecret === undefined
  const revealed = !!draft.webhookSecretRevealed && !!draft.webhookHeaderSecret
  const secretValue = draft.webhookHeaderSecret

  // `undefined` = cancelou a substituição (esconde e esquece). Digitar à mão num segredo gerado mantém o campo visível; um campo normal continua mascarado.
  const handleSecretChange = (value: string | undefined) => {
    if (value === undefined) onChange({ webhookHeaderSecret: undefined, webhookSecretRevealed: undefined })
    else onChange({ webhookHeaderSecret: value, webhookSecretRevealed: draft.webhookSecretRevealed && value !== "" ? true : undefined })
  }

  if (notInUse) {
    return (
      <Card data-testid="section-webhook">
        <CardHeader>
          <CardTitle as="h2">Webhook</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert tone="warning" role="status" icon={Webhook} data-testid="webhook-not-in-use">
            <p>
              <span className="font-bold">Webhook não usado (conta compartilhada).</span> O Pix é creditado por consulta periódica à Cielo, então não há URL nem header para cadastrar.
            </p>
            <p className="mt-1 font-semibold">Não cadastre URL de notificação no Site Cielo: ela substituiria a URL do Parque, que usa esta mesma conta.</p>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-testid="section-webhook">
      <CardHeader>
        <CardTitle as="h2">Webhook</CardTitle>
        <CardDescription>Dados que o servidor ainda guarda para o webhook — somente para consulta ou para limpar. O InnoFlow não usa webhook nesta conta.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Alert tone="warning" role="status" icon={Webhook} data-testid="webhook-shared-account-warning">
          <p>
            <span className="font-bold">Webhook não usado nesta conta compartilhada.</span> O Pix é creditado por consulta periódica à Cielo.
          </p>
          <p className="mt-1 font-semibold">Não cadastre URL de notificação no Site Cielo: ela substituiria a URL do Parque, que usa esta mesma conta.</p>
        </Alert>

        <div className="space-y-1.5">
          {dto.webhookUrl ? (
            <label htmlFor="webhook-url" className="block text-sm font-medium text-ink-soft">
              URL do webhook
            </label>
          ) : (
            <p className="block text-sm font-medium text-ink-soft">URL do webhook</p>
          )}
          {dto.webhookUrl ? (
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Input id="webhook-url" readOnly value={dto.webhookUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono" />
              </div>
              <CopyButton value={dto.webhookUrl} label="Copiar URL do webhook" />
            </div>
          ) : (
            <Alert tone="muted" size="sm" role="status" icon={Info} data-testid="webhook-url-missing">
              <p>
                Nenhuma URL gerada: a variável <InlineCode>CIELO_WEBHOOK_PATH_TOKEN</InlineCode> não está definida no servidor. Nesta conta compartilhada é o esperado.
              </p>
            </Alert>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="webhook-header-name" className="block text-sm font-medium text-ink-soft">
            Nome do header
          </label>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Input id="webhook-header-name" readOnly value={dto.webhookHeaderName} onFocus={(e) => e.currentTarget.select()} className="font-mono" />
            </div>
            <CopyButton value={dto.webhookHeaderName} label="Copiar nome do header" />
          </div>
        </div>

        <div className="space-y-3 border-t border-border-subtle pt-4">
          <SecretField
            testId="secret-webhookHeaderSecret"
            name="Segredo do header"
            isSet={dto.webhookHeaderSecretSet}
            unreadable={dto.secretsDecryptable === false}
            value={secretValue}
            onChange={handleSecretChange}
            revealed={revealed}
            error={errors.webhookHeaderSecret}
            hint={`Mínimo de ${WEBHOOK_SECRET_MIN} caracteres (o gerador abaixo já atende). Este valor é o que a Cielo enviaria no header ${dto.webhookHeaderName}.`}
            actions={revealed ? <CopyButton value={secretValue ?? ""} label="Copiar segredo gerado" /> : undefined}
          />

          <Button
            type="button"
            variant="outline"
            size="touch-sm"
            onClick={() => onChange({ webhookHeaderSecret: generateRandomSecret(), webhookSecretRevealed: true })}
          >
            <Dices className="h-4 w-4" aria-hidden="true" />
            Gerar segredo aleatório
          </Button>

          {revealed && (
            <Alert tone="warning" size="sm" role="status" icon={Webhook} data-testid="webhook-secret-generated-note">
              <p>
                Copie este segredo <strong>antes de salvar</strong>. Depois de salvo ele nunca mais é exibido — se perder, será preciso gerar outro. Não o cadastre no Site Cielo: a conta é
                compartilhada com o Parque.
              </p>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
