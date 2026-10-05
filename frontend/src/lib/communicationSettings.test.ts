import { AxiosError, type AxiosResponse } from "axios"
import { describe, expect, it } from "vitest"
import type { CommunicationSettingsDTO } from "@/types/api"
import {
  EMPTY_DRAFT,
  EVOLUTION_SECRET_AGAIN_MESSAGE,
  MSG_NETWORK,
  MSG_SECRETS_KEY_MISSING,
  NO_SECRETS_KEY_MESSAGE,
  SMTP_SECRET_AGAIN_MESSAGE,
  buildUpdatePayload,
  describeChanges,
  draftTouched,
  formatApiKeyHint,
  hasChanges,
  isValidBaseUrl,
  isValidSmtpHost,
  normalizePhone,
  parseCommunicationError,
  parsePhoneList,
  parseRecipientList,
  planEmailTest,
  planWhatsappTest,
  testErrorText,
  validateDraft,
  withCurrentPassword,
  type CommunicationDraft,
} from "./communicationSettings"

function dto(over: Partial<CommunicationSettingsDTO> = {}, email: Partial<CommunicationSettingsDTO["email"]> = {}, whatsapp: Partial<CommunicationSettingsDTO["whatsapp"]> = {}): CommunicationSettingsDTO {
  return {
    source: "database",
    email: {
      source: "database",
      enabled: true,
      active: true,
      host: "smtp.x.com",
      port: 587,
      secure: false,
      user: "u@x.com",
      passwordSet: true,
      fromName: "InnoFlow",
      fromAddress: "u@x.com",
      recipients: ["dono@x.com"],
      minSeverity: "IMPORTANTE",
      ...email,
    },
    whatsapp: {
      source: "database",
      enabled: true,
      active: true,
      provider: "evolution",
      baseUrl: "https://evo.x.com",
      instance: "inst",
      apiKeySet: true,
      apiKeyHint: "a1b2",
      apiVersion: 2,
      recipients: ["5511999999999"],
      minSeverity: "CRITICO",
      ...whatsapp,
    },
    alerts: { dedupeMinutes: 30, dedupeSource: "env", globalMinSeverity: "INFO", maxPerHour: 20 },
    secretsKeyConfigured: true,
    secretsDecryptable: true,
    privateHostsAllowed: false,
    warnings: [],
    updatedAt: "2026-10-04T13:20:00.000Z",
    ...over,
  }
}

const draft = (patch: Partial<CommunicationDraft>): CommunicationDraft => ({ ...EMPTY_DRAFT, ...patch })

function axiosError(status: number, data: unknown, headers: Record<string, string> = {}) {
  const err = new AxiosError("falhou")
  err.response = { status, data, headers, statusText: "", config: {} as never } as AxiosResponse
  return err
}

describe("normalização", () => {
  it("lista de e-mails: separa por linha/vírgula/ponto e vírgula e tira repetidos sem olhar a caixa", () => {
    expect(parseRecipientList("a@x.com\nb@x.com, A@X.com; c@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"])
  })
  it("números: remove a máscara e mantém só dígitos; máscara com espaço não quebra o número", () => {
    expect(normalizePhone("+55 (11) 99999-9999")).toBe("5511999999999")
    expect(parsePhoneList("+55 (11) 99999-9999\n5511999999999\n55 21 98888-7777")).toEqual(["5511999999999", "5521988887777"])
  })
  it("dica da apikey aceita com e sem reticência", () => {
    expect(formatApiKeyHint("a1b2")).toBe("…a1b2")
    expect(formatApiKeyHint("…a1b2")).toBe("…a1b2")
    expect(formatApiKeyHint(null)).toBeNull()
  })
  it("host SMTP: só nome/IP; URL, porta e caminho são recusados", () => {
    expect(isValidSmtpHost("smtp.x.com")).toBe(true)
    expect(isValidSmtpHost("http://smtp.x.com")).toBe(false)
    expect(isValidSmtpHost("smtp.x.com:587")).toBe(false)
    expect(isValidSmtpHost("smtp.x.com/abc")).toBe(false)
    expect(isValidBaseUrl("https://evo.x.com")).toBe(true)
    expect(isValidBaseUrl("evo.x.com")).toBe(false)
  })
})

