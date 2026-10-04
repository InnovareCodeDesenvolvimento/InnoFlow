import { getApiErrorCode, getApiErrorMessage, getApiErrorStatus } from "@/services/api"
import type { PaymentGatewayEnvironment, PaymentGatewayTestResult, PaymentGatewayTestStatus, PaymentGatewayTestStep } from "@/types/api"

/** Nome de cada passo para o admin (o `step` é código de contrato; o texto da tela é este). */
export const TEST_STEP_LABELS: Record<PaymentGatewayTestStep, { title: string; hint: string }> = {
  MERCHANT_CREDENTIALS: { title: "Credencial da Cielo", hint: "MerchantId e MerchantKey (cobrança e Pix)" },
  SOP_OAUTH: { title: "Autenticação do cadastro de cartão", hint: "Client ID e Client Secret (Silent Order Post)" },
  SOP_ACCESS_TOKEN: { title: "Token do cadastro de cartão", hint: "Emitido para o MerchantId; sem ele o cartão não cadastra" },
}

export type TestStatusTone = "success" | "danger" | "warning" | "neutral"

export const TEST_STATUS_INFO: Record<PaymentGatewayTestStatus, { label: string; tone: TestStatusTone }> = {
  OK: { label: "OK", tone: "success" },
  CREDENTIAL_REJECTED: { label: "Credencial recusada", tone: "danger" },
  IP_NOT_ALLOWED: { label: "IP não permitido", tone: "danger" },
  UNAVAILABLE: { label: "Indisponível", tone: "warning" },
  RATE_LIMITED: { label: "Muitas chamadas", tone: "warning" },
  REQUEST_REFUSED: { label: "Requisição recusada", tone: "danger" },
  MISCONFIGURED: { label: "Configuração incoerente", tone: "danger" },
  NOT_CONFIGURED: { label: "Não configurado", tone: "neutral" },
  SKIPPED: { label: "Não testado", tone: "neutral" },
}

/** Falha de verdade = tudo que não é OK, NOT_CONFIGURED nem SKIPPED (mesma regra do servidor para `ok`). */
export function isTestFailure(status: PaymentGatewayTestStatus): boolean {
  return status !== "OK" && status !== "NOT_CONFIGURED" && status !== "SKIPPED"
}

/**
 * Texto de apoio por status - o que FAZER, além da `message` pronta do servidor (que só diz o que aconteceu). `null` = nada a acrescentar.
 * Os dois textos pedidos pela Nova: IP (conferir a lista de IPs do Site Cielo ANTES de trocar a credencial - ela pode estar certa) e
 * credencial recusada (sandbox e produção são servidores separados, a credencial de um é recusada pelo outro com o mesmo erro).
 */
export function testSupportText(status: PaymentGatewayTestStatus, environment: PaymentGatewayEnvironment): string | null {
  const other = environment === "sandbox" ? "produção" : "sandbox"
  switch (status) {
    case "IP_NOT_ALLOWED":
      return "A Cielo recusou o IP do servidor: confira a lista de IPs confiáveis do Site Cielo antes de trocar a credencial. Ela pode estar correta."
    case "CREDENTIAL_REJECTED":
      return `Confira o ambiente: sandbox e produção são servidores separados, e a credencial de um é recusada pelo outro com este mesmo erro. O ambiente salvo aqui é ${environment === "sandbox" ? "sandbox" : "produção"}; se a credencial é de ${other}, troque o ambiente ou a credencial.`
    case "MISCONFIGURED":
      return "Corrija o que a mensagem aponta, salve e teste de novo."
    case "NOT_CONFIGURED":
      return "Preencha e salve a credencial em “Credenciais da Cielo” para poder testar este passo."
    case "UNAVAILABLE":
      return "Pode ser instabilidade momentânea da Cielo ou da rede do servidor. Tente de novo em instantes."
    case "RATE_LIMITED":
      return "Aguarde um instante e teste de novo."
    case "REQUEST_REFUSED":
      return "A Cielo recusou a nossa requisição por um motivo que não parece credencial. Guarde a mensagem acima para o suporte."
    case "OK":
    case "SKIPPED":
      return null
  }
}

export type TestVerdict = "ok" | "failed" | "nothing-configured"

/** Resumo de uma linha do resultado. `ok` do servidor manda; sem falha e sem OK é "nada configurado para testar". */
export function testVerdict(result: PaymentGatewayTestResult): TestVerdict {
  if (result.ok) return "ok"
  return result.steps.some((s) => isTestFailure(s.status)) ? "failed" : "nothing-configured"
}

export const TEST_VERDICT_TEXT: Record<TestVerdict, string> = {
  ok: "Conexão funcionando: a Cielo aceitou as credenciais salvas.",
  failed: "O teste encontrou problema. Veja o passo marcado abaixo.",
  "nothing-configured": "Não há credencial salva para testar ainda.",
}

/** Erro HTTP do botão (não confundir com falha de credencial, que vem 200). */
export function testRequestErrorMessage(err: unknown): string {
  const status = getApiErrorStatus(err)
  const code = getApiErrorCode(err)
  if (status === 429 || code === "RATE_LIMITED_PAYMENT_GATEWAY") return "Muitos testes seguidos (limite de 6 por minuto). Aguarde um instante e tente de novo."
  if (status === 503 || code === "PAYMENT_GATEWAY_UNAVAILABLE") return "Não foi possível ler a configuração do gateway agora. Tente de novo em instantes."
  if (status === 401 || status === 403) return "Somente administradores podem testar a conexão com o gateway."
  return getApiErrorMessage(err, "Não foi possível executar o teste de conexão.")
}
