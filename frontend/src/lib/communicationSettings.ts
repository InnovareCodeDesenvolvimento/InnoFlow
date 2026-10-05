import axios from "axios"
import type {
  CommunicationSettingsDTO,
  NotificationSeverity,
  TestChannelErrorCode,
  SmtpConnectionStage,
  TestEmailRequest,
  TestSmtpConnectionRequest,
  TestWhatsappRequest,
  UpdateCommunicationSettingsRequest,
} from "@/types/api"

/**
 * Regras PURAS da tela Admin → Comunicação (N-7: e-mail SMTP + WhatsApp Evolution). Nada aqui toca rede, DOM nem React: montagem do diff do PUT, validação
 * dos campos, resumo do que muda, montagem dos testes e tradução dos erros POR `code` (nunca pelo texto do servidor).
 *
 * Princípios (iguais aos do gateway, `lib/paymentGateway.ts`):
 *  - SEGREDOS são só de escrita. O GET devolve `passwordSet`/`apiKeySet` (e 4 caracteres de dica da apikey); o rascunho só guarda um segredo quando o admin decide
 *    SUBSTITUÍ-LO, e nada daqui devolve o valor de um segredo em texto (resumo, mensagem de erro).
 *  - campo ausente no PUT = "não mexer": só vai o que mudou. Texto em branco num campo obrigatório = "manter o valor atual" (o servidor não tem "limpar" para eles).
 *  - trocar o DESTINO de um segredo (host/usuário SMTP, URL/instância Evolution) exige digitar o segredo de novo (`SECRET_REQUIRED_FOR_NEW_DESTINATION`).
 */

// ---------------------------------------------------------------------------
// Constantes e rótulos
// ---------------------------------------------------------------------------

export const MAX_RECIPIENTS = 10

export const SEVERITY_ORDER: NotificationSeverity[] = ["INFO", "IMPORTANTE", "CRITICO"]

export const SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  INFO: "Informativo (todos os avisos)",
  IMPORTANTE: "Importante (importantes e críticos)",
  CRITICO: "Crítico (só os críticos)",
}

/** Forma curta, para o resumo do diálogo e o texto do piso global. */
export const SEVERITY_SHORT: Record<NotificationSeverity, string> = {
  INFO: "Informativo",
  IMPORTANTE: "Importante",
  CRITICO: "Crítico",
}

export const SECURE_LABELS = {
  false: "STARTTLS (porta 587)",
  true: "TLS direto (porta 465)",
} as const

export const DEDUPE_MIN = 1
export const DEDUPE_MAX = 1440

export type Channel = "email" | "whatsapp"
export const CHANNEL_NAMES: Record<Channel, string> = { email: "E-mail", whatsapp: "WhatsApp" }

// ---------------------------------------------------------------------------
// Rascunho (sobreposições sobre o DTO)
// ---------------------------------------------------------------------------

/** `undefined` = o admin não mexeu. Segredo `undefined` = intocado; string (mesmo "") = abriu o campo para substituir. */
export interface EmailDraft {
  enabled?: boolean
  host?: string
  port?: string
  secure?: boolean
  user?: string
  password?: string
  fromName?: string
  fromAddress?: string
  /** Campo ÚNICO "Remetente" da tela ("Nome <email>" ou só o e-mail). Quando presente, vale por cima de `fromName`/`fromAddress` (ver `parseFrom`). */
  from?: string
  /** Texto bruto (um por linha, ou separados por vírgula/ponto e vírgula). */
  recipients?: string
  minSeverity?: NotificationSeverity
}

export interface WhatsappDraft {
  enabled?: boolean
  baseUrl?: string
  instance?: string
  apiKey?: string
  apiVersion?: 1 | 2
  recipients?: string
  minSeverity?: NotificationSeverity
}

export interface AlertsDraft {
  /** Texto do campo; "" = voltar ao padrão do servidor. */
  dedupeMinutes?: string
}

/** Segredos marcados para APAGAR (`clearSecrets`). */
export interface ClearDraft {
  smtpPassword?: boolean
  evolutionApiKey?: boolean
}

export interface CommunicationDraft {
  email: EmailDraft
  whatsapp: WhatsappDraft
  alerts: AlertsDraft
  clear: ClearDraft
}

export const EMPTY_DRAFT: CommunicationDraft = { email: {}, whatsapp: {}, alerts: {}, clear: {} }

/** O PUT sem a senha atual (que só entra na hora de enviar, `withCurrentPassword`). */
export type CommunicationChanges = Omit<UpdateCommunicationSettingsRequest, "currentPassword">

export function withCurrentPassword(changes: CommunicationChanges, currentPassword: string): UpdateCommunicationSettingsRequest {
  return { ...changes, currentPassword }
}

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

/** Quebra o texto em itens (nova linha, vírgula, ponto e vírgula ou espaço), sem vazios e sem repetidos (ignora caixa). */
export function parseRecipientList(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of text.split(/[\s,;]+/)) {
    const item = part.trim()
    if (!item) continue
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** "+55 (11) 99999-9999" -> "5511999999999". */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "")
}

/** Lista de números a partir do texto: aceita máscara, normaliza para só dígitos e tira repetidos. Itens sem dígito nenhum são mantidos (para o validador acusar). */
export function parsePhoneList(text: string): string[] {
  // Máscara tem espaço no meio ("+55 (11) 99999-9999"): separa só por nova linha, vírgula ou ponto e vírgula.
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of text.split(/[\n,;]+/)) {
    if (!part.trim()) continue
    const digits = normalizePhone(part)
    const item = digits || part.trim()
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value)
}

/** Nome que entra no remetente quando o admin digita só o e-mail (a dica da tela promete isso). */
export const DEFAULT_FROM_NAME = "InnoFlow"
export const FROM_ERROR = "Remetente inválido. Use Nome <email@seudominio.com.br> ou só o e-mail (o nome tem até 80 caracteres)."

