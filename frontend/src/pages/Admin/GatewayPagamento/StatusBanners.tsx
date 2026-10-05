import { ShieldAlert, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { InlineCode } from "@/components/ui/InlineCode"

/**
 * Avisos PERMANENTES do estado do servidor (F5.7). Não são dispensáveis nem
 * dependem do rascunho: enquanto o DTO disser que o problema existe, o aviso
 * fica no topo da tela.
 */

/**
 * `secretsDecryptable === false`: o servidor tem segredo salvo mas NÃO consegue
 * decifrá-lo (chave trocada/perdida ou dado corrompido) — o gateway responde 503
 * ao motorista mesmo com os chips dizendo "Configurada". Perigo, não aviso.
 */
export function UnreadableSecretsAlert() {
  return (
    <Alert tone="danger" role="alert" icon={ShieldAlert} data-testid="secrets-unreadable-alert">
      <p>
        <span className="font-bold">Segredos salvos ilegíveis.</span> O servidor não consegue decifrar os segredos salvos — a PAYMENT_SECRETS_KEY foi trocada ou o dado está corrompido. O gateway está
        indisponível (503). Reenvie os 3 segredos — MerchantKey, Client Secret do cadastro de cartão e segredo do webhook — para restabelecer.
      </p>
    </Alert>
  )
}

/**
 * `sandboxRestricted === true`: ambiente SANDBOX em servidor de produção. Os
 * cartões de teste da Cielo são públicos, então sem a restrição seria cobrança
 * grátis; o servidor só libera a lista de testadores.
 */
export function SandboxRestrictedBanner() {
  return (
    <Alert tone="warning" role="status" icon={TriangleAlert} data-testid="sandbox-restricted-banner">
      <p>
        <span className="font-bold">Ambiente SANDBOX em servidor de produção:</span> só os e-mails da lista de testadores (variável <InlineCode>PAYMENT_SANDBOX_TESTER_EMAILS</InlineCode> no
        EasyPanel) conseguem usar Pix e cartão. Os outros motoristas veem &quot;indisponível no momento&quot;.
      </p>
    </Alert>
  )
}
