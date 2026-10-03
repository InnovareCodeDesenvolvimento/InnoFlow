import axios from "axios"
import type {
  PaymentGatewayConfigDTO,
  PaymentGatewayEnvironment,
  PaymentGatewayRequirement,
  UpdatePaymentGatewayConfigRequest,
} from "@/types/api"

/**
 * Regras PURAS da tela Admin → Gateway de pagamento (F5.5). Nada aqui toca
 * rede, DOM nem React — é o que dá para provar com teste unitário: montagem do
 * diff do PUT, mapa de requisitos em português, gerador de segredo aleatório
 * e a comparação tolerante da palavra "PRODUÇÃO".
 *
 * Princípio que atravessa tudo: SEGREDOS são só de escrita. O GET nunca os
 * devolve, então o rascunho só guarda um segredo quando o admin decide
 * SUBSTITUÍ-LO, e nada daqui devolve o valor de um segredo em texto (resumo,
 * mensagem de erro, log).
 */

// ---------------------------------------------------------------------------
// Ambiente
// ---------------------------------------------------------------------------

export const ENVIRONMENT_LABELS: Record<PaymentGatewayEnvironment, string> = {
  sandbox: "Sandbox (testes)",
  production: "Produção",
}

/** Palavra que o admin precisa digitar para virar produção. */
export const PRODUCTION_CONFIRM_WORD = "PRODUÇÃO"

/** Minúsculas, sem acento e sem espaços nas pontas: "  Produção " === "PRODUCAO". */
function foldForCompare(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
}

/** `true` só se o texto digitado É a palavra PRODUÇÃO (tolerante a caixa, acento e espaços nas pontas — nunca a "producoes", "produ" etc.). */
export function isProductionConfirmation(typed: string): boolean {
  return foldForCompare(typed) === foldForCompare(PRODUCTION_CONFIRM_WORD)
}

// ---------------------------------------------------------------------------
// Requisitos (o que falta para um meio de pagamento funcionar)
// ---------------------------------------------------------------------------

export type RequirementWhere = "screen" | "server"

export interface RequirementInfo {
  /** Texto em português claro para o admin. */
  label: string
  /** `screen` = resolve preenchendo esta tela; `server` = variável de ambiente do servidor (EasyPanel), a tela NÃO edita. */
  where: RequirementWhere
  /** Variável do servidor (só `where: "server"`). */
  envVar?: string
  /** Onde, nesta tela, se resolve (só `where: "screen"`). */
  section?: string
}

export const REQUIREMENT_INFO: Record<PaymentGatewayRequirement, RequirementInfo> = {
  MERCHANT_ID: { label: "MerchantId da Cielo", where: "screen", section: "Credenciais da Cielo" },
  MERCHANT_KEY: { label: "MerchantKey da Cielo", where: "screen", section: "Credenciais da Cielo" },
  SOP_CLIENT_ID: { label: "Client ID do cadastro de cartão (Silent Order Post)", where: "screen", section: "Credenciais da Cielo" },
  SOP_CLIENT_SECRET: { label: "Client Secret do cadastro de cartão (Silent Order Post)", where: "screen", section: "Credenciais da Cielo" },
  SOP_SCRIPT_URL: { label: "Endereço do script de cadastro de cartão", where: "server", envVar: "CIELO_SOP_SCRIPT_URL" },
  SOP_OAUTH_TOKEN_URL: { label: "Endereço de autenticação do cadastro de cartão", where: "server", envVar: "CIELO_SOP_OAUTH_TOKEN_URL" },
  WEBHOOK_PATH_TOKEN: { label: "Token do endereço do webhook", where: "server", envVar: "CIELO_WEBHOOK_PATH_TOKEN" },
  WEBHOOK_HEADER_SECRET: { label: "Segredo do header do webhook", where: "screen", section: "Webhook" },
  PAYMENT_SECRETS_KEY: { label: "Chave de cifragem dos segredos", where: "server", envVar: "PAYMENT_SECRETS_KEY" },
}

/** Comando para gerar o valor de `PAYMENT_SECRETS_KEY` no servidor. */
export const PAYMENT_SECRETS_KEY_COMMAND = "openssl rand -base64 32"

