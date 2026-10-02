import { ShieldAlert, TriangleAlert } from "lucide-react"

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
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger-600/40 bg-danger-50 p-4 text-danger-700" data-testid="secrets-unreadable-alert">
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 text-sm">
        <span className="font-bold">Segredos salvos ilegíveis.</span> O servidor não consegue decifrar os segredos salvos — a PAYMENT_SECRETS_KEY foi trocada ou o dado está corrompido. O gateway está indisponível
        (503). Reenvie os 3 segredos — MerchantKey, Client Secret do cadastro de cartão e segredo do webhook — para restabelecer.
      </p>
    </div>
  )
}

/**
 * `sandboxRestricted === true`: ambiente SANDBOX em servidor de produção. Os
 * cartões de teste da Cielo são públicos, então sem a restrição seria cobrança
 * grátis; o servidor só libera a lista de testadores.
 */
export function SandboxRestrictedBanner() {
  return (
    <div role="status" className="flex items-start gap-3 rounded-xl border border-warning-600/40 bg-warning-50 p-4 text-warning-700" data-testid="sandbox-restricted-banner">
      <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 text-sm">
        <span className="font-bold">Ambiente SANDBOX em servidor de produção:</span> só os e-mails da lista de testadores (variável{" "}
        <code className="break-all rounded bg-white/70 px-1 py-0.5 text-xs">PAYMENT_SANDBOX_TESTER_EMAILS</code> no EasyPanel) conseguem usar Pix e cartão. Os outros motoristas veem
        &quot;indisponível no momento&quot;.
      </p>
    </div>
  )
}
