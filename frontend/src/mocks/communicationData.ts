import type {
  CommunicationSettingsDTO,
  DnsInstruction,
  DnsRecordCheck,
  DnsRecordStatus,
  DomainCheckResponse,
  NotificationSeverity,
  SmtpConnectionStage,
  TestChannelErrorCode,
  TestChannelResult,
  TestEmailRequest,
  TestSmtpConnectionResult,
  TestWhatsappRequest,
  UpdateCommunicationSettingsRequest,
} from "@/types/api"

/** Senha das contas de ADMIN do mock (a mesma de `mocks/data.ts`): o PUT confere `currentPassword` contra ela (step-up). */
const MOCK_ADMIN_PASSWORD = "senha1234"

/**
 * Espelho (no que a tela precisa provar) de `GET/PUT /api/admin/communication-settings` e dos dois `POST .../test-*` (N-7, `docs/CONTRATO-COMUNICACAO-ADMIN.md`).
 * NÃO é a regra de negócio da Vega: serve para exercitar o contrato no navegador. NADA aqui foi provado contra o backend real.
 *
 * Regras do contrato espelhadas:
 *  - SEGREDOS NUNCA SÃO GUARDADOS NEM DEVOLVIDOS: o mock só lembra `passwordSet`/`apiKeySet` e os 4 últimos caracteres da apikey (a dica);
 *  - campo ausente no PUT = não mexer; `strict` (campo desconhecido = 400); grupo vazio = 400; pelo menos um entre email/whatsapp/alerts/clearSecrets;
 *  - ordem dos erros do PUT: 400 validação -> step-up (400/403/429/503) -> negócio (400 DESTINATION_NOT_ALLOWED, 400 SECRET_REQUIRED_FOR_NEW_DESTINATION,
 *    409 CHANNEL_INCOMPLETE, 503 SECRETS_KEY_MISSING). Nada é gravado em nenhum erro;
 *  - a 1ª gravação de um grupo sem `enabled` nasce DESLIGADA; ligar exige canal completo (409 com `details: [{ channel, problems }]`);
 *  - trocar host/usuário SMTP ou URL/instância da Evolution com segredo salvo exige reenviar o segredo (também nos testes com `config`);
 *  - testes: SEMPRE 200 com `ok`; 5/min por ADMIN, compartilhado pelos dois canais; destinatário mascarado no resultado.
 *
 * CENÁRIOS por conta de ADMIN (estado por usuário, em memória da PÁGINA — um `page.goto` zera):
 *  - `admin@innoelektron.com`                      -> origem `env`: e-mail vindo do ambiente (ligado e funcionando), WhatsApp não configurado;
 *  - `comunicacao-pronta@innoelektron.com`         -> `database`: e-mail e WhatsApp ligados e funcionando, janela de 45 min salva;
 *  - `comunicacao-vazia@innoelektron.com`          -> `env`, NADA configurado nos dois canais;
 *  - `comunicacao-sem-chave@innoelektron.com`      -> `env`, nada configurado e servidor SEM `PAYMENT_SECRETS_KEY` (503 `SECRETS_KEY_MISSING` ao enviar segredo);
 *  - `comunicacao-ilegivel@innoelektron.com`       -> `database`, segredos salvos que NÃO decifram (`secretsDecryptable: false`; e-mail ligado e inativo; avisos);
 *  - `comunicacao-indisponivel@innoelektron.com`   -> o GET devolve 503 `COMMUNICATION_SETTINGS_UNAVAILABLE`;
 *  - `comunicacao-rede-privada@innoelektron.com`   -> como a "pronta", com `privateHostsAllowed: true` (destinos internos liberados pelo deploy).
 *
 * GATILHOS (valem para qualquer ADMIN; o PUT NÃO grava nada nestes casos):
 *  - host SMTP `limite.exemplo.com` -> 429 `RATE_LIMITED_COMMUNICATION_SETTINGS`; `indisponivel.exemplo.com` -> 503 `COMMUNICATION_SETTINGS_UNAVAILABLE`; `erro500.exemplo.com` -> 500;
 *  - senha atual `stepup-503` -> 503 `STEPUP_UNAVAILABLE`; `stepup-429` -> 429 `RATE_LIMITED_PAYMENT_GATEWAY` (com `Retry-After`); qualquer outra diferente de `senha1234` -> 403 `INVALID_CURRENT_PASSWORD`;
 *  - destino de rede interna (SSRF): `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `169.254.169.254`, nomes `*.local`/`*.internal`/sem ponto, ou URL `http://` -> 400 `DESTINATION_NOT_ALLOWED`;
 *  - testes: `localStorage["mock:comunicacao-teste"]` = um `TestChannelErrorCode` (a falha do resultado) ou `ok`; `HTTP_503` devolve 503 da rota;
 *  - TESTE DE CONEXÃO SMTP (`test-smtp-connection`; estágio por `code`: SMTP_CONNECTION_FAILED/TIMEOUT/NETWORK_ERROR -> CONNECT, SMTP_TLS_REQUIRED -> TLS, SMTP_AUTH_FAILED -> AUTH): host digitado
 *    `falha-conexao.exemplo.com`, `falha-tls.exemplo.com`, `falha-auth.exemplo.com`, `lento.exemplo.com` (TIMEOUT); o mesmo `localStorage["mock:comunicacao-teste"]` vale aqui; 5/min, mesmo balde dos testes;
 *  - VERIFICAÇÃO DE DOMÍNIO (`domain-check`, 6/min, domínio = o do remetente SALVO): `innoflow.example` (persona pronta): SPF ok, DMARC em atenção, DKIM só com seletor (`default` ok, `ausente`, `erro`);
 *    `todos-ok.exemplo.com` tudo ok; `spf-ausente.exemplo.com`; `dns-falha.exemplo.com` (tudo `ERRO`); `gmail.com` (aviso de domínio gratuito); sem remetente = nada consultado;
 *    `localStorage["mock:comunicacao-dominio"]` = `HTTP_503` devolve 503 da rota.
 */

