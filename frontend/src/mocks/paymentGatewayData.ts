import type {
  PaymentGatewayConfigDTO,
  PaymentGatewayEnvironment,
  PaymentGatewayRequirement,
  PaymentMethodReadiness,
  UpdatePaymentGatewayConfigRequest,
} from "@/types/api"

/** Senha das contas de ADMIN do mock (a mesma de `mocks/data.ts`): o PUT confere `currentPassword` contra ela (step-up, F5.7). */
const MOCK_ADMIN_PASSWORD = "senha1234"

/**
 * Espelho (no que a tela precisa provar) de `GET/PUT /api/admin/payment-gateway`
 * (F5.5). NÃO é a regra de negócio da Vega — é só o suficiente para exercitar o
 * contrato no navegador enquanto o backend real não está acessível deste
 * ambiente. Regras espelhadas do bloco "F5.5" de `types/api.ts`:
 *  - SEGREDOS NUNCA SÃO GUARDADOS NEM DEVOLVIDOS: o mock só lembra `...Set`;
 *  - campo ausente no PUT = não mexer;
 *  - 503 `PAYMENT_SECRETS_KEY_MISSING` ao gravar segredo sem a chave de cifragem do servidor;
 *  - 400 `PRODUCTION_CONFIRMATION_REQUIRED` ao mudar sandbox → production sem `confirmProduction: true`;
 *  - 409 `GATEWAY_NOT_READY` (com a lista em `details`) ao ir para produção ou habilitar um meio com pré-requisito faltando;
 *  - `source: "env"` até o primeiro PUT; depois `"database"` com `updatedAt`.
 *
 * SUPOSIÇÕES DO MOCK (o contrato não fecha; alinhar com o Vega):
 *  - "pronto" do cartão = MERCHANT_ID, MERCHANT_KEY, SOP_CLIENT_ID, SOP_CLIENT_SECRET, PAYMENT_SECRETS_KEY (C1.1: o backend
 *    real NÃO exige mais SOP_SCRIPT_URL/SOP_OAUTH_TOKEN_URL - as URLs do SOP têm default por ambiente e as envs são só override);
 *    do Pix = MERCHANT_ID, MERCHANT_KEY, WEBHOOK_PATH_TOKEN,
 *    WEBHOOK_HEADER_SECRET, PAYMENT_SECRETS_KEY;
 *  - ir para produção exige que todo meio HABILITADO (no estado resultante) esteja pronto;
 *  - `details` do 409 é um array de strings (`["MERCHANT_KEY", ...]`) em ordem estável.
 *
 * COMPORTAMENTO REAL DO SERVIDOR (Vega, F5.5) já espelhado:
 *  - PARES: `merchantId`+`merchantKey` e `sopClientId`+`sopClientSecret` andam juntos. Com `source:"env"` ou sem segredo
 *    salvo, enviar só um lado => 409 `GATEWAY_NOT_READY` com a metade que falta em `details`. Com `source:"database"` e o
 *    segredo salvo, trocar só o id passa. (Para a chave sozinha só se exige o id na origem `env`.)
 *  - o mock NÃO é a fonte da regra: se o servidor real divergir, o servidor manda.
 *
 * CENÁRIOS por conta de ADMIN (o estado vive por usuário, em memória da página — um `page.goto` zera):
 *  - `admin@innoelektron.com`                → origem `env`, NADA configurado (servidor completo);
 *  - `gateway-pronto@innoelektron.com`       → `database`, sandbox, tudo pronto, Pix habilitado;
 *  - `gateway-producao@innoelektron.com`     → `database`, produção, tudo pronto, Pix e cartão habilitados;
 *  - `gateway-sem-chave@innoelektron.com`    → `env`, servidor SEM `PAYMENT_SECRETS_KEY` e sem token do webhook (503 ao enviar segredo; `webhookUrl: null`),
 *                                              Pix já habilitado sem estar pronto (ir para produção => 409 GATEWAY_NOT_READY);
 *  - `gateway-falhas@innoelektron.com`       → como o "pronto", mas o PUT falha de forma determinística conforme o MerchantId enviado:
 *                                              "ERRO-429" => 429 RATE_LIMITED_PAYMENT_GATEWAY, "ERRO-503" => 503 PAYMENT_GATEWAY_UNAVAILABLE,
 *                                              "ERRO-500" => 500 INTERNAL_ERROR (nada é gravado em nenhum deles);
 *  - `gateway-ilegivel@innoelektron.com`     → o GET devolve 503 PAYMENT_GATEWAY_UNAVAILABLE (configuração ilegível no servidor).
 *
 * F5.7 (step-up de senha, segredos ilegíveis, sandbox restrito) — espelha o bloco "F5.5" ampliado de `types/api.ts`:
 *  - TODO PUT exige `currentPassword`: ausente => 400 VALIDATION_ERROR; diferente de `senha1234` => 403 INVALID_CURRENT_PASSWORD
 *    (nada é gravado; 403 e NÃO 401, para o interceptor não deslogar). A senha nunca é guardada nem devolvida;
 *  - `secretsDecryptable`: `null` sem segredo no banco (`source:"env"`); `true`/`false` com segredo salvo. Reenviar os 3 segredos
 *    num mesmo PUT restabelece (`false` → `true`);
 *  - `sandboxRestricted`: `true` quando o servidor é de produção (`NODE_ENV`) e o ambiente efetivo é sandbox;
 *  - `webhookHeaderSecret`: mínimo 32 (Órion B2);
 *  - `gateway-ilegivel-segredos@innoelektron.com` → como o "pronto", mas `secretsDecryptable: false` (o GET é 200; o gateway "está em 503");
 *  - `gateway-sandbox-publico@innoelektron.com`   → como o "pronto", servidor de produção em sandbox => `sandboxRestricted: true`;
 *  - `gateway-em-andamento@innoelektron.com`      → como o "pronto", com 3 pagamentos em trânsito: trocar `environment` => 409
 *                                                   GATEWAY_HAS_INFLIGHT_PAYMENTS com `details: { count: 3 }` (nada é gravado).
 */