describe("buildUpdatePayload — só o diff", () => {
  it("sem mexer em nada, nada é enviado", () => {
    expect(hasChanges(buildUpdatePayload(dto(), EMPTY_DRAFT))).toBe(false)
  })

  it("valor igual ao salvo não é alteração; em branco num campo obrigatório = manter", () => {
    const d = dto()
    const payload = buildUpdatePayload(d, draft({ email: { host: "smtp.x.com", port: "587", fromAddress: "  " } }))
    expect(payload).toEqual({})
  })

  it("segredo vazio (campo aberto, nada digitado) não vai; digitado vai; destinatários substituem a lista inteira", () => {
    const d = dto()
    expect(buildUpdatePayload(d, draft({ email: { password: "" } }))).toEqual({})
    expect(buildUpdatePayload(d, draft({ email: { password: "nova", recipients: "a@x.com\nb@x.com" } }))).toEqual({ email: { password: "nova", recipients: ["a@x.com", "b@x.com"] } })
  })

  it("usuário apagado vira null; nome do remetente apagado vira null", () => {
    expect(buildUpdatePayload(dto(), draft({ email: { user: "", fromName: "" } }))).toEqual({ email: { user: null, fromName: null } })
  })

  it("`clearSecrets` só vale com segredo salvo e sem valor novo digitado", () => {
    expect(buildUpdatePayload(dto(), draft({ clear: { smtpPassword: true, evolutionApiKey: true } })).clearSecrets).toEqual(["smtpPassword", "evolutionApiKey"])
    expect(buildUpdatePayload(dto({}, { passwordSet: false }), draft({ clear: { smtpPassword: true } })).clearSecrets).toBeUndefined()
    expect(buildUpdatePayload(dto(), draft({ clear: { smtpPassword: true }, email: { password: "x" } })).clearSecrets).toBeUndefined()
  })

  it("canal que ainda NÃO está no painel: qualquer gravação leva `enabled` EXPLÍCITO (senão a 1ª gravação o desligaria)", () => {
    const fromEnv = dto({ source: "env" }, { source: "env", enabled: true })
    expect(buildUpdatePayload(fromEnv, draft({ email: { fromName: "Novo" } }))).toEqual({ email: { fromName: "Novo", enabled: true } })
    // canal já no painel: só vai o que mudou
    expect(buildUpdatePayload(dto(), draft({ email: { fromName: "Novo" } }))).toEqual({ email: { fromName: "Novo" } })
    // mexer no interruptor
    expect(buildUpdatePayload(dto(), draft({ whatsapp: { enabled: false } }))).toEqual({ whatsapp: { enabled: false } })
  })

  it("janela de repetição: número válido; em branco só vira `null` se há valor salvo no painel", () => {
    expect(buildUpdatePayload(dto(), draft({ alerts: { dedupeMinutes: "45" } }))).toEqual({ alerts: { dedupeMinutes: 45 } })
    expect(buildUpdatePayload(dto(), draft({ alerts: { dedupeMinutes: "" } }))).toEqual({})
    const saved = dto()
    saved.alerts = { ...saved.alerts, dedupeSource: "database", dedupeMinutes: 45 }
    expect(buildUpdatePayload(saved, draft({ alerts: { dedupeMinutes: "" } }))).toEqual({ alerts: { dedupeMinutes: null } })
  })

  it("números de WhatsApp vão normalizados (só dígitos)", () => {
    expect(buildUpdatePayload(dto(), draft({ whatsapp: { recipients: "+55 (21) 98888-7777" } }))).toEqual({ whatsapp: { recipients: ["5521988887777"] } })
  })

  it("a senha atual só entra na hora do envio e não toca o diff", () => {
    const payload = buildUpdatePayload(dto(), draft({ email: { fromName: "Novo" } }))
    expect(payload).not.toHaveProperty("currentPassword")
    expect(withCurrentPassword(payload, "abc")).toEqual({ email: { fromName: "Novo" }, currentPassword: "abc" })
  })

  it("draftTouched enxerga qualquer sobreposição, mesmo sem alteração real", () => {
    expect(draftTouched(EMPTY_DRAFT)).toBe(false)
    expect(draftTouched(draft({ email: { password: "" } }))).toBe(true)
    expect(draftTouched(draft({ clear: { smtpPassword: true } }))).toBe(true)
  })
})

