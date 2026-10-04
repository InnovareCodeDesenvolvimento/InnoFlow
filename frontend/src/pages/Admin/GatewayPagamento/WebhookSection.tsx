import { Dices, TriangleAlert, Webhook } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { generateRandomSecret, WEBHOOK_SECRET_MIN, type DraftErrors, type GatewayDraft } from "@/lib/paymentGateway"
import type { PaymentGatewayConfigDTO } from "@/types/api"
import { CopyButton } from "./CopyButton"
import { SecretField } from "./SecretField"

/**
 * Webhook da Cielo. A URL e o nome do header são só leitura (com copiar); o
 * segredo do header é só de escrita como os outros — com um atalho para
 * GERAR um aleatório e MOSTRÁ-LO (único momento em que um segredo aparece em
 * texto: o admin precisa copiar e cadastrar no Site da Cielo ANTES de salvar,
 * porque depois de salvo ele nunca mais volta).
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
  // Webhook não usado (conta Cielo compartilhada): nada configurado e nada a cadastrar - situação normal, não pendência. Se ALGO já está configurado
  // (URL ou segredo), a seção completa continua aparecendo para o admin terminar ou limpar.
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
      <Card className="card-premium" data-testid="section-webhook">
        <CardHeader>
          <CardTitle>Webhook</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="status" className="flex items-start gap-2 text-sm text-ink-soft" data-testid="webhook-not-in-use">
            <Webhook className="mt-0.5 h-4 w-4 shrink-0 text-ink-softer" aria-hidden="true" />
            <span className="min-w-0">
              <span className="font-semibold text-ink">Webhook não usado (conta compartilhada).</span> O Pix é creditado por consulta periódica à Cielo, então não há URL nem header para cadastrar no Site da
              Cielo.
            </span>
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="card-premium" data-testid="section-webhook">
      <CardHeader>
        <CardTitle>Webhook</CardTitle>
        <CardDescription>
          Cadastre a URL e o header abaixo no Site da Cielo, para a plataforma ser avisada de pagamentos Pix e de mudanças de status.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
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
                <Input id="webhook-url" readOnly value={dto.webhookUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs sm:text-xs" />
              </div>
              <CopyButton value={dto.webhookUrl} label="Copiar URL do webhook" />
            </div>
          ) : (
            <div role="status" className="flex items-start gap-2 rounded-lg border border-warning-600/30 bg-warning-50 px-3 py-2.5 text-sm text-warning-700" data-testid="webhook-url-missing">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                A URL ainda não pode ser gerada: falta a variável <code className="break-all rounded bg-white/70 px-1 py-0.5 text-xs">CIELO_WEBHOOK_PATH_TOKEN</code> no servidor (EasyPanel). Defina e reinicie a API.
              </span>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="webhook-header-name" className="block text-sm font-medium text-ink-soft">
            Nome do header
          </label>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Input id="webhook-header-name" readOnly value={dto.webhookHeaderName} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs sm:text-xs" />
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
            hint={`Mínimo de ${WEBHOOK_SECRET_MIN} caracteres (o gerador abaixo já atende). Este valor é o que a Cielo vai enviar no header ${dto.webhookHeaderName}.`}
            actions={revealed ? <CopyButton value={secretValue ?? ""} label="Copiar segredo gerado" /> : undefined}
          />

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({ webhookHeaderSecret: generateRandomSecret(), webhookSecretRevealed: true })}
          >
            <Dices className="h-4 w-4" aria-hidden="true" />
            Gerar segredo aleatório
          </Button>

          {revealed && (
            <p role="status" className="flex items-start gap-2 rounded-lg bg-warning-50 px-3 py-2 text-xs text-warning-700" data-testid="webhook-secret-generated-note">
              <Webhook className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Copie este segredo e cadastre no Site da Cielo <strong>antes de salvar</strong>. Depois de salvo ele nunca mais é exibido — se perder, será preciso gerar outro.
              </span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
