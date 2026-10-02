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
/** Piso para o segredo gerado: o servidor aceita ≥ 8, mas um segredo de header estático merece bem mais. */
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

export const WEBHOOK_SECRET_MIN = 8

export const SECRET_FIELDS = ["merchantKey", "sopClientSecret", "webhookHeaderSecret"] as const
export type SecretField = (typeof SECRET_FIELDS)[number]

/**
 * Monta o corpo do PUT com SÓ o que mudou em relação ao DTO carregado
 * (campo ausente = "não mexer", contrato do servidor):
 *  - texto em branco não é enviado (não existe "apagar" nesta versão);
 *  - segredo só vai se foi substituído e tem conteúdo (depois do trim);
 *  - `confirmProduction: true` só quando vira sandbox → produção E o admin
 *    confirmou digitando.
 */
export function buildUpdatePayload(dto: PaymentGatewayConfigDTO, draft: GatewayDraft): UpdatePaymentGatewayConfigRequest {
  const payload: UpdatePaymentGatewayConfigRequest = {}

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

  return payload
}

export function hasChanges(payload: UpdatePaymentGatewayConfigRequest): boolean {
  return Object.keys(payload).length > 0
}

export type DraftErrors = Partial<Record<SecretField | "merchantId" | "sopClientId", string>>

/** Validações que o cliente consegue fazer sem inventar regra: hoje, só o mínimo de 8 do segredo do webhook (contrato). */
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
export function describeChanges(dto: PaymentGatewayConfigDTO, payload: UpdatePaymentGatewayConfigRequest): ChangeSummaryItem[] {
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

/**
 * Traduz o erro do PUT para texto + lista de pendências. NUNCA ecoa o corpo da
 * requisição (que carrega segredos): só usa `code`, e o `error` do servidor
 * apenas em `VALIDATION_ERROR`/genérico, onde é texto do servidor sobre o campo.
 */
export function parseGatewaySaveError(err: unknown): GatewaySaveError {
  if (!axios.isAxiosError(err) || !err.response) {
    return { code: undefined, message: "Não foi possível falar com o servidor. Confira a conexão e tente de novo — nada foi salvo.", requirements: [] }
  }
  const body = err.response.data as { error?: unknown; code?: unknown; details?: unknown } | undefined
  const code = typeof body?.code === "string" ? body.code : undefined
  const serverMessage = typeof body?.error === "string" ? body.error : undefined

  switch (code) {
    case "GATEWAY_NOT_READY":
      return {
        code,
        message: "O servidor recusou: faltam pré-requisitos para ativar o que você pediu (produção ou habilitar um meio de pagamento). Nada foi salvo.",
        requirements: extractRequirements(body?.details),
      }
    case "PAYMENT_SECRETS_KEY_MISSING":
      return {
        code,
        message: `O servidor não tem a variável PAYMENT_SECRETS_KEY, então não consegue guardar segredos com segurança — nada foi salvo. Peça para quem cuida do servidor criá-la no EasyPanel (gere o valor com "${PAYMENT_SECRETS_KEY_COMMAND}") e reiniciar a API. Alterações que não envolvem segredos podem ser salvas normalmente.`,
        requirements: ["PAYMENT_SECRETS_KEY"],
      }
    case "PRODUCTION_CONFIRMATION_REQUIRED":
      return {
        code,
        message: "A mudança para produção exige confirmação digitada. Escolha Produção de novo, digite a palavra pedida e salve outra vez.",
        requirements: [],
      }
    case "VALIDATION_ERROR":
      return { code, message: `O servidor não aceitou algum valor${serverMessage ? `: ${serverMessage}` : "."} Revise os campos e tente de novo.`, requirements: [] }
    case "FORBIDDEN":
      return { code, message: "Somente administradores podem alterar o gateway de pagamento.", requirements: [] }
    default:
      return { code, message: "Não foi possível salvar a configuração. Tente de novo em instantes.", requirements: [] }
  }
}