describe("validateDraft", () => {
  it("só acusa o que o admin mexeu", () => {
    expect(validateDraft(dto(), EMPTY_DRAFT)).toEqual({})
  })

  it("campos inválidos (mexer no host/URL com segredo salvo também pede o segredo de novo)", () => {
    const errors = validateDraft(
      dto(),
      draft({
        email: { host: "http://x.com", port: "70000", fromAddress: "x", recipients: "ok@x.com\nruim" },
        whatsapp: { baseUrl: "evo.x.com", instance: "a b", recipients: "123" },
        alerts: { dedupeMinutes: "0" },
      }),
    )
    expect(Object.keys(errors).sort()).toEqual(
      ["alerts.dedupeMinutes", "email.fromAddress", "email.host", "email.password", "email.port", "email.recipients", "whatsapp.apiKey", "whatsapp.baseUrl", "whatsapp.instance", "whatsapp.recipients"].sort(),
    )
  })

  it("mais de 10 destinatários", () => {
    const many = Array.from({ length: 11 }, (_, i) => `a${i}@x.com`).join("\n")
    expect(validateDraft(dto(), draft({ email: { recipients: many } }))["email.recipients"]).toMatch(/No máximo 10/)
  })

  it("trocar host/usuário SMTP com senha salva EXIGE digitar a senha de novo; trocar só a porta não", () => {
    expect(validateDraft(dto(), draft({ email: { host: "outro.x.com" } }))["email.password"]).toBe(SMTP_SECRET_AGAIN_MESSAGE)
    expect(validateDraft(dto(), draft({ email: { user: "outro@x.com" } }))["email.password"]).toBe(SMTP_SECRET_AGAIN_MESSAGE)
    expect(validateDraft(dto(), draft({ email: { port: "465" } }))["email.password"]).toBeUndefined()
    expect(validateDraft(dto(), draft({ email: { host: "outro.x.com", password: "nova" } }))["email.password"]).toBeUndefined()
    expect(validateDraft(dto(), draft({ email: { host: "outro.x.com" }, clear: { smtpPassword: true } }))["email.password"]).toBeUndefined()
    // sem senha salva não há o que redigitar
    expect(validateDraft(dto({}, { passwordSet: false }), draft({ email: { host: "outro.x.com" } }))["email.password"]).toBeUndefined()
  })

  it("mesma regra para URL/instância da Evolution e a apikey", () => {
    expect(validateDraft(dto(), draft({ whatsapp: { baseUrl: "https://outra.x.com" } }))["whatsapp.apiKey"]).toBe(EVOLUTION_SECRET_AGAIN_MESSAGE)
    expect(validateDraft(dto(), draft({ whatsapp: { instance: "outra" } }))["whatsapp.apiKey"]).toBe(EVOLUTION_SECRET_AGAIN_MESSAGE)
    expect(validateDraft(dto(), draft({ whatsapp: { apiVersion: 1 } }))["whatsapp.apiKey"]).toBeUndefined()
  })

  it("servidor sem chave de cifragem: digitar segredo é erro de campo", () => {
    const d = dto({ secretsKeyConfigured: false })
    expect(validateDraft(d, draft({ email: { password: "x" } }))["email.password"]).toBe(NO_SECRETS_KEY_MESSAGE)
    expect(validateDraft(d, draft({ whatsapp: { apiKey: "x" } }))["whatsapp.apiKey"]).toBe(NO_SECRETS_KEY_MESSAGE)
    expect(validateDraft(d, draft({ email: { fromName: "x" } }))).toEqual({})
  })
})