interface ServerEnv {
  webhookPathToken: boolean
  secretsKey: boolean
  /** `NODE_ENV=production` no servidor: sandbox aqui é "cobrança grátis" (cartões de teste públicos) => `sandboxRestricted`. */
  productionNode: boolean
}

interface GatewayState {
  source: "env" | "database"
  environment: PaymentGatewayEnvironment
  merchantId: string | null
  merchantKeySet: boolean
  sopClientId: string | null
  sopClientSecretSet: boolean
  webhookHeaderSecretSet: boolean
  cardEnabled: boolean
  pixEnabled: boolean
  updatedAt: string | null
  /** Só simulação: `false` = o servidor não decifra os segredos salvos (chave trocada). */
  secretsDecryptable: boolean
  /** Só simulação: pagamentos em trânsito no ambiente atual (bloqueiam a troca de ambiente). */
  inflightPayments: number
}

interface Scenario {
  server: ServerEnv
  state: GatewayState
}

const FULL_SERVER: ServerEnv = { webhookPathToken: true, secretsKey: true, productionNode: false }

const EMPTY_STATE: GatewayState = {
  source: "env",
  environment: "sandbox",
  merchantId: null,
  merchantKeySet: false,
  sopClientId: null,
  sopClientSecretSet: false,
  webhookHeaderSecretSet: false,
  cardEnabled: false,
  pixEnabled: false,
  updatedAt: null,
  secretsDecryptable: true,
  inflightPayments: 0,
}

const READY_STATE: GatewayState = {
  source: "database",
  environment: "sandbox",
  merchantId: "mid-sandbox-7f3a91",
  merchantKeySet: true,
  sopClientId: "sop-client-demo-22",
  sopClientSecretSet: true,
  webhookHeaderSecretSet: true,
  cardEnabled: false,
  pixEnabled: true,
  updatedAt: "2026-10-01T14:32:00.000Z",
  secretsDecryptable: true,
  inflightPayments: 0,
}