type Source = "database" | "env" | "none"

interface EmailState {
  source: Source
  enabled: boolean
  host: string | null
  port: number | null
  secure: boolean
  user: string | null
  passwordSet: boolean
  fromName: string | null
  fromAddress: string | null
  recipients: string[]
  minSeverity: NotificationSeverity
}

interface WhatsappState {
  source: Source
  enabled: boolean
  baseUrl: string | null
  instance: string | null
  apiKeySet: boolean
  apiKeyHint: string | null
  apiVersion: 1 | 2
  recipients: string[]
  minSeverity: NotificationSeverity
}

interface Scenario {
  secretsKey: boolean
  /** `false` = segredos salvos que não decifram (chave trocada). */
  decryptable: boolean
  privateHostsAllowed: boolean
  hasDatabaseRow: boolean
  email: EmailState
  whatsapp: WhatsappState
  dedupeMinutes: number
  dedupeSource: "database" | "env"
  updatedAt: string | null
}

const EMPTY_EMAIL: EmailState = {
  source: "none",
  enabled: false,
  host: null,
  port: null,
  secure: false,
  user: null,
  passwordSet: false,
  fromName: null,
  fromAddress: null,
  recipients: [],
  minSeverity: "IMPORTANTE",
}

const EMPTY_WHATSAPP: WhatsappState = {
  source: "none",
  enabled: false,
  baseUrl: null,
  instance: null,
  apiKeySet: false,
  apiKeyHint: null,
  apiVersion: 2,
  recipients: [],
  minSeverity: "CRITICO",
}

const ENV_EMAIL: EmailState = {
  source: "env",
  enabled: true,
  host: "smtp.env.exemplo.com.br",
  port: 587,
  secure: false,
  user: "alertas@exemplo.com.br",
  passwordSet: true,
  fromName: "InnoFlow",
  fromAddress: "alertas@exemplo.com.br",
  recipients: ["dono@exemplo.com.br"],
  minSeverity: "IMPORTANTE",
}

const DB_EMAIL: EmailState = {
  source: "database",
  enabled: true,
  host: "smtp.innoflow.example",
  port: 587,
  secure: false,
  user: "alertas@innoflow.example",
  passwordSet: true,
  fromName: "InnoFlow",
  fromAddress: "alertas@innoflow.example",
  recipients: ["dono@innoflow.example", "financeiro@innoflow.example"],
  minSeverity: "IMPORTANTE",
}

const DB_WHATSAPP: WhatsappState = {
  source: "database",
  enabled: true,
  baseUrl: "https://evolution.innoflow.example",
  instance: "innoflow",
  apiKeySet: true,
  apiKeyHint: "a1b2",
  apiVersion: 2,
  recipients: ["5511999999999"],
  minSeverity: "CRITICO",
}

const BASE: Scenario = {
  secretsKey: true,
  decryptable: true,
  privateHostsAllowed: false,
  hasDatabaseRow: false,
  email: { ...EMPTY_EMAIL },
  whatsapp: { ...EMPTY_WHATSAPP },
  dedupeMinutes: 30,
  dedupeSource: "env",
  updatedAt: null,
}