describe("describeChanges — nunca mostra segredo nem e-mails", () => {
  it("segredo = texto fixo; destinatários = contagem", () => {
    const d = dto()
    const payload = buildUpdatePayload(d, draft({ email: { password: "SEGREDO-XYZ", recipients: "a@x.com\nb@x.com", host: "novo.x.com" }, whatsapp: { apiKey: "CHAVE-ABC" }, clear: {} }))
    const items = describeChanges(d, payload)
    const text = JSON.stringify(items)
    expect(text).not.toContain("SEGREDO-XYZ")
    expect(text).not.toContain("CHAVE-ABC")
    expect(text).not.toContain("a@x.com")
    expect(items.find((i) => i.key === "email.password")).toMatchObject({ to: "Será substituída", secret: true })
    expect(items.find((i) => i.key === "email.recipients")).toMatchObject({ from: "1 destinatário", to: "2 destinatários" })
  })
  it("apagar segredo aparece como 'Será apagada'", () => {
    const d = dto()
    const items = describeChanges(d, buildUpdatePayload(d, draft({ clear: { smtpPassword: true } })))
    expect(items).toEqual([{ key: "clear.smtpPassword", label: "Senha SMTP", to: "Será apagada", secret: true }])
  })
})

describe("planEmailTest / planWhatsappTest", () => {
  it("sem alteração no rascunho testa a config SALVA: pedido só com o destino (ou vazio)", () => {
    expect(planEmailTest(dto(), {}, "", {}).request).toEqual({ to: "dono@x.com" })
    expect(planEmailTest(dto({}, { recipients: [] }), {}, "outro@x.com", {}).request).toEqual({ to: "outro@x.com" })
  })

  it("sem destino nenhum o teste não sai", () => {
    const plan = planEmailTest(dto({}, { recipients: [] }), {}, "", {})
    expect(plan.request).toBeUndefined()
    expect(plan.errors.to).toMatch(/Informe/)
  })

  it("com valores digitados envia `config` com o EFETIVO e só leva a senha se foi digitada", () => {
    const plan = planEmailTest(dto(), { host: "novo.x.com", password: "nova" }, "", {})
    expect(plan.request).toEqual({
      to: "dono@x.com",
      config: { host: "novo.x.com", port: 587, secure: false, user: "u@x.com", fromName: "InnoFlow", fromAddress: "u@x.com", password: "nova" },
    })
  })

  it("testar com host novo sem redigitar a senha salva é bloqueado no cliente", () => {
    const plan = planEmailTest(dto(), { host: "novo.x.com" }, "", {})
    expect(plan.request).toBeUndefined()
    expect(plan.errors["email.password"]).toBe(SMTP_SECRET_AGAIN_MESSAGE)
  })

  it("WhatsApp: número com máscara é normalizado; URL nova sem apikey é bloqueada", () => {
    expect(planWhatsappTest(dto(), {}, "+55 (21) 98888-7777", {}).request).toEqual({ to: "5521988887777" })
    const blocked = planWhatsappTest(dto(), { baseUrl: "https://outra.x.com" }, "", {})
    expect(blocked.request).toBeUndefined()
    expect(blocked.errors["whatsapp.apiKey"]).toBe(EVOLUTION_SECRET_AGAIN_MESSAGE)
    const ok = planWhatsappTest(dto(), { baseUrl: "https://outra.x.com", apiKey: "k" }, "", {})
    expect(ok.request).toEqual({ to: "5511999999999", config: { baseUrl: "https://outra.x.com", instance: "inst", apiVersion: 2, apiKey: "k" } })
  })

  it("texto do resultado é por code; code desconhecido cai no genérico", () => {
    expect(testErrorText("SMTP_AUTH_FAILED").title).toMatch(/usuário ou a senha/)
    expect(testErrorText("WHATSAPP_AUTH_FAILED").title).toMatch(/apikey/)
    expect(testErrorText("XYZ").title).toBe("O teste falhou.")
  })
})

