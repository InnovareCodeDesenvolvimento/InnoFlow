import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import type { DraftErrors, GatewayDraft } from "@/lib/paymentGateway"
import type { PaymentGatewayConfigDTO } from "@/types/api"
import { SecretField } from "./SecretField"

/**
 * Credenciais da conta Cielo. IDs (texto normal) mostram o valor atual; os
 * segredos mostram só "Configurada/Não configurada" e abrem um campo VAZIO ao
 * substituir. Campo de texto em branco não é enviado (o servidor não tem
 * "apagar", só trocar).
 */
export function CredentialsSection({
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
  const merchantId = draft.merchantId ?? dto.merchantId ?? ""
  const sopClientId = draft.sopClientId ?? dto.sopClientId ?? ""

  return (
    <Card className="card-premium" data-testid="section-credentials">
      <CardHeader>
        <CardTitle>Credenciais da Cielo</CardTitle>
        <CardDescription>Da conta única da plataforma. Os segredos ficam guardados cifrados no servidor e nunca voltam para esta tela.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="MerchantId"
            autoComplete="off"
            spellCheck={false}
            value={merchantId}
            onChange={(e) => onChange({ merchantId: e.target.value })}
            hint={draft.merchantId?.trim() === "" && dto.merchantId ? "Em branco, o valor atual é mantido." : "Identificador da loja na Cielo."}
          />
          <Input
            label="Client ID do cadastro de cartão"
            autoComplete="off"
            spellCheck={false}
            value={sopClientId}
            onChange={(e) => onChange({ sopClientId: e.target.value })}
            hint={draft.sopClientId?.trim() === "" && dto.sopClientId ? "Em branco, o valor atual é mantido." : "Silent Order Post (formulário de cartão isolado)."}
          />
        </div>

        <div className="space-y-4 border-t border-border-subtle pt-4">
          <SecretField
            testId="secret-merchantKey"
            name="MerchantKey"
            isSet={dto.merchantKeySet}
            value={draft.merchantKey}
            onChange={(value) => onChange({ merchantKey: value })}
            error={errors.merchantKey}
          />
          <SecretField
            testId="secret-sopClientSecret"
            name="Client Secret do cadastro de cartão"
            isSet={dto.sopClientSecretSet}
            value={draft.sopClientSecret}
            onChange={(value) => onChange({ sopClientSecret: value })}
            error={errors.sopClientSecret}
          />
        </div>
      </CardContent>
    </Card>
  )
}