function seed(userId: string): Scenario {
  switch (userId) {
    case "user_admin_comunicacao_pronta":
    case "user_admin_comunicacao_indisponivel":
      return { ...BASE, hasDatabaseRow: true, email: { ...DB_EMAIL }, whatsapp: { ...DB_WHATSAPP }, dedupeMinutes: 45, dedupeSource: "database", updatedAt: "2026-10-04T13:20:00.000Z" }
    case "user_admin_comunicacao_rede_privada":
      return { ...BASE, privateHostsAllowed: true, hasDatabaseRow: true, email: { ...DB_EMAIL }, whatsapp: { ...DB_WHATSAPP }, dedupeMinutes: 45, dedupeSource: "database", updatedAt: "2026-10-04T13:20:00.000Z" }
    case "user_admin_comunicacao_ilegivel":
      return { ...BASE, decryptable: false, hasDatabaseRow: true, email: { ...DB_EMAIL }, whatsapp: { ...DB_WHATSAPP }, updatedAt: "2026-10-03T10:05:00.000Z" }
    case "user_admin_comunicacao_sem_chave":
      return { ...BASE, secretsKey: false }
    case "user_admin_comunicacao_vazia":
      return { ...BASE }
    default:
      // `admin@`: e-mail vindo do ambiente, WhatsApp sem configuração.
      return { ...BASE, email: { ...ENV_EMAIL } }
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

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

function emailProblems(e: EmailState): string[] {
  const out: string[] = []
  if (!e.host) out.push("Informe o servidor SMTP.")
  if (!e.fromAddress) out.push("Informe o e-mail do remetente.")
  // Destinatários de alerta são OPCIONAIS desde a L1.6 (contrato, regra 4): sem eles o canal fica ativo só para o e-mail ao motorista e `warnings` avisa.
  return out
}

function whatsappProblems(w: WhatsappState): string[] {
  const out: string[] = []
  if (!w.baseUrl) out.push("Informe a URL da Evolution API.")
  if (!w.instance) out.push("Informe o nome da instância.")
  if (!w.apiKeySet) out.push("Informe a apikey da Evolution.")
  if (w.recipients.length === 0) out.push("Informe ao menos um número de destino.")
  return out
}

function toDto(s: Scenario): CommunicationSettingsDTO {
  const emailOk = s.email.enabled && emailProblems(s.email).length === 0 && (s.decryptable || !s.email.passwordSet)
  const whatsappOk = s.whatsapp.enabled && whatsappProblems(s.whatsapp).length === 0 && s.decryptable
  const warnings: string[] = []
  if (s.email.enabled && s.email.source === "database" && s.email.recipients.length === 0) warnings.push("E-mail ligado, mas sem destinatário de alerta: só os e-mails ao motorista são enviados; os avisos ao dono por e-mail não.")
  if (s.email.enabled && !emailOk && s.email.recipients.length > 0 && !s.decryptable) warnings.push("E-mail ligado, mas a senha SMTP salva não pode ser lida: salve a senha de novo.")
  if (s.whatsapp.enabled && !whatsappOk && !s.decryptable) warnings.push("WhatsApp ligado, mas a apikey salva não pode ser lida: salve a apikey de novo.")
  return {
    source: s.hasDatabaseRow ? "database" : "env",
    email: { ...s.email, active: emailOk, recipients: [...s.email.recipients] },
    whatsapp: { ...s.whatsapp, active: whatsappOk, provider: s.whatsapp.source === "none" ? null : "evolution", recipients: [...s.whatsapp.recipients] },
    alerts: { dedupeMinutes: s.dedupeMinutes, dedupeSource: s.dedupeSource, globalMinSeverity: "INFO", maxPerHour: 20 },
    secretsKeyConfigured: s.secretsKey,
    secretsDecryptable: s.hasDatabaseRow && (s.email.passwordSet || s.whatsapp.apiKeySet) ? s.decryptable : null,
    privateHostsAllowed: s.privateHostsAllowed,
    warnings,
    updatedAt: s.updatedAt,
  }
}

export type CommunicationStatus = 400 | 403 | 409 | 429 | 500 | 503
export type CommunicationFailure = { ok: false; status: CommunicationStatus; code: string; message: string; details?: unknown; headers?: Record<string, string> }
export type CommunicationGetResult = { ok: true; dto: CommunicationSettingsDTO } | CommunicationFailure

const fail = (status: CommunicationStatus, code: string, message: string, details?: unknown, headers?: Record<string, string>): CommunicationFailure => ({ ok: false, status, code, message, details, headers })

export function getCommunicationSettings(userId: string): CommunicationGetResult {
  if (userId === "user_admin_comunicacao_indisponivel") return fail(503, "COMMUNICATION_SETTINGS_UNAVAILABLE", "Não foi possível ler a configuração de comunicação.")
  return { ok: true, dto: toDto(scenarioFor(userId)) }
}

// ---------------------------------------------------------------------------
// Destino proibido (SSRF)
// ---------------------------------------------------------------------------

type DestinationReason = "LOOPBACK" | "REDE_PRIVADA" | "NOME_INTERNO" | "ENDERECO_DE_METADADOS" | "ENDERECO_NAO_ROTEAVEL" | "HOST_INVALIDO" | "HTTPS_REQUIRED" | "INVALID_URL"

function hostReason(rawHost: string): DestinationReason | null {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "LOOPBACK"
  if (host === "169.254.169.254") return "ENDERECO_DE_METADADOS"
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "REDE_PRIVADA"
  if (/^0\./.test(host)) return "ENDERECO_NAO_ROTEAVEL"
  if (/\.(local|internal|lan|intranet)$/.test(host) || (!host.includes(".") && !host.includes(":"))) return "NOME_INTERNO"
  return null
}

function smtpHostReason(host: string, privateAllowed: boolean): DestinationReason | null {
  if (privateAllowed) return null
  return hostReason(host)
}

function baseUrlReason(value: string, privateAllowed: boolean): DestinationReason | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "INVALID_URL"
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "INVALID_URL"
  if (privateAllowed) return null
  const byHost = hostReason(url.hostname)
  if (byHost) return byHost
  return url.protocol === "http:" ? "HTTPS_REQUIRED" : null
}

const destinationFail = (field: "email.host" | "whatsapp.baseUrl", reason: DestinationReason) => fail(400, "DESTINATION_NOT_ALLOWED", "Destino não permitido.", [{ field, reason }])

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------

const SEVERITIES: ReadonlySet<string> = new Set(["INFO", "IMPORTANTE", "CRITICO"])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isString = (v: unknown, max = 500): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max

const EMAIL_KEYS = ["enabled", "host", "port", "secure", "user", "password", "fromName", "fromAddress", "recipients", "minSeverity"]
const WHATSAPP_KEYS = ["enabled", "baseUrl", "instance", "apiKey", "apiVersion", "recipients", "minSeverity"]

function validationFail(path: string, message: string): CommunicationFailure {
  return fail(400, "VALIDATION_ERROR", `${path}: ${message}`, [{ path, message }])
}

function validatePut(input: Record<string, unknown>): CommunicationFailure | null {
  const known = new Set(["email", "whatsapp", "alerts", "clearSecrets", "currentPassword"])
  for (const key of Object.keys(input)) if (!known.has(key)) return validationFail(key, "campo desconhecido.")
  if (!("email" in input) && !("whatsapp" in input) && !("alerts" in input) && !("clearSecrets" in input)) return validationFail("body", "informe ao menos um entre email, whatsapp, alerts ou clearSecrets.")

  if (input.email !== undefined) {
    if (!isObject(input.email) || Object.keys(input.email).length === 0) return validationFail("email", "grupo vazio ou inválido.")
    const e = input.email
    for (const key of Object.keys(e)) if (!EMAIL_KEYS.includes(key)) return validationFail(`email.${key}`, "campo desconhecido.")
    if (e.enabled !== undefined && typeof e.enabled !== "boolean") return validationFail("email.enabled", "deve ser booleano.")
    if (e.host !== undefined && (!isString(e.host, 253) || /\s|\/|:\/\//.test(e.host))) return validationFail("email.host", "informe só o endereço.")
    if (e.port !== undefined && (typeof e.port !== "number" || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535)) return validationFail("email.port", "porta de 1 a 65535.")
    if (e.secure !== undefined && typeof e.secure !== "boolean") return validationFail("email.secure", "deve ser booleano.")
    if (e.user !== undefined && e.user !== null && !isString(e.user, 254)) return validationFail("email.user", "inválido.")
    if (e.password !== undefined && !isString(e.password, 500)) return validationFail("email.password", "inválida.")
    if (e.fromName !== undefined && e.fromName !== null && !isString(e.fromName, 80)) return validationFail("email.fromName", "até 80 caracteres.")
    if (e.fromAddress !== undefined && (typeof e.fromAddress !== "string" || !EMAIL_RE.test(e.fromAddress))) return validationFail("email.fromAddress", "e-mail inválido.")
    if (e.recipients !== undefined && (!Array.isArray(e.recipients) || e.recipients.length > 10 || e.recipients.some((r) => typeof r !== "string" || !EMAIL_RE.test(r)))) return validationFail("email.recipients", "até 10 e-mails válidos.")
    if (e.minSeverity !== undefined && !SEVERITIES.has(String(e.minSeverity))) return validationFail("email.minSeverity", "severidade inválida.")
  }
  if (input.whatsapp !== undefined) {
    if (!isObject(input.whatsapp) || Object.keys(input.whatsapp).length === 0) return validationFail("whatsapp", "grupo vazio ou inválido.")
    const w = input.whatsapp
    for (const key of Object.keys(w)) if (!WHATSAPP_KEYS.includes(key)) return validationFail(`whatsapp.${key}`, "campo desconhecido.")
    if (w.enabled !== undefined && typeof w.enabled !== "boolean") return validationFail("whatsapp.enabled", "deve ser booleano.")
    if (w.baseUrl !== undefined && !isString(w.baseUrl, 500)) return validationFail("whatsapp.baseUrl", "inválida.")
    if (w.instance !== undefined && (!isString(w.instance, 100) || !/^[A-Za-z0-9._-]+$/.test(w.instance))) return validationFail("whatsapp.instance", "só letras, números, ponto, hífen e sublinhado.")
    if (w.apiKey !== undefined && !isString(w.apiKey, 500)) return validationFail("whatsapp.apiKey", "inválida.")
    if (w.apiVersion !== undefined && w.apiVersion !== 1 && w.apiVersion !== 2) return validationFail("whatsapp.apiVersion", "deve ser 1 ou 2.")
    if (w.recipients !== undefined && (!Array.isArray(w.recipients) || w.recipients.length > 10 || w.recipients.some((r) => typeof r !== "string" || !/^\d{10,15}$/.test(r.replace(/\D/g, ""))))) {
      return validationFail("whatsapp.recipients", "até 10 números válidos.")
    }
    if (w.minSeverity !== undefined && !SEVERITIES.has(String(w.minSeverity))) return validationFail("whatsapp.minSeverity", "severidade inválida.")
  }
  if (input.alerts !== undefined) {
    if (!isObject(input.alerts) || Object.keys(input.alerts).length === 0) return validationFail("alerts", "grupo vazio ou inválido.")
    const d = input.alerts.dedupeMinutes
    if (d !== undefined && d !== null && (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 1440)) return validationFail("alerts.dedupeMinutes", "de 1 a 1440.")
  }
  if (input.clearSecrets !== undefined && (!Array.isArray(input.clearSecrets) || input.clearSecrets.some((s) => s !== "smtpPassword" && s !== "evolutionApiKey"))) {
    return validationFail("clearSecrets", "valor inválido.")
  }
  if (input.currentPassword === undefined) return validationFail("currentPassword", "obrigatório.")
  if (typeof input.currentPassword !== "string" || input.currentPassword.length < 1 || input.currentPassword.length > 200) return validationFail("currentPassword", "de 1 a 200 caracteres.")
  return null
}

export type CommunicationUpdateResult = { ok: true; dto: CommunicationSettingsDTO } | CommunicationFailure

/** Aplica um PUT. Valida tudo ANTES de mexer no estado (um 4xx/5xx nunca deixa meia alteração). Nunca guarda valor de segredo (só `...Set` e os 4 últimos da apikey). */
export function updateCommunicationSettings(userId: string, body: unknown): CommunicationUpdateResult {
  const scenario = scenarioFor(userId)
  const input = (isObject(body) ? body : {}) as UpdateCommunicationSettingsRequest & Record<string, unknown>
  const emailIn = isObject(input.email) ? (input.email as NonNullable<UpdateCommunicationSettingsRequest["email"]>) : undefined
  const whatsappIn = isObject(input.whatsapp) ? (input.whatsapp as NonNullable<UpdateCommunicationSettingsRequest["whatsapp"]>) : undefined

  // ---- falhas determinísticas por gatilho (limite por minuto / banco / interno) ----
  const triggerHost = typeof emailIn?.host === "string" ? emailIn.host.trim().toLowerCase() : ""
  if (triggerHost === "limite.exemplo.com") return fail(429, "RATE_LIMITED_COMMUNICATION_SETTINGS", "Muitas alterações. Aguarde um minuto.", undefined, { "retry-after": "60" })
  if (triggerHost === "indisponivel.exemplo.com") return fail(503, "COMMUNICATION_SETTINGS_UNAVAILABLE", "Configuração ilegível no servidor.")
  if (triggerHost === "erro500.exemplo.com") return fail(500, "INTERNAL_ERROR", "Erro interno.")

  // ---- 400 validação ----
  const invalid = validatePut(input)
  if (invalid) return invalid

  // ---- step-up de senha (a senha nunca é guardada nem ecoada) ----
  if (input.currentPassword === "stepup-503") return fail(503, "STEPUP_UNAVAILABLE", "Não foi possível conferir a senha agora.")
  if (input.currentPassword === "stepup-429") return fail(429, "RATE_LIMITED_PAYMENT_GATEWAY", "Muitas tentativas de senha.", undefined, { "retry-after": "300" })
  if (input.currentPassword !== MOCK_ADMIN_PASSWORD) return fail(403, "INVALID_CURRENT_PASSWORD", "Senha atual incorreta.")

  const clear = new Set(input.clearSecrets ?? [])
  const allowPrivate = scenario.privateHostsAllowed

  // ---- 400 destino proibido ----
  if (emailIn?.host !== undefined) {
    const reason = smtpHostReason(emailIn.host.trim(), allowPrivate)
    if (reason) return destinationFail("email.host", reason)
  }
  if (whatsappIn?.baseUrl !== undefined) {
    const reason = baseUrlReason(whatsappIn.baseUrl.trim(), allowPrivate)
    if (reason) return destinationFail("whatsapp.baseUrl", reason)
  }

  // ---- 400 trocar o destino de um segredo salvo exige reenviar o segredo ----
  if (emailIn && scenario.email.passwordSet && emailIn.password === undefined && !clear.has("smtpPassword")) {
    const hostChanged = emailIn.host !== undefined && emailIn.host.trim() !== (scenario.email.host ?? "")
    const userChanged = emailIn.user !== undefined && (emailIn.user ?? null) !== scenario.email.user
    if (hostChanged || userChanged) return fail(400, "SECRET_REQUIRED_FOR_NEW_DESTINATION", "Reenvie a senha.", [{ field: "email.password" }])
  }
  if (whatsappIn && scenario.whatsapp.apiKeySet && whatsappIn.apiKey === undefined && !clear.has("evolutionApiKey")) {
    const urlChanged = whatsappIn.baseUrl !== undefined && whatsappIn.baseUrl.trim() !== (scenario.whatsapp.baseUrl ?? "")
    const instanceChanged = whatsappIn.instance !== undefined && whatsappIn.instance.trim() !== (scenario.whatsapp.instance ?? "")
    if (urlChanged || instanceChanged) return fail(400, "SECRET_REQUIRED_FOR_NEW_DESTINATION", "Reenvie a apikey.", [{ field: "whatsapp.apiKey" }])
  }

  // ---- estado candidato (ainda não gravado) ----
  const email: EmailState = { ...scenario.email, recipients: [...scenario.email.recipients] }
  if (emailIn) {
    if (emailIn.host !== undefined) email.host = emailIn.host.trim()
    if (emailIn.port !== undefined) email.port = emailIn.port
    if (emailIn.secure !== undefined) email.secure = emailIn.secure
    if (emailIn.user !== undefined) email.user = emailIn.user === null ? null : emailIn.user.trim()
    if (emailIn.password !== undefined) email.passwordSet = true
    if (emailIn.fromName !== undefined) email.fromName = emailIn.fromName === null ? null : emailIn.fromName.trim()
    if (emailIn.fromAddress !== undefined) email.fromAddress = emailIn.fromAddress.trim()
    if (emailIn.recipients !== undefined) email.recipients = emailIn.recipients.map((r) => r.trim())
    if (emailIn.minSeverity !== undefined) email.minSeverity = emailIn.minSeverity
    // 1ª gravação do grupo sem `enabled`: nasce DESLIGADA.
    email.enabled = emailIn.enabled ?? (scenario.email.source === "database" ? scenario.email.enabled : false)
    email.source = "database"
  }
  const whatsapp: WhatsappState = { ...scenario.whatsapp, recipients: [...scenario.whatsapp.recipients] }
  if (whatsappIn) {
    if (whatsappIn.baseUrl !== undefined) whatsapp.baseUrl = whatsappIn.baseUrl.trim()
    if (whatsappIn.instance !== undefined) whatsapp.instance = whatsappIn.instance.trim()
    if (whatsappIn.apiKey !== undefined) {
      whatsapp.apiKeySet = true
      whatsapp.apiKeyHint = whatsappIn.apiKey.slice(-4)
    }
    if (whatsappIn.apiVersion !== undefined) whatsapp.apiVersion = whatsappIn.apiVersion
    if (whatsappIn.recipients !== undefined) whatsapp.recipients = whatsappIn.recipients.map((r) => r.replace(/\D/g, ""))
    if (whatsappIn.minSeverity !== undefined) whatsapp.minSeverity = whatsappIn.minSeverity
    whatsapp.enabled = whatsappIn.enabled ?? (scenario.whatsapp.source === "database" ? scenario.whatsapp.enabled : false)
    whatsapp.source = "database"
  }
  if (clear.has("smtpPassword")) email.passwordSet = false
  if (clear.has("evolutionApiKey")) {
    whatsapp.apiKeySet = false
    whatsapp.apiKeyHint = null
  }

  // ---- 409 ligar um canal incompleto ----
  const incomplete: Array<{ channel: "email" | "whatsapp"; problems: string[] }> = []
  if (emailIn?.enabled === true) {
    const problems = emailProblems(email)
    if (problems.length > 0) incomplete.push({ channel: "email", problems })
  }
  if (whatsappIn?.enabled === true) {
    const problems = whatsappProblems(whatsapp)
    if (problems.length > 0) incomplete.push({ channel: "whatsapp", problems })
  }
  if (incomplete.length > 0) return fail(409, "CHANNEL_INCOMPLETE", "Canal incompleto.", incomplete)

  // ---- 503 sem chave de cifragem para guardar segredo ----
  if ((emailIn?.password !== undefined || whatsappIn?.apiKey !== undefined) && !scenario.secretsKey) {
    return fail(503, "SECRETS_KEY_MISSING", "O servidor não está configurado para guardar segredos.")
  }

  // Reenviar (ou apagar) todos os segredos salvos restabelece a leitura.
  const emailFixed = !scenario.email.passwordSet || emailIn?.password !== undefined || clear.has("smtpPassword")
  const whatsappFixed = !scenario.whatsapp.apiKeySet || whatsappIn?.apiKey !== undefined || clear.has("evolutionApiKey")
  scenario.email = email
  scenario.whatsapp = whatsapp
  scenario.decryptable = scenario.decryptable || (emailFixed && whatsappFixed)
  if (input.alerts?.dedupeMinutes !== undefined) {
    scenario.dedupeMinutes = input.alerts.dedupeMinutes === null ? 30 : input.alerts.dedupeMinutes
    scenario.dedupeSource = input.alerts.dedupeMinutes === null ? "env" : "database"
  }
  scenario.hasDatabaseRow = true
  scenario.updatedAt = new Date().toISOString()
  return { ok: true, dto: toDto(scenario) }
}

// ---------------------------------------------------------------------------
// POST test-email / test-whatsapp
// ---------------------------------------------------------------------------

const TEST_LIMIT_PER_MINUTE = 5
const callsByUser = new Map<string, number[]>()

export type CommunicationTestOutcome = { status: 200; body: TestChannelResult } | { status: CommunicationStatus; body: { error: string; code: string; details?: unknown }; headers?: Record<string, string> }

function maskEmail(address: string): string {
  const [local, domain] = address.split("@")
  return `${(local ?? "")[0] ?? "*"}***@${domain ?? ""}`
}
function maskPhone(digits: string): string {
  return digits.length <= 8 ? "*".repeat(digits.length) : `${digits.slice(0, 4)}${"*".repeat(digits.length - 8)}${digits.slice(-4)}`
}

const TEST_CODES: ReadonlySet<string> = new Set<TestChannelErrorCode>([
  "DESTINATION_BLOCKED",
  "SMTP_AUTH_FAILED",
  "SMTP_CONNECTION_FAILED",
  "SMTP_TLS_REQUIRED",
  "SMTP_REJECTED",
  "WHATSAPP_AUTH_FAILED",
  "WHATSAPP_INSTANCE_OR_URL_NOT_FOUND",
  "WHATSAPP_REJECTED",
  "WHATSAPP_REDIRECT",
  "WHATSAPP_PROVIDER_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
  "INVALID_CONFIGURATION",
])

function testResult(channel: "email" | "whatsapp", to: string | null, code: string | null): CommunicationTestOutcome {
  const ok = code === null
  return {
    status: 200,
    body: {
      channel,
      ok,
      testedAt: new Date().toISOString(),
      durationMs: ok ? 312 : 1840,
      to,
      error: ok ? null : { code: code as TestChannelErrorCode, message: `mock: ${code}` },
    },
  }
}

export function testCommunicationChannel(userId: string, channel: "email" | "whatsapp", body: unknown, override: string | null): CommunicationTestOutcome {
  const scenario = scenarioFor(userId)
  if (userId === "user_admin_comunicacao_indisponivel" || override === "HTTP_503") {
    return { status: 503, body: { error: "Não foi possível ler a configuração.", code: "COMMUNICATION_SETTINGS_UNAVAILABLE" } }
  }
  const now = Date.now()
  const recent = (callsByUser.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= TEST_LIMIT_PER_MINUTE) {
    callsByUser.set(userId, recent)
    return { status: 429, body: { error: "Muitos testes.", code: "RATE_LIMITED_COMMUNICATION_SETTINGS" }, headers: { "retry-after": "60" } }
  }
  callsByUser.set(userId, [...recent, now])

  const input = (isObject(body) ? body : {}) as TestEmailRequest & TestWhatsappRequest
  const config = isObject(input.config) ? (input.config as Record<string, unknown>) : undefined
  const to = typeof input.to === "string" ? input.to.trim() : ""

  if (channel === "email") {
    if (to && !EMAIL_RE.test(to)) return { status: 400, body: { error: "to inválido", code: "VALIDATION_ERROR", details: [{ path: "to", message: "e-mail inválido" }] } }
    const host = typeof config?.host === "string" ? config.host.trim() : null
    if (host) {
      const reason = smtpHostReason(host, scenario.privateHostsAllowed)
      if (reason) return { status: 400, body: { error: "Destino não permitido.", code: "DESTINATION_NOT_ALLOWED", details: [{ field: "email.host", reason }] } }
      const changed = host !== (scenario.email.host ?? "") || (config && "user" in config && (config.user ?? null) !== scenario.email.user)
      if (changed && scenario.email.passwordSet && config?.password === undefined) {
        return { status: 400, body: { error: "Reenvie a senha.", code: "SECRET_REQUIRED_FOR_NEW_DESTINATION", details: [{ field: "config.password" }] } }
      }
    }
    const target = to || scenario.email.recipients[0] || null
    const configured = Boolean(config?.host ?? scenario.email.host) && Boolean(config?.fromAddress ?? scenario.email.fromAddress)
    if (!target || !configured || (!scenario.decryptable && config?.password === undefined)) return testResult("email", target ? maskEmail(target) : null, "INVALID_CONFIGURATION")
    return testResult("email", maskEmail(target), override && TEST_CODES.has(override) ? override : null)
  }

  const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl.trim() : null
  if (baseUrl) {
    const reason = baseUrlReason(baseUrl, scenario.privateHostsAllowed)
    if (reason) return { status: 400, body: { error: "Destino não permitido.", code: "DESTINATION_NOT_ALLOWED", details: [{ field: "whatsapp.baseUrl", reason }] } }
  }
  const instance = typeof config?.instance === "string" ? config.instance.trim() : null
  if ((baseUrl && baseUrl !== (scenario.whatsapp.baseUrl ?? "")) || (instance && instance !== (scenario.whatsapp.instance ?? ""))) {
    if (scenario.whatsapp.apiKeySet && config?.apiKey === undefined) {
      return { status: 400, body: { error: "Reenvie a apikey.", code: "SECRET_REQUIRED_FOR_NEW_DESTINATION", details: [{ field: "config.apiKey" }] } }
    }
  }
  const digits = to.replace(/\D/g, "")
  if (to && !/^\d{10,15}$/.test(digits)) return { status: 400, body: { error: "to inválido", code: "VALIDATION_ERROR", details: [{ path: "to", message: "número inválido" }] } }
  const target = digits || scenario.whatsapp.recipients[0] || null
  const configured = Boolean(config?.baseUrl ?? scenario.whatsapp.baseUrl) && Boolean(config?.instance ?? scenario.whatsapp.instance) && (scenario.whatsapp.apiKeySet || config?.apiKey !== undefined)
  if (!target || !configured || (!scenario.decryptable && config?.apiKey === undefined)) return testResult("whatsapp", target ? maskPhone(target) : null, "INVALID_CONFIGURATION")
  return testResult("whatsapp", maskPhone(target), override && TEST_CODES.has(override) ? override : null)
}

// ---------------------------------------------------------------------------
// POST test-smtp-connection (só handshake: conectar, TLS, autenticar)
// ---------------------------------------------------------------------------

const STAGE_BY_CODE: Partial<Record<TestChannelErrorCode, SmtpConnectionStage>> = { SMTP_AUTH_FAILED: "AUTH", SMTP_TLS_REQUIRED: "TLS" }
const stageOf = (code: TestChannelErrorCode): SmtpConnectionStage => STAGE_BY_CODE[code] ?? "CONNECT"

const HOST_FAILURES: Record<string, TestChannelErrorCode> = {
  "falha-conexao.exemplo.com": "SMTP_CONNECTION_FAILED",
  "falha-tls.exemplo.com": "SMTP_TLS_REQUIRED",
  "falha-auth.exemplo.com": "SMTP_AUTH_FAILED",
  "lento.exemplo.com": "TIMEOUT",
}

export type SmtpConnectionOutcome = { status: 200; body: TestSmtpConnectionResult } | { status: CommunicationStatus; body: { error: string; code: string; details?: unknown }; headers?: Record<string, string> }

/** Divide o balde de 5/min com os outros testes (mesmo `callsByUser`). `null` = passou; senão, a resposta 429/503. */
function testBucket(userId: string, override: string | null): SmtpConnectionOutcome | null {
  if (userId === "user_admin_comunicacao_indisponivel" || override === "HTTP_503") {
    return { status: 503, body: { error: "Não foi possível ler a configuração.", code: "COMMUNICATION_SETTINGS_UNAVAILABLE" } }
  }
  const now = Date.now()
  const recent = (callsByUser.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= TEST_LIMIT_PER_MINUTE) {
    callsByUser.set(userId, recent)
    return { status: 429, body: { error: "Muitos testes.", code: "RATE_LIMITED_COMMUNICATION_SETTINGS" }, headers: { "retry-after": "60" } }
  }
  callsByUser.set(userId, [...recent, now])
  return null
}

export function testSmtpConnection(userId: string, body: unknown, override: string | null): SmtpConnectionOutcome {
  const scenario = scenarioFor(userId)
  const blocked = testBucket(userId, override)
  if (blocked) return blocked

  const input = (isObject(body) ? body : {}) as { config?: unknown }
  const config = isObject(input.config) ? (input.config as Record<string, unknown>) : undefined
  const host = (typeof config?.host === "string" ? config.host.trim() : (scenario.email.host ?? "")).toLowerCase()
  const reply = (ok: boolean, code: TestChannelErrorCode | null, authenticated: boolean): SmtpConnectionOutcome => ({
    status: 200,
    body: { ok, stage: code ? stageOf(code) : "OK", code, message: ok ? null : `mock: ${code}`, authenticated, testedAt: new Date().toISOString(), durationMs: ok ? 187 : 2210 },
  })

  if (typeof config?.host === "string" && config.host.trim()) {
    // Contrato (rota 9): destino interno é RESULTADO do teste (200, `DESTINATION_BLOCKED`, etapa CONNECT), não erro da rota; a 400 é só `SECRET_REQUIRED_FOR_NEW_DESTINATION`.
    if (smtpHostReason(host, scenario.privateHostsAllowed)) return reply(false, "DESTINATION_BLOCKED", false)
    const changed = host !== (scenario.email.host ?? "").toLowerCase() || (config && "user" in config && (config.user ?? null) !== scenario.email.user)
    if (changed && scenario.email.passwordSet && config?.password === undefined) {
      return { status: 400, body: { error: "Reenvie a senha.", code: "SECRET_REQUIRED_FOR_NEW_DESTINATION", details: [{ field: "config.password" }] } }
    }
  }
  if (!host) return reply(false, "INVALID_CONFIGURATION", false)
  if (!scenario.decryptable && config?.password === undefined) return reply(false, "INVALID_CONFIGURATION", false)

  const user = config && "user" in config ? config.user : scenario.email.user
  const hasPassword = config?.password !== undefined || scenario.email.passwordSet
  const authenticated = Boolean(user) && hasPassword
  const failure = HOST_FAILURES[host] ?? (override && TEST_CODES.has(override) ? (override as TestChannelErrorCode) : null)
  return reply(failure === null, failure, authenticated)
}

// ---------------------------------------------------------------------------
// GET domain-check (SPF / DKIM / DMARC do domínio do remetente SALVO)
// ---------------------------------------------------------------------------

const DOMAIN_LIMIT_PER_MINUTE = 6
const domainCallsByUser = new Map<string, number[]>()
const SELECTOR_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

export type DomainCheckOutcome = { status: 200; body: DomainCheckResponse } | { status: CommunicationStatus; body: { error: string; code: string; details?: unknown }; headers?: Record<string, string> }

const rec = (status: DnsRecordStatus, nomeConsultado: string | null, valorEncontrado: string | null, recomendacao: string): DnsRecordCheck => ({ status, nomeConsultado, valorEncontrado, recomendacao })

function spfFor(domain: string): DnsRecordCheck {
  if (domain === "dns-falha.exemplo.com") return rec("ERRO", domain, null, "Não deu para consultar o SPF agora (o servidor de DNS não respondeu a tempo). Tente de novo em instantes.")
  if (domain === "spf-ausente.exemplo.com" || domain === "gmail.com") return rec("AUSENTE", domain, null, "Não encontramos um registro SPF. Peça ao provedor do seu servidor de e-mail o registro correto e cadastre-o no DNS do domínio.")
  return rec("OK", domain, "v=spf1 include:_spf.innoflow.example ~all", "O SPF está configurado e autoriza o seu provedor de e-mail.")
}

function dmarcFor(domain: string): DnsRecordCheck {
  const name = `_dmarc.${domain}`
  if (domain === "dns-falha.exemplo.com") return rec("ERRO", name, null, "Não deu para consultar o DMARC agora. Tente de novo em instantes.")
  if (domain === "todos-ok.exemplo.com") return rec("OK", name, "v=DMARC1; p=quarantine; rua=mailto:dmarc@todos-ok.exemplo.com", "O DMARC está ativo e protege o domínio.")
  if (domain === "spf-ausente.exemplo.com" || domain === "gmail.com") return rec("AUSENTE", name, null, "Não encontramos um registro DMARC. Cadastre o exemplo sugerido para começar só monitorando.")
  return rec("ATENCAO", name, "v=DMARC1; p=none", "O DMARC existe, mas só monitora (p=none). Quando estiver tudo certo, endureça para quarentena.")
}

function dkimFor(domain: string, selector: string | null): DnsRecordCheck {
  // Sem seletor o servidor NÃO consulta nada (`nomeConsultado: null`).
  if (selector === null) return rec("ATENCAO", null, null, "Informe o seletor DKIM (o provedor mostra ao ativar o DKIM) para verificar este registro. Ele não conta no resultado geral.")
  const name = `${selector}._domainkey.${domain}`
  if (domain === "dns-falha.exemplo.com" || selector === "erro") return rec("ERRO", name, null, "Não deu para consultar o DKIM agora. Tente de novo em instantes.")
  if (selector === "ausente") return rec("AUSENTE", name, null, "Não encontramos o DKIM com esse seletor. Confira o seletor no painel do provedor e se o registro já foi cadastrado.")
  return rec("OK", name, "v=DKIM1; k=rsa; p=MIIBIjANBgkqh…", "O DKIM está publicado: seus e-mails saem assinados.")
}

const STATUS_ORDER: DnsRecordStatus[] = ["OK", "ATENCAO", "AUSENTE", "ERRO"]
const DOMAIN_NOTE =
  "SPF, DKIM e DMARC são configurados no painel de DNS do domínio (onde ele foi registrado), não no InnoFlow. Depois de alterar, a mudança leva de alguns minutos a algumas horas para valer; consulte de novo mais tarde."

export function domainCheck(userId: string, selectorRaw: string | null, override: string | null): DomainCheckOutcome {
  const scenario = scenarioFor(userId)
  if (userId === "user_admin_comunicacao_indisponivel" || override === "HTTP_503") {
    return { status: 503, body: { error: "Não foi possível ler a configuração.", code: "COMMUNICATION_SETTINGS_UNAVAILABLE" } }
  }
  const selector = selectorRaw && selectorRaw.trim() !== "" ? selectorRaw.trim() : null
  if (selector !== null && !SELECTOR_RE.test(selector)) {
    return { status: 400, body: { error: "Seletor inválido.", code: "VALIDATION_ERROR", details: [{ path: "selector", message: "Seletor inválido: use só letras, números e hífen (até 63 caracteres)." }] } }
  }
  const now = Date.now()
  const recent = (domainCallsByUser.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= DOMAIN_LIMIT_PER_MINUTE) {
    domainCallsByUser.set(userId, recent)
    return { status: 429, body: { error: "Muitas verificações.", code: "RATE_LIMITED_COMMUNICATION_SETTINGS" }, headers: { "retry-after": "60" } }
  }
  domainCallsByUser.set(userId, [...recent, now])

  const checkedAt = new Date().toISOString()
  const domain = scenario.email.fromAddress?.split("@")[1]?.toLowerCase() ?? null
  if (!domain) {
    return {
      status: 200,
      body: {
        senderConfigured: false,
        domain: null,
        smtpProvider: null,
        overallStatus: null,
        spf: null,
        dkim: null,
        dmarc: null,
        warnings: ['Cadastre primeiro o e-mail remetente (o "de") com um domínio de verdade, como aviso@suaempresa.com.br. A verificação usa o domínio dele.'],
        instructions: null,
        note: DOMAIN_NOTE,
        checkedAt,
      },
    }
  }

  const spf = spfFor(domain)
  const dmarc = dmarcFor(domain)
  const dkim = dkimFor(domain, selector)
  const considered = selector === null ? [spf, dmarc] : [spf, dmarc, dkim]
  const overall = considered.map((r) => r.status).reduce<DnsRecordStatus>((worst, s) => (STATUS_ORDER.indexOf(s) > STATUS_ORDER.indexOf(worst) ? s : worst), "OK")
  const warnings: string[] = []
  if (domain === "gmail.com") {
    warnings.push(`O remetente usa um endereço de e-mail gratuito (${domain}). SPF, DKIM e DMARC desse domínio pertencem ao provedor e você não consegue alterá-los aqui. Para e-mails de cobrança e avisos mais confiáveis, use um e-mail do domínio da sua empresa.`)
  }
  const instruction = (nome: string, tipo: DnsInstruction["tipo"], valorSugerido: string | null, texto: string): DnsInstruction => ({ nome, tipo, valorSugerido, texto })
  return {
    status: 200,
    body: {
      senderConfigured: true,
      domain,
      smtpProvider: "Provedor de exemplo",
      overallStatus: overall,
      spf,
      dkim,
      dmarc,
      warnings,
      instructions: {
        spf: instruction(domain, "TXT", null, "O valor exato do SPF depende do provedor do seu servidor de e-mail (SMTP): peça a ele o registro SPF correto e cadastre-o como um registro TXT no nome do domínio."),
        dkim: instruction(selector ? `${selector}._domainkey.${domain}` : `<seletor>._domainkey.${domain}`, "TXT ou CNAME", null, "O DKIM é gerado pelo provedor do seu servidor de e-mail: ative-o no painel dele e cadastre no DNS exatamente como informado."),
        dmarc: instruction(`_dmarc.${domain}`, "TXT", `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`, "Exemplo seguro para começar: ele só monitora e não bloqueia nenhum e-mail."),
      },
      note: DOMAIN_NOTE,
      checkedAt,
    },
  }
}