const KNOWN_REQUIREMENTS = new Set<string>(Object.keys(REQUIREMENT_INFO))

export function isKnownRequirement(value: unknown): value is PaymentGatewayRequirement {
  return typeof value === "string" && KNOWN_REQUIREMENTS.has(value)
}

/**
 * Um código de requisito que o front ainda não conhece (servidor mais novo)
 * não pode quebrar a tela: cai num texto genérico com o próprio código.
 */
export function requirementInfo(code: string): RequirementInfo {
  return isKnownRequirement(code) ? REQUIREMENT_INFO[code] : { label: `Pré-requisito ${code}`, where: "server" }
}

/** Separa o que o admin resolve na tela do que é variável do servidor — a UI mostra os dois grupos com instruções diferentes. */
export function splitRequirements(missing: readonly string[]): { screen: string[]; server: string[] } {
  const screen: string[] = []
  const server: string[] = []
  for (const code of missing) (requirementInfo(code).where === "screen" ? screen : server).push(code)
  return { screen, server }
}

/** "Pronto" ou "Falta 1 item" / "Faltam 3 itens". */
export function readinessSummary(readiness: { ready: boolean; missing: readonly string[] }): string {
  if (readiness.ready) return "Pronto"
  const n = readiness.missing.length
  return n === 1 ? "Falta 1 item" : `Faltam ${n} itens`
}

// ---------------------------------------------------------------------------
// Gerador de segredo aleatório (segredo do header do webhook)
// ---------------------------------------------------------------------------

const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
/** Maior múltiplo de 62 que cabe em um byte (62 × 4 = 248): bytes ≥ 248 são descartados para não enviesar o sorteio (módulo puro favoreceria os primeiros caracteres). */
const SECRET_BYTE_LIMIT = 248

export const GENERATED_SECRET_LENGTH = 40
/** Piso para o segredo gerado: igual ao mínimo que o servidor exige do segredo do webhook (32). */
export const GENERATED_SECRET_MIN_LENGTH = 32

export type RandomBytesFn = (buffer: Uint8Array) => Uint8Array

const defaultRandomBytes: RandomBytesFn = (buffer) => crypto.getRandomValues(buffer)

/**
 * Segredo aleatório alfanumérico (seguro dentro de um header HTTP e de URL),
 * sorteado com `crypto.getRandomValues` — NUNCA `Math.random`. `random` é
 * injetável só para o teste provar a rejeição de viés.
 */