function seed(userId: string): Scenario {
  switch (userId) {
    case "user_admin_gateway_pronto":
      return { server: { ...FULL_SERVER }, state: { ...READY_STATE } }
    case "user_admin_gateway_producao":
      return { server: { ...FULL_SERVER }, state: { ...READY_STATE, environment: "production", merchantId: "mid-prod-5c0de2", cardEnabled: true, pixEnabled: true } }
    case "user_admin_gateway_falhas":
    case "user_admin_gateway_ilegivel":
      return { server: { ...FULL_SERVER }, state: { ...READY_STATE } }
    case "user_admin_gateway_ilegivel_segredos":
      return { server: { ...FULL_SERVER }, state: { ...READY_STATE, secretsDecryptable: false } }
    case "user_admin_gateway_sandbox_publico":
      return { server: { ...FULL_SERVER, productionNode: true }, state: { ...READY_STATE } }
    case "user_admin_gateway_em_andamento":
      return { server: { ...FULL_SERVER }, state: { ...READY_STATE, inflightPayments: 3 } }
    case "user_admin_gateway_sem_chave":
      // Pix já HABILITADO (herdado do ambiente do servidor) mas sem pré-requisito: prova que DESLIGAR é sempre permitido e dá o caminho ao 409 GATEWAY_NOT_READY (ir para produção).
      return { server: { webhookPathToken: false, secretsKey: false, productionNode: false }, state: { ...EMPTY_STATE, pixEnabled: true } }
    default:
      return { server: { ...FULL_SERVER }, state: { ...EMPTY_STATE } }
  }
}

const scenarios = new Map<string, Scenario>()

function scenarioFor(userId: string): Scenario {
  let scenario = scenarios.get(userId)
  if (!scenario) {
    scenario = seed(userId)
    scenarios.set(userId, scenario)
  }
  return scenario
}

const REQUIREMENT_ORDER: PaymentGatewayRequirement[] = [
  "MERCHANT_ID",
  "MERCHANT_KEY",
  "SOP_CLIENT_ID",
  "SOP_CLIENT_SECRET",
  "SOP_SCRIPT_URL",
  "SOP_OAUTH_TOKEN_URL",
  "WEBHOOK_PATH_TOKEN",
  "WEBHOOK_HEADER_SECRET",
  "PAYMENT_SECRETS_KEY",
]

function missingFor(method: "card" | "pix", state: GatewayState, server: ServerEnv): PaymentGatewayRequirement[] {
  const missing = new Set<PaymentGatewayRequirement>()
  if (!state.merchantId) missing.add("MERCHANT_ID")
  if (!state.merchantKeySet) missing.add("MERCHANT_KEY")
  if (!server.secretsKey) missing.add("PAYMENT_SECRETS_KEY")
  if (method === "card") {
    if (!state.sopClientId) missing.add("SOP_CLIENT_ID")
    if (!state.sopClientSecretSet) missing.add("SOP_CLIENT_SECRET")
  } else {
    if (!server.webhookPathToken) missing.add("WEBHOOK_PATH_TOKEN")
    if (!state.webhookHeaderSecretSet) missing.add("WEBHOOK_HEADER_SECRET")
  }
  return REQUIREMENT_ORDER.filter((r) => missing.has(r))
}

function readiness(method: "card" | "pix", state: GatewayState, server: ServerEnv): PaymentMethodReadiness {
  const missing = missingFor(method, state, server)
  return { ready: missing.length === 0, missing }
}

function toDto({ state, server }: Scenario): PaymentGatewayConfigDTO {
  return {
    source: state.source,
    environment: state.environment,
    merchantId: state.merchantId,
    merchantKeySet: state.merchantKeySet,
    sopClientId: state.sopClientId,
    sopClientSecretSet: state.sopClientSecretSet,
    webhookHeaderSecretSet: state.webhookHeaderSecretSet,
    webhookUrl: server.webhookPathToken ? "https://api.innoflow.example/api/webhooks/cielo/k3x9-demo-token" : null,
    webhookHeaderName: "InnoFlowWebhookSecret", // só letras: o campo Key do Site Cielo recusa hífen/número (C1.4); mesmo valor de WEBHOOK_SECRET_HEADER_NAME do backend
    cardEnabled: state.cardEnabled,
    pixEnabled: state.pixEnabled,
    readiness: { card: readiness("card", state, server), pix: readiness("pix", state, server) },
    // `null` = nenhum segredo no banco (origem env); senão, se o servidor consegue decifrar o que está salvo.
    secretsDecryptable: state.source === "env" ? null : state.secretsDecryptable,
    sandboxRestricted: server.productionNode && state.environment === "sandbox",
    updatedAt: state.updatedAt,
  }
}