/**
 * "InnoFlow <no-reply@seudominio.com.br>" -> { name, address }. Só o e-mail -> nome padrão (`DEFAULT_FROM_NAME`). `null` se o e-mail é inválido ou o nome passa de 80
 * caracteres. Aceita o nome entre aspas ("Inno Flow" <a@b.com>).
 */
export function parseFrom(text: string): { name: string; address: string } | null {
  const raw = text.trim()
  if (!raw) return null
  const bracket = /^(.*?)\s*<([^<>]*)>$/.exec(raw)
  const address = (bracket ? bracket[2] : raw).trim()
  const name = (bracket ? bracket[1] : "").trim().replace(/^"(.*)"$/, "$1").trim() || DEFAULT_FROM_NAME
  if (!isEmailAddress(address) || name.length > 80) return null
  return { name, address }
}

/** O que o campo "Remetente" mostra para o que está salvo. */
export function formatFrom(name: string | null, address: string | null): string {
  if (!address) return ""
  return name ? `${name} <${address}>` : address
}

/** DDI + número, só dígitos: 10 a 15 (E.164). A validação final é do servidor; aqui só barramos o óbvio. */
export function isPhoneNumber(value: string): boolean {
  return /^\d{10,15}$/.test(value)
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v.toLowerCase() === b[i]?.toLowerCase())

/** Máscara de exibição de números salvos: o DTO já traz só dígitos; para o campo usamos um por linha. */
export const recipientsToText = (list: string[]) => list.join("\n")

/** "…a1b2" a partir de `apiKeyHint` (aceita com ou sem a reticência). */
export function formatApiKeyHint(hint: string | null): string | null {
  if (!hint) return null
  return `…${hint.replace(/^…/, "")}`
}

// ---------------------------------------------------------------------------
// Valores efetivos (rascunho sobre o salvo) e regras de destino/segredo
// ---------------------------------------------------------------------------

const trimmed = (value: string | undefined) => value?.trim()

/** Mudou o DESTINO da senha SMTP (host ou usuário)? Brancos = "manter", então só conta quando há valor novo diferente do salvo. */
export function smtpDestinationChanged(dto: CommunicationSettingsDTO, draft: EmailDraft): boolean {
  const host = trimmed(draft.host)
  const user = trimmed(draft.user)
  return (host !== undefined && host !== "" && host !== (dto.email.host ?? "")) || (user !== undefined && user !== (dto.email.user ?? ""))
}

/** Mudou o DESTINO da apikey (URL base ou instância)? */
export function evolutionDestinationChanged(dto: CommunicationSettingsDTO, draft: WhatsappDraft): boolean {
  const baseUrl = trimmed(draft.baseUrl)
  const instance = trimmed(draft.instance)
  return (baseUrl !== undefined && baseUrl !== "" && baseUrl !== (dto.whatsapp.baseUrl ?? "")) || (instance !== undefined && instance !== "" && instance !== (dto.whatsapp.instance ?? ""))
}

const hasText = (value: string | undefined) => value !== undefined && value.length > 0

// ---------------------------------------------------------------------------
// Montagem do PUT (só o diff)
// ---------------------------------------------------------------------------

function buildEmailChanges(dto: CommunicationSettingsDTO, draft: EmailDraft): NonNullable<CommunicationChanges["email"]> {
  const out: NonNullable<CommunicationChanges["email"]> = {}
  const host = trimmed(draft.host)
  if (host && host !== (dto.email.host ?? "")) out.host = host
  const port = trimmed(draft.port)
  if (port) {
    const n = Number(port)
    if (Number.isInteger(n) && n !== dto.email.port) out.port = n
  }
  if (draft.secure !== undefined && draft.secure !== dto.email.secure) out.secure = draft.secure
  const user = trimmed(draft.user)
  if (user !== undefined && user !== (dto.email.user ?? "")) out.user = user === "" ? null : user
  if (hasText(draft.password)) out.password = draft.password
  let fromName = trimmed(draft.fromName)
  let fromAddress = trimmed(draft.fromAddress)
  const parsedFrom = draft.from !== undefined ? parseFrom(draft.from) : null
  if (parsedFrom) {
    fromName = parsedFrom.name
    fromAddress = parsedFrom.address
  }
  if (fromName !== undefined && fromName !== (dto.email.fromName ?? "")) out.fromName = fromName === "" ? null : fromName
  if (fromAddress && fromAddress !== (dto.email.fromAddress ?? "")) out.fromAddress = fromAddress
  if (draft.recipients !== undefined) {
    const list = parseRecipientList(draft.recipients)
    if (!sameList(list, dto.email.recipients)) out.recipients = list
  }
  if (draft.minSeverity !== undefined && draft.minSeverity !== dto.email.minSeverity) out.minSeverity = draft.minSeverity
  return out
}

function buildWhatsappChanges(dto: CommunicationSettingsDTO, draft: WhatsappDraft): NonNullable<CommunicationChanges["whatsapp"]> {
  const out: NonNullable<CommunicationChanges["whatsapp"]> = {}
  const baseUrl = trimmed(draft.baseUrl)
  if (baseUrl && baseUrl !== (dto.whatsapp.baseUrl ?? "")) out.baseUrl = baseUrl
  const instance = trimmed(draft.instance)
  if (instance && instance !== (dto.whatsapp.instance ?? "")) out.instance = instance
  if (hasText(draft.apiKey)) out.apiKey = draft.apiKey
  if (draft.apiVersion !== undefined && draft.apiVersion !== dto.whatsapp.apiVersion) out.apiVersion = draft.apiVersion
  if (draft.recipients !== undefined) {
    const list = parsePhoneList(draft.recipients)
    if (!sameList(list, dto.whatsapp.recipients)) out.recipients = list
  }
  if (draft.minSeverity !== undefined && draft.minSeverity !== dto.whatsapp.minSeverity) out.minSeverity = draft.minSeverity
  return out
}