export function generateRandomSecret(length: number = GENERATED_SECRET_LENGTH, random: RandomBytesFn = defaultRandomBytes): string {
  const size = Math.max(GENERATED_SECRET_MIN_LENGTH, Math.floor(length))
  let out = ""
  while (out.length < size) {
    const bytes = random(new Uint8Array(size))
    for (let i = 0; i < bytes.length && out.length < size; i++) {
      if (bytes[i] < SECRET_BYTE_LIMIT) out += SECRET_ALPHABET[bytes[i] % SECRET_ALPHABET.length]
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Rascunho do formulário e diff do PUT
// ---------------------------------------------------------------------------

/**
 * O que o admin alterou NESTA sessão de edição. Cada chave `undefined` = "não
 * mexeu" (vale o que veio do servidor). É um conjunto de SOBREPOSIÇÕES sobre
 * o DTO carregado, não uma cópia dele — assim não há `useEffect` sincronizando
 * estado a partir de dado assíncrono.
 *
 * Segredos: a chave existir (mesmo `""`) significa "o admin clicou em
 * Substituir"; nunca é pré-preenchida com valor existente (o GET não devolve).
 */
export interface GatewayDraft {
  environment?: PaymentGatewayEnvironment
  /** `true` só depois de o admin digitar a palavra PRODUÇÃO no diálogo de confirmação. */
  productionConfirmed?: boolean
  merchantId?: string
  sopClientId?: string
  merchantKey?: string
  sopClientSecret?: string
  webhookHeaderSecret?: string
  /** Só UI: o segredo do webhook foi GERADO aqui e por isso fica visível (texto) para o admin copiar. Nunca vai no PUT. */
  webhookSecretRevealed?: boolean
  cardEnabled?: boolean
  pixEnabled?: boolean
}

/** Mínimo do segredo do header do webhook (servidor, Órion B2): 32. O gerador (40) já atende. */
export const WEBHOOK_SECRET_MIN = 32

/**
 * O que MUDOU (o diff do PUT), sem a senha: é isto que a tela monta, valida e resume. A senha atual (step-up) só se
 * junta no último instante, em `withCurrentPassword` — assim ela não passa por rascunho, resumo nem cache.
 */
export type GatewayChanges = Omit<UpdatePaymentGatewayConfigRequest, "currentPassword">

/** Junta a senha atual (step-up, obrigatória em TODO PUT) ao diff. Não guarda nem repete a senha em lugar nenhum. */
export function withCurrentPassword(changes: GatewayChanges, currentPassword: string): UpdatePaymentGatewayConfigRequest {
  return { ...changes, currentPassword }
}

export const SECRET_FIELDS = ["merchantKey", "sopClientSecret", "webhookHeaderSecret"] as const
export type SecretField = (typeof SECRET_FIELDS)[number]

/**
 * PARES de credenciais: andam JUNTOS no servidor (`merchantId`+`merchantKey`,
 * `sopClientId`+`sopClientSecret`). Se o par ainda vem do env (`source: "env"`)
 * ou não há segredo salvo, enviar só um lado => 409 `GATEWAY_NOT_READY` com a
 * metade que falta. Com `source: "database"` e o segredo já salvo, trocar só o
 * id é permitido.
 */
export const CREDENTIAL_PAIRS = [
  {
    id: "merchantId",
    secret: "merchantKey",
    idWithArticle: "o MerchantId",
    secretWithArticle: "a MerchantKey",
    secretSet: (dto: PaymentGatewayConfigDTO) => dto.merchantKeySet,
  },
  {
    id: "sopClientId",
    secret: "sopClientSecret",
    idWithArticle: "o Client ID do cadastro de cartão",
    secretWithArticle: "o Client Secret do cadastro de cartão",
    secretSet: (dto: PaymentGatewayConfigDTO) => dto.sopClientSecretSet,
  },
] as const

/**
 * Monta o corpo do PUT com SÓ o que mudou em relação ao DTO carregado
 * (campo ausente = "não mexer", contrato do servidor):
 *  - texto em branco não é enviado (não existe "apagar" nesta versão);
 *  - segredo só vai se foi substituído e tem conteúdo (depois do trim);
 *  - `confirmProduction: true` só quando vira sandbox → produção E o admin
 *    confirmou digitando.
 */
export function buildUpdatePayload(dto: PaymentGatewayConfigDTO, draft: GatewayDraft): GatewayChanges {
  const payload: GatewayChanges = {}

  if (draft.environment !== undefined && draft.environment !== dto.environment) {
    payload.environment = draft.environment
    if (dto.environment === "sandbox" && draft.environment === "production" && draft.productionConfirmed) {
      payload.confirmProduction = true
    }
  }

  const merchantId = draft.merchantId?.trim()
  if (merchantId && merchantId !== (dto.merchantId ?? "")) payload.merchantId = merchantId
  const sopClientId = draft.sopClientId?.trim()
  if (sopClientId && sopClientId !== (dto.sopClientId ?? "")) payload.sopClientId = sopClientId

  const merchantKey = draft.merchantKey?.trim()
  if (merchantKey) payload.merchantKey = merchantKey
  const sopClientSecret = draft.sopClientSecret?.trim()
  if (sopClientSecret) payload.sopClientSecret = sopClientSecret
  const webhookHeaderSecret = draft.webhookHeaderSecret?.trim()
  if (webhookHeaderSecret) payload.webhookHeaderSecret = webhookHeaderSecret

  if (draft.cardEnabled !== undefined && draft.cardEnabled !== dto.cardEnabled) payload.cardEnabled = draft.cardEnabled
  if (draft.pixEnabled !== undefined && draft.pixEnabled !== dto.pixEnabled) payload.pixEnabled = draft.pixEnabled

  // Par vindo do env: trocar só a chave exige reenviar o id junto (regra do servidor). Se o id já
  // está VISÍVEL no campo (valor do env), o admin não precisa redigitá-lo — a tela o reenvia.
  if (dto.source === "env") {
    for (const pair of CREDENTIAL_PAIRS) {
      if (payload[pair.secret] !== undefined && payload[pair.id] === undefined) {
        const visible = (draft[pair.id] ?? dto[pair.id] ?? "").trim()
        if (visible) payload[pair.id] = visible
      }
    }
  }

  return payload
}

export function hasChanges(payload: GatewayChanges): boolean {
  return Object.keys(payload).length > 0
}

export type DraftErrors = Partial<Record<SecretField | "merchantId" | "sopClientId", string>>

/**
 * Valida os PARES de credenciais sobre o PAYLOAD já montado (o que será enviado
 * é o que se valida). O erro vai no campo que FALTA — o lado que o admin ainda
 * precisa preencher na mesma alteração.
 */
export function validateCredentialPairs(dto: PaymentGatewayConfigDTO, payload: GatewayChanges): DraftErrors {
  const errors: DraftErrors = {}
  for (const pair of CREDENTIAL_PAIRS) {
    const idSent = payload[pair.id] !== undefined
    const secretSent = payload[pair.secret] !== undefined
    if (idSent && !secretSent && (dto.source === "env" || !pair.secretSet(dto))) {
      errors[pair.secret] = `Ao informar ${pair.idWithArticle}, informe também ${pair.secretWithArticle} nesta mesma alteração.`
    } else if (secretSent && !idSent && dto.source === "env") {
      errors[pair.id] = `Ao informar ${pair.secretWithArticle}, informe também ${pair.idWithArticle} nesta mesma alteração.`
    }
  }
  return errors
}

/** Validações que o cliente consegue fazer sem inventar regra: hoje, só o mínimo de 32 do segredo do webhook (contrato). */
export function validateDraft(draft: GatewayDraft): DraftErrors {
  const errors: DraftErrors = {}
  const secret = draft.webhookHeaderSecret?.trim()
  if (secret && secret.length < WEBHOOK_SECRET_MIN) {
    errors.webhookHeaderSecret = `O segredo precisa ter pelo menos ${WEBHOOK_SECRET_MIN} caracteres.`
  }
  return errors
}

export interface ChangeSummaryItem {
  key: string
  label: string
  /** Valor anterior (omitido para segredos — nunca há valor a mostrar). */
  from?: string
  /** Valor novo; para segredos é o texto fixo "Será substituída", NUNCA o valor digitado. */
  to: string
  secret?: boolean
}

const ENABLED_LABEL = (v: boolean) => (v ? "Habilitado" : "Desabilitado")

/** Linhas do diálogo de confirmação a partir do PAYLOAD já montado (o que será enviado é exatamente o que se mostra). */
export function describeChanges(dto: PaymentGatewayConfigDTO, payload: GatewayChanges): ChangeSummaryItem[] {
  const items: ChangeSummaryItem[] = []
  if (payload.environment) {
    items.push({ key: "environment", label: "Ambiente", from: ENVIRONMENT_LABELS[dto.environment], to: ENVIRONMENT_LABELS[payload.environment] })
  }
  if (payload.merchantId !== undefined) {
    items.push({ key: "merchantId", label: "MerchantId", from: dto.merchantId ?? "não informado", to: payload.merchantId })
  }
  if (payload.merchantKey !== undefined) items.push({ key: "merchantKey", label: "MerchantKey", to: "Será substituída", secret: true })
  if (payload.sopClientId !== undefined) {
    items.push({ key: "sopClientId", label: "Client ID (cadastro de cartão)", from: dto.sopClientId ?? "não informado", to: payload.sopClientId })
  }
  if (payload.sopClientSecret !== undefined) items.push({ key: "sopClientSecret", label: "Client Secret (cadastro de cartão)", to: "Será substituída", secret: true })
  if (payload.webhookHeaderSecret !== undefined) items.push({ key: "webhookHeaderSecret", label: "Segredo do header do webhook", to: "Será substituída", secret: true })
  if (payload.pixEnabled !== undefined) items.push({ key: "pixEnabled", label: "Pix", from: ENABLED_LABEL(dto.pixEnabled), to: ENABLED_LABEL(payload.pixEnabled) })
  if (payload.cardEnabled !== undefined) items.push({ key: "cardEnabled", label: "Cartão", from: ENABLED_LABEL(dto.cardEnabled), to: ENABLED_LABEL(payload.cardEnabled) })
  return items
}

// ---------------------------------------------------------------------------
// Erros do PUT, por `code`
// ---------------------------------------------------------------------------

export interface GatewaySaveError {
  code: string | undefined
  message: string
  /** Só em `GATEWAY_NOT_READY`: o que falta, vindo de `details` do servidor. */
  requirements: PaymentGatewayRequirement[]
  /** `true` quando o rascunho da tela continua intacto e o admin pode tentar de novo (tudo, exceto sessão expirada, que leva ao login). */
  draftKept: boolean
}

/** Texto único para "nada foi alterado" em erros transitórios do servidor (429/503/500). */
export const GATEWAY_RATE_LIMITED_MESSAGE = "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo."
export const GATEWAY_UNAVAILABLE_MESSAGE =
  "O servidor não conseguiu ler a configuração do gateway — o banco pode estar fora do ar ou a PAYMENT_SECRETS_KEY foi trocada. Nada foi alterado."
export const GATEWAY_INTERNAL_ERROR_MESSAGE = "Não foi possível salvar e nada foi alterado. Tente novamente."
export const GATEWAY_WRONG_PASSWORD_MESSAGE = "Senha incorreta."
export const GATEWAY_SESSION_EXPIRED_MESSAGE = "Sua sessão expirou. Entre de novo para continuar — nada foi alterado."

/**
 * Mensagem para erros que valem tanto no GET quanto no PUT (sessão, limite, configuração ilegível, falha interna),
 * ou `null` se o erro não é um desses. Decide por `code` e, na falta dele (proxy na frente), por status.
 */
export function gatewayTransientErrorMessage(code: string | undefined, status: number | undefined): string | null {
  if (code === "UNAUTHORIZED" || (code === undefined && status === 401)) return GATEWAY_SESSION_EXPIRED_MESSAGE
  if (code === "RATE_LIMITED" || code === "RATE_LIMITED_PAYMENT_GATEWAY" || (code === undefined && status === 429)) return GATEWAY_RATE_LIMITED_MESSAGE
  if (code === "PAYMENT_GATEWAY_UNAVAILABLE") return GATEWAY_UNAVAILABLE_MESSAGE
  if (code === "INTERNAL_ERROR") return GATEWAY_INTERNAL_ERROR_MESSAGE
  return null
}

/** Mensagem do erro ao CARREGAR a tela (GET), ou `null` para cair no texto do servidor/genérico. */
export function parseGatewayLoadError(err: unknown): string | null {
  if (!axios.isAxiosError(err) || !err.response) return null
  const body = err.response.data as { code?: unknown } | undefined
  return gatewayTransientErrorMessage(typeof body?.code === "string" ? body.code : undefined, err.response.status)
}

/**
 * `details` do 409 "lista os PaymentGatewayRequirement" (contrato). O tipo
 * genérico `ApiErrorBody.details` é um array de objetos, então aceitamos as
 * duas formas — string solta (`"MERCHANT_KEY"`) ou objeto com o código em
 * `requirement`/`code`/`path`/`message` — e ignoramos o que não reconhecer.
 */
export function extractRequirements(details: unknown): PaymentGatewayRequirement[] {
  if (!Array.isArray(details)) return []
  const found: PaymentGatewayRequirement[] = []
  for (const item of details) {
    const candidates: unknown[] =
      typeof item === "string" ? [item] : item && typeof item === "object" ? [(item as Record<string, unknown>).requirement, (item as Record<string, unknown>).code, (item as Record<string, unknown>).path, (item as Record<string, unknown>).message] : []
    const match = candidates.find(isKnownRequirement)
    if (match && !found.includes(match)) found.push(match)
  }
  return found
}

/** `details` do 409 `GATEWAY_HAS_INFLIGHT_PAYMENTS` é `{ count }` (aceita também `[{ count }]`). `null` se não houver um número válido. */
export function extractInflightCount(details: unknown): number | null {
  const source: unknown = Array.isArray(details) ? details[0] : details
  if (!source || typeof source !== "object") return null
  const count = (source as { count?: unknown }).count
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null
}

/** Texto do 409 de pagamentos em andamento. Sem `count` legível, não inventa número. */
export function inflightPaymentsMessage(count: number | null): string {
  const tail = "Aguarde liquidarem para trocar o ambiente."
  if (count === null) return `Há pagamentos em andamento neste ambiente. ${tail}`
  return count === 1 ? `Há 1 pagamento em andamento neste ambiente. ${tail}` : `Há ${count} pagamentos em andamento neste ambiente. ${tail}`
}

/**
 * Traduz o erro do PUT para texto + lista de pendências. NUNCA ecoa o corpo da
 * requisição (que carrega segredos): só usa `code`, e o `error` do servidor
 * apenas em `VALIDATION_ERROR`/genérico, onde é texto do servidor sobre o campo.
 */
export function parseGatewaySaveError(err: unknown): GatewaySaveError {
  if (!axios.isAxiosError(err) || !err.response) {
    return { code: undefined, message: "Não foi possível falar com o servidor. Confira a conexão e tente de novo — nada foi salvo.", requirements: [], draftKept: true }
  }
  const body = err.response.data as { error?: unknown; code?: unknown; details?: unknown } | undefined
  const code = typeof body?.code === "string" ? body.code : undefined
  const serverMessage = typeof body?.error === "string" ? body.error : undefined

  const transient = gatewayTransientErrorMessage(code, err.response.status)
  if (transient) {
    return { code: code ?? (err.response.status === 429 ? "RATE_LIMITED" : "UNAUTHORIZED"), message: transient, requirements: [], draftKept: transient !== GATEWAY_SESSION_EXPIRED_MESSAGE }
  }

  switch (code) {
    case "GATEWAY_NOT_READY":
      return {
        code,
        message: "O servidor recusou: faltam pré-requisitos para o que você pediu (passar para produção, habilitar um meio de pagamento ou completar um par de credenciais). Nada foi salvo.",
        requirements: extractRequirements(body?.details),
        draftKept: true,
      }
    case "PAYMENT_SECRETS_KEY_MISSING":
      return {
        code,
        message: `O servidor não tem a variável PAYMENT_SECRETS_KEY, então não consegue guardar segredos com segurança — nada foi salvo. Peça para quem cuida do servidor criá-la no EasyPanel (gere o valor com "${PAYMENT_SECRETS_KEY_COMMAND}") e reiniciar a API. Alterações que não envolvem segredos podem ser salvas normalmente.`,
        requirements: ["PAYMENT_SECRETS_KEY"],
        draftKept: true,
      }
    case "PRODUCTION_CONFIRMATION_REQUIRED":
      return {
        code,
        message: "A mudança para produção exige confirmação digitada. Escolha Produção de novo, digite a palavra pedida e salve outra vez.",
        requirements: [],
        draftKept: true,
      }
    case "VALIDATION_ERROR":
      return { code, message: `O servidor não aceitou algum valor${serverMessage ? `: ${serverMessage}` : "."} Revise os campos e tente de novo.`, requirements: [], draftKept: true }
    case "INVALID_CURRENT_PASSWORD":
      // 403 (e não 401): a sessão continua válida. Quem trata é o diálogo de salvar, que fica aberto com o rascunho intacto.
      return { code, message: GATEWAY_WRONG_PASSWORD_MESSAGE, requirements: [], draftKept: true }
    case "STEPUP_UNAVAILABLE":
      // 503 fail-closed (F5.8): o servidor NÃO conseguiu conferir a senha (Redis do throttle fora) e não gravou nada. Não é senha errada nem sessão inválida.
      return { code, message: "Não foi possível confirmar sua senha agora. Nada foi salvo. Tente de novo em instantes.", requirements: [], draftKept: true }
    case "GATEWAY_HAS_INFLIGHT_PAYMENTS":
      return { code, message: inflightPaymentsMessage(extractInflightCount(body?.details)), requirements: [], draftKept: true }
    case "FORBIDDEN":
      return { code, message: "Somente administradores podem alterar o gateway de pagamento.", requirements: [], draftKept: true }
    default:
      return { code, message: "Não foi possível salvar a configuração. Tente de novo em instantes.", requirements: [], draftKept: true }
  }
}