describe("parseCommunicationError — por code, nunca pelo texto do servidor", () => {
  const msg = (status: number, code: string | undefined, details?: unknown) => parseCommunicationError(axiosError(status, { error: "TEXTO-DO-SERVIDOR", ...(code ? { code } : {}), ...(details ? { details } : {}) }))

  it("sem resposta: erro de rede", () => {
    expect(parseCommunicationError(new Error("x")).message).toBe(MSG_NETWORK)
  })
  it("nenhum erro ecoa o texto do servidor", () => {
    for (const [status, code] of [[400, "VALIDATION_ERROR"], [403, "INVALID_CURRENT_PASSWORD"], [429, "RATE_LIMITED_PAYMENT_GATEWAY"], [429, "RATE_LIMITED_COMMUNICATION_SETTINGS"], [503, "STEPUP_UNAVAILABLE"], [503, "SECRETS_KEY_MISSING"], [503, "COMMUNICATION_SETTINGS_UNAVAILABLE"], [409, "CHANNEL_INCOMPLETE"], [400, "DESTINATION_NOT_ALLOWED"], [400, "SECRET_REQUIRED_FOR_NEW_DESTINATION"], [500, "INTERNAL_ERROR"], [401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [418, "OUTRO"]] as const) {
      expect(msg(status, code).message, `${status} ${code}`).not.toContain("TEXTO-DO-SERVIDOR")
    }
  })
  it("401 desloga (draftKept false); 403 senha errada e 429 não", () => {
    expect(msg(401, "UNAUTHORIZED").draftKept).toBe(false)
    expect(msg(403, "INVALID_CURRENT_PASSWORD")).toMatchObject({ code: "INVALID_CURRENT_PASSWORD", draftKept: true, message: "Senha incorreta." })
    expect(msg(429, "RATE_LIMITED_PAYMENT_GATEWAY").draftKept).toBe(true)
  })
  it("503 SECRETS_KEY_MISSING tem mensagem própria, distinta de COMMUNICATION_SETTINGS_UNAVAILABLE", () => {
    expect(msg(503, "SECRETS_KEY_MISSING").message).toBe(MSG_SECRETS_KEY_MISSING)
    expect(msg(503, "COMMUNICATION_SETTINGS_UNAVAILABLE").message).not.toBe(MSG_SECRETS_KEY_MISSING)
  })
  it("DESTINATION_NOT_ALLOWED: explica em linguagem simples e aponta o campo", () => {
    const e = msg(400, "DESTINATION_NOT_ALLOWED", [{ field: "email.host", reason: "REDE_PRIVADA" }])
    expect(e.message).toMatch(/Endereço interno não é permitido em produção/)
    expect(e.fields).toEqual(["email.host"])
    expect(msg(400, "DESTINATION_NOT_ALLOWED", [{ field: "whatsapp.baseUrl", reason: "HTTPS_REQUIRED" }]).message).toMatch(/https:\/\//)
  })
  it("SECRET_REQUIRED...: `config.password`/`config.apiKey` apontam o campo da tela", () => {
    expect(msg(400, "SECRET_REQUIRED_FOR_NEW_DESTINATION", [{ field: "config.password" }])).toMatchObject({ fields: ["email.password"], message: SMTP_SECRET_AGAIN_MESSAGE })
    expect(msg(400, "SECRET_REQUIRED_FOR_NEW_DESTINATION", [{ field: "whatsapp.apiKey" }])).toMatchObject({ fields: ["whatsapp.apiKey"], message: EVOLUTION_SECRET_AGAIN_MESSAGE })
  })
  it("CHANNEL_INCOMPLETE: nada foi gravado e as pendências vêm por canal", () => {
    const e = msg(409, "CHANNEL_INCOMPLETE", [{ channel: "whatsapp", problems: ["Informe a apikey da Evolution."] }])
    expect(e.message).toMatch(/canal de WhatsApp/)
    expect(e.message).toMatch(/Nada foi salvo/)
    expect(e.problems).toEqual([{ channel: "whatsapp", problems: ["Informe a apikey da Evolution."] }])
  })
  it("429 lê Retry-After; sem code, 429/503 caem por status", () => {
    const e = parseCommunicationError(axiosError(429, { error: "x", code: "RATE_LIMITED_PAYMENT_GATEWAY" }, { "retry-after": "300" }))
    expect(e.retryAfterSeconds).toBe(300)
    expect(parseCommunicationError(axiosError(429, "<html>")).message).toMatch(/Muitas/)
    expect(parseCommunicationError(axiosError(503, "<html>")).message).toMatch(/configuração de comunicação/)
  })
})