/**
 * Monta o PUT a partir do rascunho. Só entra o que mudou.
 *
 * `enabled`: vai quando o admin mexeu no interruptor. Além disso, num canal que AINDA NÃO está salvo no painel (`source` `env` ou `none`), qualquer outra gravação
 * cria o grupo no banco, e a 1ª gravação sem `enabled` nasce DESLIGADA (contrato, regra 4) — o que desligaria sem aviso um canal que a variável de ambiente mantinha
 * ligado. Por isso nesse caso o `enabled` EFETIVO (o que a tela mostra) vai junto, explícito.
 */
export function buildUpdatePayload(dto: CommunicationSettingsDTO, draft: CommunicationDraft): CommunicationChanges {
  const payload: CommunicationChanges = {}

  const email = buildEmailChanges(dto, draft.email)
  const emailEnabledChanged = draft.email.enabled !== undefined && draft.email.enabled !== dto.email.enabled
  if (emailEnabledChanged) email.enabled = draft.email.enabled
  else if (Object.keys(email).length > 0 && dto.email.source !== "database") email.enabled = draft.email.enabled ?? dto.email.enabled
  if (Object.keys(email).length > 0) payload.email = email

  const whatsapp = buildWhatsappChanges(dto, draft.whatsapp)
  const whatsappEnabledChanged = draft.whatsapp.enabled !== undefined && draft.whatsapp.enabled !== dto.whatsapp.enabled
  if (whatsappEnabledChanged) whatsapp.enabled = draft.whatsapp.enabled
  else if (Object.keys(whatsapp).length > 0 && dto.whatsapp.source !== "database") whatsapp.enabled = draft.whatsapp.enabled ?? dto.whatsapp.enabled
  if (Object.keys(whatsapp).length > 0) payload.whatsapp = whatsapp

  const dedupe = trimmed(draft.alerts.dedupeMinutes)
  if (dedupe !== undefined) {
    if (dedupe === "") {
      // Em branco = padrão do servidor; só é uma alteração se há um valor salvo no painel para limpar.
      if (dto.alerts.dedupeSource === "database") payload.alerts = { dedupeMinutes: null }
    } else {
      const n = Number(dedupe)
      if (Number.isInteger(n) && n !== dto.alerts.dedupeMinutes) payload.alerts = { dedupeMinutes: n }
    }
  }

  const clear: Array<"smtpPassword" | "evolutionApiKey"> = []
  if (draft.clear.smtpPassword && dto.email.passwordSet && !hasText(draft.email.password)) clear.push("smtpPassword")
  if (draft.clear.evolutionApiKey && dto.whatsapp.apiKeySet && !hasText(draft.whatsapp.apiKey)) clear.push("evolutionApiKey")
  if (clear.length > 0) payload.clearSecrets = clear

  return payload
}

export function hasChanges(payload: CommunicationChanges): boolean {
  return Boolean(payload.email || payload.whatsapp || payload.alerts || payload.clearSecrets)
}