export type GatewayFailureStatus = 400 | 403 | 409 | 429 | 500 | 503
type GatewayFailureDetails = PaymentGatewayRequirement[] | { count: number }
export type GatewayUpdateResult =
  | { ok: true; dto: PaymentGatewayConfigDTO }
  | { ok: false; status: GatewayFailureStatus; code: string; message: string; details?: GatewayFailureDetails }

const fail = (status: GatewayFailureStatus, code: string, message: string, details?: GatewayFailureDetails): GatewayUpdateResult => ({ ok: false, status, code, message, details })

export function getGatewayConfig(userId: string): GatewayUpdateResult {
  if (userId === "user_admin_gateway_ilegivel") {
    return fail(503, "PAYMENT_GATEWAY_UNAVAILABLE", "Configuração do gateway ilegível no servidor.")
  }
  return { ok: true, dto: toDto(scenarioFor(userId)) }
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max
}

/** Aplica um PUT. Valida tudo ANTES de mexer no estado (um 4xx/5xx nunca deixa meia alteração). Nunca guarda valor de segredo. */
export function updateGatewayConfig(userId: string, body: unknown): GatewayUpdateResult {
  const scenario = scenarioFor(userId)
  const input = (body && typeof body === "object" ? body : {}) as UpdatePaymentGatewayConfigRequest & Record<string, unknown>

  // ---- 400 VALIDATION_ERROR ----
  if (input.environment !== undefined && input.environment !== "sandbox" && input.environment !== "production") {
    return fail(400, "VALIDATION_ERROR", "environment: deve ser 'sandbox' ou 'production'.")
  }
  for (const key of ["merchantId", "sopClientId"] as const) {
    if (input[key] !== undefined && !isText(input[key], 1, 100)) return fail(400, "VALIDATION_ERROR", `${key}: de 1 a 100 caracteres.`)
  }
  for (const key of ["merchantKey", "sopClientSecret"] as const) {
    if (input[key] !== undefined && !isText(input[key], 1, 200)) return fail(400, "VALIDATION_ERROR", `${key}: de 1 a 200 caracteres.`)
  }
  if (input.webhookHeaderSecret !== undefined && !isText(input.webhookHeaderSecret, 32, 200)) {
    return fail(400, "VALIDATION_ERROR", "webhookHeaderSecret: de 32 a 200 caracteres.")
  }
  for (const key of ["cardEnabled", "pixEnabled"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") return fail(400, "VALIDATION_ERROR", `${key}: deve ser booleano.`)
  }
  if (input.confirmProduction !== undefined && input.confirmProduction !== true) {
    return fail(400, "VALIDATION_ERROR", "confirmProduction: só aceita true.")
  }

  // ---- 400/403: step-up de senha em TODO PUT (a senha nunca é guardada nem ecoada) ----
  if (input.currentPassword === undefined) return fail(400, "VALIDATION_ERROR", "currentPassword: obrigatório.")
  if (typeof input.currentPassword !== "string" || input.currentPassword.length < 1 || input.currentPassword.length > 200) {
    return fail(400, "VALIDATION_ERROR", "currentPassword: de 1 a 200 caracteres.")
  }
  if (input.currentPassword !== MOCK_ADMIN_PASSWORD) return fail(403, "INVALID_CURRENT_PASSWORD", "Senha atual incorreta.")

  // ---- falhas determinísticas do cenário `gateway-falhas@` (nada é gravado) ----
  if (userId === "user_admin_gateway_falhas" && typeof input.merchantId === "string") {
    const trigger = input.merchantId.trim().toUpperCase()
    if (trigger === "ERRO-429") return fail(429, "RATE_LIMITED_PAYMENT_GATEWAY", "Muitas alterações no gateway de pagamento. Aguarde um minuto.")
    if (trigger === "ERRO-503") return fail(503, "PAYMENT_GATEWAY_UNAVAILABLE", "Configuração do gateway ilegível no servidor.")
    if (trigger === "ERRO-500") return fail(500, "INTERNAL_ERROR", "Erro interno.")
  }

  // ---- 503: sem chave de cifragem o servidor não grava segredo ----
  const writesSecret = input.merchantKey !== undefined || input.sopClientSecret !== undefined || input.webhookHeaderSecret !== undefined
  if (writesSecret && !scenario.server.secretsKey) {
    return fail(503, "PAYMENT_SECRETS_KEY_MISSING", "O servidor não está configurado para guardar segredos (PAYMENT_SECRETS_KEY ausente).")
  }

  // ---- 400: virar produção exige confirmação explícita ----
  if (input.environment === "production" && scenario.state.environment === "sandbox" && input.confirmProduction !== true) {
    return fail(400, "PRODUCTION_CONFIRMATION_REQUIRED", "Mudar para produção exige confirmProduction: true.")
  }

  // ---- 409: trocar o ambiente com pagamentos em trânsito do ambiente atual ----
  if (input.environment !== undefined && input.environment !== scenario.state.environment && scenario.state.inflightPayments > 0) {
    return fail(409, "GATEWAY_HAS_INFLIGHT_PAYMENTS", "Há pagamentos em andamento neste ambiente.", { count: scenario.state.inflightPayments })
  }

  // ---- 409: PARES de credenciais andam juntos (id + segredo no mesmo PUT quando o par vem do env ou não há segredo salvo) ----
  const pairMissing = new Set<PaymentGatewayRequirement>()
  if (input.merchantId !== undefined && input.merchantKey === undefined && (scenario.state.source === "env" || !scenario.state.merchantKeySet)) pairMissing.add("MERCHANT_KEY")
  if (input.merchantKey !== undefined && input.merchantId === undefined && scenario.state.source === "env") pairMissing.add("MERCHANT_ID")
  if (input.sopClientId !== undefined && input.sopClientSecret === undefined && (scenario.state.source === "env" || !scenario.state.sopClientSecretSet)) pairMissing.add("SOP_CLIENT_SECRET")
  if (input.sopClientSecret !== undefined && input.sopClientId === undefined && scenario.state.source === "env") pairMissing.add("SOP_CLIENT_ID")
  if (pairMissing.size > 0) {
    return fail(409, "GATEWAY_NOT_READY", "Credenciais em par: envie as duas metades na mesma alteração.", REQUIREMENT_ORDER.filter((r) => pairMissing.has(r)))
  }

  // ---- estado candidato (ainda não gravado) ----
  const next: GatewayState = {
    ...scenario.state,
    environment: input.environment ?? scenario.state.environment,
    merchantId: input.merchantId !== undefined ? input.merchantId.trim() : scenario.state.merchantId,
    sopClientId: input.sopClientId !== undefined ? input.sopClientId.trim() : scenario.state.sopClientId,
    merchantKeySet: scenario.state.merchantKeySet || input.merchantKey !== undefined,
    sopClientSecretSet: scenario.state.sopClientSecretSet || input.sopClientSecret !== undefined,
    webhookHeaderSecretSet: scenario.state.webhookHeaderSecretSet || input.webhookHeaderSecret !== undefined,
    cardEnabled: input.cardEnabled ?? scenario.state.cardEnabled,
    pixEnabled: input.pixEnabled ?? scenario.state.pixEnabled,
  }

  // ---- 409: ir para produção / habilitar um meio com pré-requisito faltando ----
  const turnsOn = (method: "card" | "pix") => (method === "card" ? input.cardEnabled === true : input.pixEnabled === true)
  const goesProduction = input.environment === "production" && scenario.state.environment !== "production"
  const toCheck = (["card", "pix"] as const).filter((m) => (m === "card" ? next.cardEnabled : next.pixEnabled) && (turnsOn(m) || goesProduction))
  const missing = new Set<PaymentGatewayRequirement>()
  for (const method of toCheck) for (const r of missingFor(method, next, scenario.server)) missing.add(r)
  if (missing.size > 0) {
    return fail(409, "GATEWAY_NOT_READY", "Há pré-requisitos faltando para o que foi pedido.", REQUIREMENT_ORDER.filter((r) => missing.has(r)))
  }

  // Reenviar os 3 segredos no mesmo PUT restabelece a leitura (a chave nova cifra tudo de novo).
  const resendsAllSecrets = input.merchantKey !== undefined && input.sopClientSecret !== undefined && input.webhookHeaderSecret !== undefined
  scenario.state = { ...next, source: "database", updatedAt: new Date().toISOString(), secretsDecryptable: next.secretsDecryptable || resendsAllSecrets }
  return { ok: true, dto: toDto(scenario) }
}