/** `true` se o rascunho tem QUALQUER sobreposição (mesmo uma que não vira alteração): habilita "Descartar". */
export function draftTouched(draft: CommunicationDraft): boolean {
  return (
    Object.values(draft.email).some((v) => v !== undefined) ||
    Object.values(draft.whatsapp).some((v) => v !== undefined) ||
    draft.alerts.dedupeMinutes !== undefined ||
    Boolean(draft.clear.smtpPassword) ||
    Boolean(draft.clear.evolutionApiKey)
  )
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

/** Chave = `grupo.campo` (a mesma usada pelos `details.field` do servidor onde há equivalente). */
export type DraftErrors = Partial<Record<string, string>>

export const HOST_ERROR = "Informe só o endereço (nome ou IP), sem http://, porta ou caminho."

/** Host SMTP: só nome ou IP. */
export function isValidSmtpHost(value: string): boolean {
  if (/\s/.test(value) || /[/\\@?#]/.test(value) || value.includes("://")) return false
  if (/:\d+$/.test(value) && !value.startsWith("[")) return false
  return value.length <= 253
}

export function isValidBaseUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.length > 0
  } catch {
    return false
  }
}

const INSTANCE_RE = /^[A-Za-z0-9._-]+$/

function validateRecipients(list: string[], isValid: (v: string) => boolean, message: string): string | undefined {
  if (list.length > MAX_RECIPIENTS) return `No máximo ${MAX_RECIPIENTS} destinatários por canal.`
  const bad = list.filter((v) => !isValid(v))
  if (bad.length > 0) return `${message} (${bad.slice(0, 2).join(", ")}${bad.length > 2 ? "…" : ""}).`
  return undefined
}

/** Texto do erro "digite o segredo de novo" (também usado no teste com valores não salvos). */
export const SMTP_SECRET_AGAIN_MESSAGE = "Você mudou o servidor ou o usuário: digite a senha SMTP de novo (ela só vale para o destino em que foi salva)."
export const EVOLUTION_SECRET_AGAIN_MESSAGE = "Você mudou a URL ou a instância: digite a apikey de novo (ela só vale para o destino em que foi salva)."
export const NO_SECRETS_KEY_MESSAGE = "O servidor não tem a chave de cifragem (PAYMENT_SECRETS_KEY): não dá para guardar este segredo."

/**
 * Erros de campo do rascunho, por `grupo.campo`. Só avalia o que o admin MEXEU (um valor salvo e válido nunca vira erro por si só). O erro de "digite o segredo de
 * novo" é calculado aqui para o PUT; o do teste (que usa os valores digitados) vem de `validateEmailTest`/`validateWhatsappTest`.
 */
export function validateDraft(dto: CommunicationSettingsDTO, draft: CommunicationDraft): DraftErrors {
  const errors: DraftErrors = {}
  const e = draft.email
  const w = draft.whatsapp

  const host = trimmed(e.host)
  if (host && !isValidSmtpHost(host)) errors["email.host"] = HOST_ERROR
  const port = trimmed(e.port)
  if (port) {
    const n = Number(port)
    if (!/^\d+$/.test(port) || n < 1 || n > 65535) errors["email.port"] = "Porta de 1 a 65535 (587 e 465 são as mais comuns)."
  }
  const fromAddress = trimmed(e.fromAddress)
  if (fromAddress && !isEmailAddress(fromAddress)) errors["email.fromAddress"] = "E-mail do remetente inválido."
  if ((trimmed(e.fromName) ?? "").length > 80) errors["email.fromName"] = "No máximo 80 caracteres."
  if (trimmed(e.from) && !parseFrom(e.from ?? "")) errors["email.from"] = FROM_ERROR
  const user = trimmed(e.user)
  if (user !== undefined && user.length > 254) errors["email.user"] = "Usuário muito longo."
  if (e.recipients !== undefined) {
    const msg = validateRecipients(parseRecipientList(e.recipients), isEmailAddress, "E-mail inválido")
    if (msg) errors["email.recipients"] = msg
  }

  const baseUrl = trimmed(w.baseUrl)
  if (baseUrl && !isValidBaseUrl(baseUrl)) errors["whatsapp.baseUrl"] = "Informe a URL completa, por exemplo https://evolution.seudominio.com.br."
  const instance = trimmed(w.instance)
  if (instance && !INSTANCE_RE.test(instance)) errors["whatsapp.instance"] = "Use só letras, números, ponto, hífen e sublinhado."
  if (w.recipients !== undefined) {
    const msg = validateRecipients(parsePhoneList(w.recipients), isPhoneNumber, "Número inválido: use DDI + DDD + número, só dígitos")
    if (msg) errors["whatsapp.recipients"] = msg
  }

  const dedupe = trimmed(draft.alerts.dedupeMinutes)
  if (dedupe) {
    const n = Number(dedupe)
    if (!/^\d+$/.test(dedupe) || n < DEDUPE_MIN || n > DEDUPE_MAX) errors["alerts.dedupeMinutes"] = `Informe de ${DEDUPE_MIN} a ${DEDUPE_MAX} minutos.`
  }

  // Trocar o DESTINO de um segredo salvo exige digitar o segredo de novo (a não ser que o admin o esteja apagando).
  if (dto.email.passwordSet && smtpDestinationChanged(dto, e) && !hasText(e.password) && !draft.clear.smtpPassword) errors["email.password"] = SMTP_SECRET_AGAIN_MESSAGE
  if (dto.whatsapp.apiKeySet && evolutionDestinationChanged(dto, w) && !hasText(w.apiKey) && !draft.clear.evolutionApiKey) errors["whatsapp.apiKey"] = EVOLUTION_SECRET_AGAIN_MESSAGE

  // Sem chave de cifragem no servidor não há como guardar segredo (503 SECRETS_KEY_MISSING): avisa antes do envio.
  if (!dto.secretsKeyConfigured) {
    if (hasText(e.password)) errors["email.password"] = NO_SECRETS_KEY_MESSAGE
    if (hasText(w.apiKey)) errors["whatsapp.apiKey"] = NO_SECRETS_KEY_MESSAGE
  }

  return errors
}

// ---------------------------------------------------------------------------
// Resumo do que vai ser enviado (diálogo de confirmação)
// ---------------------------------------------------------------------------

export interface ChangeSummaryItem {
  key: string
  label: string
  from?: string
  to: string
  secret?: boolean
}

const onOff = (v: boolean) => (v ? "Ligado" : "Desligado")
const countText = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** Linhas do diálogo a partir do PAYLOAD já montado. Segredos aparecem só como "Será substituída/apagada"; destinatários, só como contagem (como na auditoria do servidor). */
export function describeChanges(dto: CommunicationSettingsDTO, payload: CommunicationChanges): ChangeSummaryItem[] {
  const items: ChangeSummaryItem[] = []
  const e = payload.email
  if (e) {
    if (e.enabled !== undefined) items.push({ key: "email.enabled", label: "Canal de e-mail", from: onOff(dto.email.enabled), to: onOff(e.enabled) })
    if (e.host !== undefined) items.push({ key: "email.host", label: "Servidor SMTP", from: dto.email.host ?? "não informado", to: e.host })
    if (e.port !== undefined) items.push({ key: "email.port", label: "Porta SMTP", from: dto.email.port !== null ? String(dto.email.port) : "não informada", to: String(e.port) })
    if (e.secure !== undefined) items.push({ key: "email.secure", label: "Conexão segura", from: SECURE_LABELS[String(dto.email.secure) as "true" | "false"], to: SECURE_LABELS[String(e.secure) as "true" | "false"] })
    if (e.user !== undefined) items.push({ key: "email.user", label: "Usuário SMTP", from: dto.email.user ?? "não informado", to: e.user ?? "removido" })
    if (e.password !== undefined) items.push({ key: "email.password", label: "Senha SMTP", to: "Será substituída", secret: true })
    if (e.fromName !== undefined) items.push({ key: "email.fromName", label: "Nome do remetente", from: dto.email.fromName ?? "não informado", to: e.fromName ?? "removido" })
    if (e.fromAddress !== undefined) items.push({ key: "email.fromAddress", label: "E-mail do remetente", from: dto.email.fromAddress ?? "não informado", to: e.fromAddress })
    if (e.recipients !== undefined)
      items.push({ key: "email.recipients", label: "Destinatários de e-mail", from: countText(dto.email.recipients.length, "destinatário", "destinatários"), to: countText(e.recipients.length, "destinatário", "destinatários") })
    if (e.minSeverity !== undefined) items.push({ key: "email.minSeverity", label: "Severidade mínima (e-mail)", from: SEVERITY_SHORT[dto.email.minSeverity], to: SEVERITY_SHORT[e.minSeverity] })
  }
  const w = payload.whatsapp
  if (w) {
    if (w.enabled !== undefined) items.push({ key: "whatsapp.enabled", label: "Canal de WhatsApp", from: onOff(dto.whatsapp.enabled), to: onOff(w.enabled) })
    if (w.baseUrl !== undefined) items.push({ key: "whatsapp.baseUrl", label: "URL da Evolution API", from: dto.whatsapp.baseUrl ?? "não informada", to: w.baseUrl })
    if (w.instance !== undefined) items.push({ key: "whatsapp.instance", label: "Instância", from: dto.whatsapp.instance ?? "não informada", to: w.instance })
    if (w.apiKey !== undefined) items.push({ key: "whatsapp.apiKey", label: "Apikey da Evolution", to: "Será substituída", secret: true })
    if (w.apiVersion !== undefined) items.push({ key: "whatsapp.apiVersion", label: "Versão da API", from: `v${dto.whatsapp.apiVersion}`, to: `v${w.apiVersion}` })
    if (w.recipients !== undefined)
      items.push({ key: "whatsapp.recipients", label: "Números de WhatsApp", from: countText(dto.whatsapp.recipients.length, "número", "números"), to: countText(w.recipients.length, "número", "números") })
    if (w.minSeverity !== undefined) items.push({ key: "whatsapp.minSeverity", label: "Severidade mínima (WhatsApp)", from: SEVERITY_SHORT[dto.whatsapp.minSeverity], to: SEVERITY_SHORT[w.minSeverity] })
  }
  if (payload.alerts && payload.alerts.dedupeMinutes !== undefined) {
    items.push({
      key: "alerts.dedupeMinutes",
      label: "Janela de repetição",
      from: `${dto.alerts.dedupeMinutes} min`,
      to: payload.alerts.dedupeMinutes === null ? "Padrão do servidor" : `${payload.alerts.dedupeMinutes} min`,
    })
  }
  for (const secret of payload.clearSecrets ?? []) {
    items.push(
      secret === "smtpPassword"
        ? { key: "clear.smtpPassword", label: "Senha SMTP", to: "Será apagada", secret: true }
        : { key: "clear.evolutionApiKey", label: "Apikey da Evolution", to: "Será apagada", secret: true },
    )
  }
  return items
}

// ---------------------------------------------------------------------------
// Testes (e-mail e WhatsApp)
// ---------------------------------------------------------------------------

const EMAIL_CONFIG_KEYS = ["host", "port", "secure", "user", "password", "fromName", "fromAddress", "from"] as const
const WHATSAPP_CONFIG_KEYS = ["baseUrl", "instance", "apiKey", "apiVersion"] as const

/** O rascunho mexeu em algo que o teste usa (conexão/remetente)? Sem isso o teste vale para a config SALVA. */
export function emailTestUsesDraft(draft: EmailDraft): boolean {
  return EMAIL_CONFIG_KEYS.some((k) => draft[k] !== undefined && (typeof draft[k] !== "string" || (draft[k] as string).trim() !== "" || k === "user" || k === "fromName"))
}

export function whatsappTestUsesDraft(draft: WhatsappDraft): boolean {
  return WHATSAPP_CONFIG_KEYS.some((k) => draft[k] !== undefined && (typeof draft[k] !== "string" || (draft[k] as string).trim() !== ""))
}

/** Destino padrão do teste: o 1º destinatário (do rascunho, se editado; senão do salvo). */
export function firstEmailRecipient(dto: CommunicationSettingsDTO, draft: EmailDraft): string | undefined {
  return (draft.recipients !== undefined ? parseRecipientList(draft.recipients) : dto.email.recipients)[0]
}

export function firstWhatsappRecipient(dto: CommunicationSettingsDTO, draft: WhatsappDraft): string | undefined {
  return (draft.recipients !== undefined ? parsePhoneList(draft.recipients) : dto.whatsapp.recipients)[0]
}

export interface TestPlan<T> {
  request?: T
  /** Erros de campo que impedem o teste (mesmas chaves de `DraftErrors`; "to" = campo de destino do teste). */
  errors: DraftErrors
}

/**
 * Teste de e-mail. Com alteração de conexão/remetente no rascunho, envia `config` com os valores EFETIVOS (rascunho sobre o salvo) — o servidor testa o que o admin vê
 * sem gravar nada. A senha só vai se foi digitada; se o destino mudou e há senha salva, exige digitar de novo (como no PUT).
 */
export function planEmailTest(dto: CommunicationSettingsDTO, draft: EmailDraft, toText: string, errors: DraftErrors): TestPlan<TestEmailRequest> {
  const out: DraftErrors = {}
  const to = toText.trim() || firstEmailRecipient(dto, draft)
  if (!to) out.to = "Informe o e-mail que vai receber o teste (não há destinatário salvo)."
  else if (!isEmailAddress(to)) out.to = "E-mail de destino inválido."

  const usesDraft = emailTestUsesDraft(draft)
  let config: TestEmailRequest["config"]
  if (usesDraft) {
    for (const key of ["email.host", "email.port", "email.fromAddress", "email.fromName", "email.user"]) if (errors[key]) out[key] = errors[key]
    if (smtpDestinationChanged(dto, draft) && dto.email.passwordSet && !hasText(draft.password)) out["email.password"] = SMTP_SECRET_AGAIN_MESSAGE
    if (!dto.secretsKeyConfigured && hasText(draft.password)) out["email.password"] = NO_SECRETS_KEY_MESSAGE
    const port = trimmed(draft.port)
    config = {
      host: trimmed(draft.host) || dto.email.host || undefined,
      port: port ? Number(port) : (dto.email.port ?? undefined),
      secure: draft.secure ?? dto.email.secure,
      user: draft.user !== undefined ? trimmed(draft.user) || null : dto.email.user,
      fromName: draft.fromName !== undefined ? trimmed(draft.fromName) || null : dto.email.fromName,
      fromAddress: trimmed(draft.fromAddress) || dto.email.fromAddress || undefined,
      ...(hasText(draft.password) ? { password: draft.password } : {}),
    }
  }
  if (Object.keys(out).length > 0) return { errors: out }
  return { errors: out, request: { ...(to ? { to } : {}), ...(config ? { config } : {}) } }
}

export function planWhatsappTest(dto: CommunicationSettingsDTO, draft: WhatsappDraft, toText: string, errors: DraftErrors): TestPlan<TestWhatsappRequest> {
  const out: DraftErrors = {}
  const typed = normalizePhone(toText)
  const to = typed || firstWhatsappRecipient(dto, draft)
  if (!to) out.to = "Informe o número que vai receber o teste (não há número salvo)."
  else if (!isPhoneNumber(to)) out.to = "Número inválido: use DDI + DDD + número, só dígitos (ex.: 5511999999999)."

  const usesDraft = whatsappTestUsesDraft(draft)
  let config: TestWhatsappRequest["config"]
  if (usesDraft) {
    for (const key of ["whatsapp.baseUrl", "whatsapp.instance"]) if (errors[key]) out[key] = errors[key]
    if (evolutionDestinationChanged(dto, draft) && dto.whatsapp.apiKeySet && !hasText(draft.apiKey)) out["whatsapp.apiKey"] = EVOLUTION_SECRET_AGAIN_MESSAGE
    if (!dto.secretsKeyConfigured && hasText(draft.apiKey)) out["whatsapp.apiKey"] = NO_SECRETS_KEY_MESSAGE
    config = {
      baseUrl: trimmed(draft.baseUrl) || dto.whatsapp.baseUrl || undefined,
      instance: trimmed(draft.instance) || dto.whatsapp.instance || undefined,
      apiVersion: draft.apiVersion ?? dto.whatsapp.apiVersion,
      ...(hasText(draft.apiKey) ? { apiKey: draft.apiKey } : {}),
    }
  }
  if (Object.keys(out).length > 0) return { errors: out }
  return { errors: out, request: { ...(to ? { to } : {}), ...(config ? { config } : {}) } }
}

/**
 * "Testar conexão" do SMTP (só conecta, negocia TLS e autentica — não envia e-mail). Usa o que está NA TELA: sem alteração no rascunho vale a config salva (`{}`); com
 * alteração, manda `config` com os valores EFETIVOS (rascunho sobre o salvo). A senha só vai se foi digitada; mudou servidor/usuário e há senha salva = digitar de novo.
 */
export function planSmtpConnectionTest(dto: CommunicationSettingsDTO, draft: EmailDraft, errors: DraftErrors): TestPlan<TestSmtpConnectionRequest> {
  const out: DraftErrors = {}
  const host = trimmed(draft.host) || dto.email.host || ""
  const portText = trimmed(draft.port)
  const port = portText ? Number(portText) : dto.email.port
  if (!host) out["email.host"] = "Informe o servidor SMTP para testar (mesmo que ainda não tenha salvo)."
  else if (errors["email.host"]) out["email.host"] = errors["email.host"]
  if (!port) out["email.port"] = "Informe a porta para testar (587 ou 465)."
  else if (errors["email.port"]) out["email.port"] = errors["email.port"]
  if (errors["email.user"]) out["email.user"] = errors["email.user"]
  if (smtpDestinationChanged(dto, draft) && dto.email.passwordSet && !hasText(draft.password)) out["email.password"] = SMTP_SECRET_AGAIN_MESSAGE
  if (!dto.secretsKeyConfigured && hasText(draft.password)) out["email.password"] = NO_SECRETS_KEY_MESSAGE
  if (Object.keys(out).length > 0) return { errors: out }
  if (!emailTestUsesDraft(draft)) return { errors: out, request: {} }
  return {
    errors: out,
    request: {
      config: {
        host,
        port: port ?? undefined,
        secure: draft.secure ?? dto.email.secure,
        user: draft.user !== undefined ? trimmed(draft.user) || null : dto.email.user,
        ...(hasText(draft.password) ? { password: draft.password } : {}),
      },
    },
  }
}

/** Etapas do teste de conexão, na ordem em que acontecem, com o nome que a tela mostra. */
export const SMTP_STAGES: ReadonlyArray<{ stage: Exclude<SmtpConnectionStage, "OK">; label: string }> = [
  { stage: "CONNECT", label: "Conexão" },
  { stage: "TLS", label: "TLS" },
  { stage: "AUTH", label: "Autenticação" },
]

export type StageState = "ok" | "failed" | "skipped"

/**
 * Estado de cada etapa a partir do resultado: sucesso = todas ok (menos a autenticação, "não testado", se o servidor foi usado sem login); falha na etapa X = anteriores ok, X falhou,
 * depois dela "não chegou a testar".
 */
export function smtpStageStates(result: { ok: boolean; stage: SmtpConnectionStage; authenticated?: boolean }): Array<{ stage: string; label: string; state: StageState }> {
  const found = SMTP_STAGES.findIndex((s) => s.stage === result.stage)
  const failedAt = result.ok ? -1 : found === -1 ? 0 : found
  return SMTP_STAGES.map((s, i): { stage: string; label: string; state: StageState } => {
    if (failedAt === -1) return { ...s, state: s.stage === "AUTH" && result.authenticated === false ? "skipped" : "ok" }
    return { ...s, state: i < failedAt ? "ok" : i === failedAt ? "failed" : "skipped" }
  })
}

/** Texto do RESULTADO do teste por `code` (o servidor também manda `message`, mas a tela usa o seu: o texto é nosso e não muda com o deploy do backend). */
export const TEST_ERROR_TEXT: Record<TestChannelErrorCode, { title: string; action: string }> = {
  DESTINATION_BLOCKED: {
    title: "Endereço interno não é permitido.",
    action: "Em produção o servidor não fala com rede interna. Use o endereço PÚBLICO do serviço.",
  },
  SMTP_AUTH_FAILED: { title: "O servidor de e-mail recusou o usuário ou a senha.", action: "Confira o usuário e a senha SMTP (alguns provedores pedem uma senha de aplicativo)." },
  SMTP_CONNECTION_FAILED: { title: "Não foi possível conectar ao servidor de e-mail.", action: "Confira o endereço, a porta e a opção de conexão segura (587 usa STARTTLS; 465 usa TLS direto)." },
  SMTP_TLS_REQUIRED: { title: "O servidor exige conexão segura.", action: "Troque a conexão segura (STARTTLS na 587, TLS direto na 465) e tente de novo." },
  SMTP_REJECTED: { title: "O servidor de e-mail recusou a mensagem.", action: "Confira o e-mail do remetente (alguns provedores só aceitam o do próprio usuário) e o destino do teste." },
  WHATSAPP_AUTH_FAILED: { title: "A Evolution API recusou a apikey.", action: "Confira a chave (a global ou a da instância)." },
  WHATSAPP_INSTANCE_OR_URL_NOT_FOUND: { title: "URL ou instância não encontrada na Evolution API.", action: "Confira a URL base e o nome da instância (e se ela está conectada ao WhatsApp)." },
  WHATSAPP_REJECTED: { title: "A Evolution API recusou o envio.", action: "Confira o número de destino (DDI + DDD + número) e a versão da API (1 ou 2)." },
  WHATSAPP_REDIRECT: { title: "A URL da Evolution API redireciona para outro endereço.", action: "Não seguimos redirecionamentos: informe a URL final (por exemplo, com https://)." },
  WHATSAPP_PROVIDER_ERROR: { title: "A Evolution API está com problema.", action: "Erro do lado do serviço (5xx). Tente de novo em instantes e confira o serviço." },
  TIMEOUT: { title: "O serviço demorou demais para responder.", action: "Confira se o endereço está certo e acessível pela internet; tente de novo." },
  NETWORK_ERROR: { title: "Não foi possível alcançar o serviço.", action: "Confira o endereço e a conectividade de saída do servidor." },
  INVALID_CONFIGURATION: { title: "A configuração está incompleta.", action: "Falta destinatário, servidor, remetente ou segredo (ou o segredo salvo não pôde ser lido). Complete e salve." },
}

export function testErrorText(code: string | undefined): { title: string; action: string } {
  if (code && code in TEST_ERROR_TEXT) return TEST_ERROR_TEXT[code as TestChannelErrorCode]
  return { title: "O teste falhou.", action: "Tente de novo; se persistir, confira a configuração do canal." }
}

// ---------------------------------------------------------------------------
// Erros HTTP (PUT e testes) por `code`
// ---------------------------------------------------------------------------

export const DESTINATION_REASON_TEXT: Record<string, string> = {
  LOOPBACK: "Endereço interno não é permitido em produção (é o próprio servidor). Use o endereço público do serviço.",
  REDE_PRIVADA: "Endereço interno não é permitido em produção (rede privada). Use o endereço público do serviço.",
  NOME_INTERNO: "Endereço interno não é permitido em produção (nome que só existe dentro da rede). Use o endereço público do serviço.",
  ENDERECO_DE_METADADOS: "Endereço interno não é permitido em produção (endereço reservado da nuvem). Use o endereço público do serviço.",
  ENDERECO_NAO_ROTEAVEL: "Endereço interno não é permitido em produção (não é alcançável pela internet). Use o endereço público do serviço.",
  HOST_INVALIDO: "Endereço inválido: informe só o nome ou IP do servidor, sem http://, porta ou caminho.",
  HTTPS_REQUIRED: "Em produção a URL precisa começar com https://.",
  INVALID_URL: "URL inválida. Informe a URL completa, por exemplo https://evolution.seudominio.com.br.",
}

const DESTINATION_FALLBACK = "Endereço interno não é permitido em produção. Use o endereço público do serviço."

/** Rótulo do campo do servidor (`details[].field` / `path`) para o texto do aviso. */
export const SERVER_FIELD_LABELS: Record<string, string> = {
  "email.host": "Servidor SMTP",
  "email.port": "Porta",
  "email.secure": "Conexão segura",
  "email.user": "Usuário SMTP",
  "email.password": "Senha SMTP",
  "email.fromName": "Remetente",
  "email.fromAddress": "Remetente",
  "email.recipients": "Destinatários de e-mail",
  "email.minSeverity": "Severidade mínima (e-mail)",
  "whatsapp.baseUrl": "URL da Evolution API",
  "whatsapp.instance": "Instância",
  "whatsapp.apiKey": "Apikey da Evolution",
  "whatsapp.apiVersion": "Versão da API",
  "whatsapp.recipients": "Números de WhatsApp",
  "whatsapp.minSeverity": "Severidade mínima (WhatsApp)",
  "alerts.dedupeMinutes": "Janela de repetição",
  "config.password": "Senha SMTP",
  "config.apiKey": "Apikey da Evolution",
  to: "Destino do teste",
}

/** `config.password` -> `email.password`, `config.apiKey` -> `whatsapp.apiKey`: o campo da tela que o erro aponta. */
function screenField(field: string): string {
  if (field === "config.password") return "email.password"
  if (field === "config.apiKey") return "whatsapp.apiKey"
  if (field === "email.fromName" || field === "email.fromAddress") return "email.from"
  return field
}

export interface CommunicationError {
  /** `code` do servidor (ou `undefined` sem resposta/sem código). */
  code: string | undefined
  status: number | undefined
  /** Texto pronto, escolhido por `code`. NUNCA o `error` do servidor. */
  message: string
  /** Campos da tela a que o erro aponta (`email.host`...), quando o servidor diz qual. */
  fields: string[]
  /** Pendências de `CHANNEL_INCOMPLETE` (`details[].problems`) — dado do servidor em PT-BR, sem segredo. */
  problems: Array<{ channel: Channel; problems: string[] }>
  /** O rascunho continua intacto e dá para tentar de novo (tudo, menos sessão expirada). */
  draftKept: boolean
  /** Segundos de `Retry-After`, se o servidor mandou. */
  retryAfterSeconds?: number
}

export const MSG_RATE_LIMITED_COMMUNICATION = "Muitas alterações ou testes em pouco tempo. Aguarde um minuto e tente de novo."
export const MSG_RATE_LIMITED_PASSWORD = "Muitas tentativas de senha. Aguarde alguns minutos e tente de novo."
export const MSG_STEPUP_UNAVAILABLE = "Não foi possível confirmar sua senha agora. Nada foi salvo. Tente de novo em instantes."
export const MSG_SECRETS_KEY_MISSING =
  "O servidor não tem a chave de cifragem dos segredos (PAYMENT_SECRETS_KEY), então não consegue guardar senha nem apikey — nada foi salvo. Peça para quem cuida do servidor criá-la no EasyPanel e reiniciar a API. Alterações que não envolvem segredos podem ser salvas normalmente."
export const MSG_UNAVAILABLE = "O servidor não conseguiu ler a configuração de comunicação (o banco pode estar fora do ar ou a chave dos segredos foi trocada). Nada foi alterado."
export const MSG_SESSION_EXPIRED = "Sua sessão expirou. Entre de novo para continuar — nada foi alterado."
export const MSG_WRONG_PASSWORD = "Senha incorreta."
export const MSG_FORBIDDEN = "Somente administradores podem ver e alterar a comunicação."
export const MSG_INTERNAL = "Não foi possível concluir e nada foi alterado. Tente novamente."
export const MSG_NETWORK = "Não foi possível falar com o servidor. Confira a conexão e tente de novo — nada foi alterado."

function readDetails(details: unknown): Array<Record<string, unknown>> {
  return Array.isArray(details) ? details.filter((d): d is Record<string, unknown> => !!d && typeof d === "object") : []
}

function incompleteMessage(problems: CommunicationError["problems"]): string {
  const names = problems.map((p) => CHANNEL_NAMES[p.channel])
  const who = names.length === 0 ? "o canal" : names.length === 1 ? `o canal de ${names[0]}` : `os canais de ${names.join(" e ")}`
  return `Não dá para ligar ${who}: a configuração está incompleta. Nada foi salvo — complete o que falta abaixo e salve de novo.`
}

/**
 * Traduz o erro do PUT, do GET ou dos testes (POST) para texto + campos + pendências, SEMPRE por `code` (na falta dele, por status). Nunca ecoa o corpo da
 * requisição (que carrega senha/apikey/senha atual) nem o `error` do servidor.
 */
export function parseCommunicationError(err: unknown): CommunicationError {
  const base = { code: undefined, status: undefined, fields: [] as string[], problems: [] as CommunicationError["problems"], draftKept: true }
  if (!axios.isAxiosError(err) || !err.response) return { ...base, message: MSG_NETWORK }

  const status = err.response.status
  const body = err.response.data as { code?: unknown; details?: unknown } | undefined
  const code = typeof body?.code === "string" ? body.code : undefined
  const details = readDetails(body?.details)
  const retryHeader = Number(err.response.headers?.["retry-after"])
  const retryAfterSeconds = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined
  const out = (message: string, extra: Partial<CommunicationError> = {}): CommunicationError => ({ ...base, code, status, message, retryAfterSeconds, ...extra })

  if (code === "UNAUTHORIZED" || (code === undefined && status === 401)) return out(MSG_SESSION_EXPIRED, { draftKept: false })

  switch (code) {
    case "INVALID_CURRENT_PASSWORD":
      return out(MSG_WRONG_PASSWORD)
    case "RATE_LIMITED_PAYMENT_GATEWAY":
      return out(MSG_RATE_LIMITED_PASSWORD)
    case "RATE_LIMITED_COMMUNICATION_SETTINGS":
    case "RATE_LIMITED":
      return out(MSG_RATE_LIMITED_COMMUNICATION)
    case "STEPUP_UNAVAILABLE":
      return out(MSG_STEPUP_UNAVAILABLE)
    case "SECRETS_KEY_MISSING":
      return out(MSG_SECRETS_KEY_MISSING)
    case "COMMUNICATION_SETTINGS_UNAVAILABLE":
      return out(MSG_UNAVAILABLE)
    case "FORBIDDEN":
      return out(MSG_FORBIDDEN)
    case "INTERNAL_ERROR":
      return out(MSG_INTERNAL)
    case "DESTINATION_NOT_ALLOWED": {
      const first = details[0]
      const reason = typeof first?.reason === "string" ? first.reason : undefined
      const field = typeof first?.field === "string" ? first.field : undefined
      return out((reason && DESTINATION_REASON_TEXT[reason]) || DESTINATION_FALLBACK, { fields: field ? [screenField(field)] : [] })
    }
    case "SECRET_REQUIRED_FOR_NEW_DESTINATION": {
      const fields = details.map((d) => (typeof d.field === "string" ? screenField(d.field) : "")).filter(Boolean)
      const smtp = fields.some((f) => f === "email.password")
      const evo = fields.some((f) => f === "whatsapp.apiKey")
      const message =
        smtp && !evo ? SMTP_SECRET_AGAIN_MESSAGE : evo && !smtp ? EVOLUTION_SECRET_AGAIN_MESSAGE : "Você mudou o destino de um canal: digite a senha SMTP e/ou a apikey de novo."
      return out(message, { fields })
    }
    case "CHANNEL_INCOMPLETE": {
      const problems = details
        .map((d) => ({ channel: d.channel === "whatsapp" ? ("whatsapp" as const) : ("email" as const), problems: Array.isArray(d.problems) ? d.problems.filter((p): p is string => typeof p === "string") : [] }))
      return out(incompleteMessage(problems), { problems })
    }
    case "VALIDATION_ERROR": {
      const fields = details.map((d) => (typeof d.path === "string" ? d.path : "")).filter(Boolean)
      const labels = [...new Set(fields.map((f) => SERVER_FIELD_LABELS[f]).filter(Boolean))]
      return out(`O servidor não aceitou algum valor${labels.length > 0 ? ` (${labels.join(", ")})` : ""}. Revise os campos e tente de novo.`, { fields: fields.filter((f) => f in SERVER_FIELD_LABELS).map(screenField) })
    }
    default:
      if (code === undefined && status === 429) return out(MSG_RATE_LIMITED_COMMUNICATION)
      if (status === 503) return out(MSG_UNAVAILABLE)
      return out(status >= 500 ? MSG_INTERNAL : "Não foi possível concluir a operação. Tente de novo em instantes.")
  }
}
