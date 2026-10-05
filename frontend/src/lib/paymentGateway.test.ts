import { describe, expect, it } from "vitest"
import { AxiosError, AxiosHeaders } from "axios"
import {
  buildUpdatePayload,
  describeChanges,
  extractInflightCount,
  extractRequirements,
  generateRandomSecret,
  GENERATED_SECRET_MIN_LENGTH,
  hasChanges,
  inflightPaymentsMessage,
  isProductionConfirmation,
  parseGatewayLoadError,
  parseGatewaySaveError,
  readinessSummary,
  REQUIREMENT_INFO,
  requirementInfo,
  splitRequirements,
  validateCredentialPairs,
  validateDraft,
  WEBHOOK_SECRET_MIN,
  withCurrentPassword,
} from "./paymentGateway"
import type { PaymentGatewayConfigDTO, PaymentGatewayRequirement } from "@/types/api"

const ALL_REQUIREMENTS: PaymentGatewayRequirement[] = [
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

const dto: PaymentGatewayConfigDTO = {
  source: "database",
  environment: "sandbox",
  merchantId: "mid-1",
  merchantKeySet: true,
  sopClientId: "sop-1",
  sopClientSecretSet: false,
  webhookHeaderSecretSet: true,
  webhookUrl: "https://x.example/hook",
  webhookHeaderName: "X-Hook",
  cardEnabled: false,
  pixEnabled: true,
  readiness: { card: { ready: false, missing: ["SOP_CLIENT_SECRET"] }, pix: { ready: true, missing: [] } },
  secretsDecryptable: true,
  sandboxRestricted: false,
  updatedAt: "2026-10-01T14:32:00.000Z",
}

describe("isProductionConfirmation — palavra PRODUÇÃO, tolerante a caixa e acento", () => {
  it.each(["PRODUÇÃO", "produção", "Producao", "PRODUCAO", "  produção  ", "pRoDuÇãO"])("aceita %j", (typed) => {
    expect(isProductionConfirmation(typed)).toBe(true)
  })
  it.each(["", "prod", "producoes", "produção!", "PRODUÇÃO ATIVA", "sandbox", "pro duçao"])("rejeita %j", (typed) => {
    expect(isProductionConfirmation(typed)).toBe(false)
  })
  it("aceita a forma decomposta (NFD) que alguns teclados/colagens geram", () => {
    expect(isProductionConfirmation("PRODUÇÃO")).toBe(true)
  })
})

describe("mapa de requisitos", () => {
  it("todo código do contrato tem texto em português (nenhum fica sem tradução)", () => {
    for (const code of ALL_REQUIREMENTS) {
      expect(REQUIREMENT_INFO[code].label.length).toBeGreaterThan(5)
      expect(REQUIREMENT_INFO[code].label).not.toMatch(/^[A-Z_]+$/) // nunca o código cru
    }
  })

  it("os 'só do servidor' do contrato apontam para a variável do EasyPanel (exceto a chave de segredos, que não manda criar variável); os demais se resolvem na tela", () => {
    const serverOnly: PaymentGatewayRequirement[] = ["SOP_SCRIPT_URL", "SOP_OAUTH_TOKEN_URL", "WEBHOOK_PATH_TOKEN", "PAYMENT_SECRETS_KEY"]
    for (const code of ALL_REQUIREMENTS) {
      const info = REQUIREMENT_INFO[code]
      if (serverOnly.includes(code)) {
        expect(info.where).toBe("server")
        if (code === "PAYMENT_SECRETS_KEY") expect(info.envVar).toBeUndefined()
        else expect(info.envVar).toBeTruthy()
      } else {
        expect(info.where).toBe("screen")
        expect(info.section).toBeTruthy()
      }
    }
    // Rótulo humano coerente com o novo modelo: a chave é derivada do JWT_SECRET, ninguém cria variável.
    expect(REQUIREMENT_INFO.PAYMENT_SECRETS_KEY.label).toBe("Chave de segredos do servidor")
    expect(REQUIREMENT_INFO.PAYMENT_SECRETS_KEY.note).toMatch(/administrador do servidor.*JWT_SECRET/)
    expect(REQUIREMENT_INFO.PAYMENT_SECRETS_KEY.note).not.toMatch(/openssl|criar|crie/i)
    expect(REQUIREMENT_INFO.WEBHOOK_PATH_TOKEN.envVar).toBe("CIELO_WEBHOOK_PATH_TOKEN")
  })

  it("splitRequirements separa tela x servidor, preservando a ordem", () => {
    expect(splitRequirements(["MERCHANT_KEY", "SOP_SCRIPT_URL", "MERCHANT_ID", "PAYMENT_SECRETS_KEY"])).toEqual({
      screen: ["MERCHANT_KEY", "MERCHANT_ID"],
      server: ["SOP_SCRIPT_URL", "PAYMENT_SECRETS_KEY"],
    })
  })

  it("código desconhecido (servidor mais novo) não quebra: vira texto genérico de servidor", () => {
    expect(requirementInfo("ALGO_NOVO")).toEqual({ label: "Pré-requisito ALGO_NOVO", where: "server" })
  })

  it("readinessSummary: Pronto / Falta 1 item / Faltam N itens", () => {
    expect(readinessSummary({ ready: true, missing: [] })).toBe("Pronto")
    expect(readinessSummary({ ready: false, missing: ["MERCHANT_ID"] })).toBe("Falta 1 item")
    expect(readinessSummary({ ready: false, missing: ["MERCHANT_ID", "MERCHANT_KEY", "SOP_CLIENT_ID"] })).toBe("Faltam 3 itens")
  })
})

describe("generateRandomSecret", () => {
  it("gera ≥ 32 caracteres alfanuméricos por padrão (40)", () => {
    const secret = generateRandomSecret()
    expect(secret).toHaveLength(40)
    expect(secret).toMatch(/^[A-Za-z0-9]+$/)
  })

  it("nunca gera menos que o piso, mesmo se pedirem menos", () => {
    expect(generateRandomSecret(4)).toHaveLength(GENERATED_SECRET_MIN_LENGTH)
  })

  it("dois segredos seguidos diferem (entropia real, sem Math.random previsível)", () => {
    expect(generateRandomSecret()).not.toBe(generateRandomSecret())
  })

  it("usa a fonte criptográfica injetada e DESCARTA bytes ≥ 248 (sem viés de módulo)", () => {
    const calls: number[] = []
    // 1ª leva: só bytes rejeitáveis (255) + alguns bons; o gerador precisa pedir mais até completar.
    const rng = (buffer: Uint8Array) => {
      calls.push(buffer.length)
      buffer.fill(255)
      buffer[0] = 0 // 'A'
      buffer[1] = 61 // '9'
      buffer[2] = 62 // 62 % 62 = 0 → 'A'
      return buffer
    }
    const secret = generateRandomSecret(32, rng)
    expect(secret).toHaveLength(32)
    expect(secret).toMatch(/^[A9]+$/) // nenhum 255 virou caractere
    expect(calls.length).toBeGreaterThan(1)
  })

  it("com a API real, passa por crypto.getRandomValues", () => {
    const original = crypto.getRandomValues.bind(crypto)
    let used = 0
    crypto.getRandomValues = ((array: ArrayBufferView) => {
      used++
      return original(array as Uint8Array)
    }) as typeof crypto.getRandomValues
    try {
      generateRandomSecret()
    } finally {
      crypto.getRandomValues = original
    }
    expect(used).toBeGreaterThan(0)
  })
})

/** 32 caracteres: o mínimo do segredo do webhook. */
const LONG_SECRET = "abcdefghijklmnopqrstuvwxyz012345"

describe("buildUpdatePayload — envia SÓ o que mudou", () => {
  it("rascunho vazio ou igual ao salvo → payload vazio", () => {
    expect(buildUpdatePayload(dto, {})).toEqual({})
    expect(buildUpdatePayload(dto, { merchantId: "mid-1", sopClientId: "sop-1", pixEnabled: true, cardEnabled: false, environment: "sandbox" })).toEqual({})
    expect(hasChanges({})).toBe(false)
  })

  it("texto: só o campo trocado; espaços nas pontas saem; em branco NÃO é enviado (sem 'apagar')", () => {
    expect(buildUpdatePayload(dto, { merchantId: "  mid-2  " })).toEqual({ merchantId: "mid-2" })
    expect(buildUpdatePayload(dto, { merchantId: "", sopClientId: "   " })).toEqual({})
  })

  it("segredo só vai se substituído e com conteúdo; vazio (clicou em Substituir e desistiu de digitar) não vai", () => {
    expect(buildUpdatePayload(dto, { merchantKey: "" })).toEqual({})
    expect(buildUpdatePayload(dto, { merchantKey: "nova-chave\n", sopClientSecret: "s3gredo", webhookHeaderSecret: LONG_SECRET })).toEqual({
      merchantKey: "nova-chave",
      sopClientSecret: "s3gredo",
      webhookHeaderSecret: LONG_SECRET,
    })
  })

  it("interruptores: só o que mudou em relação ao salvo", () => {
    expect(buildUpdatePayload(dto, { pixEnabled: false, cardEnabled: false })).toEqual({ pixEnabled: false })
    expect(buildUpdatePayload(dto, { cardEnabled: true })).toEqual({ cardEnabled: true })
  })

  it("sandbox → produção CONFIRMADA leva confirmProduction: true; sem confirmar, não leva", () => {
    expect(buildUpdatePayload(dto, { environment: "production", productionConfirmed: true })).toEqual({ environment: "production", confirmProduction: true })
    expect(buildUpdatePayload(dto, { environment: "production" })).toEqual({ environment: "production" })
  })

  it("produção → sandbox e produção → produção NÃO levam confirmProduction", () => {
    const prod = { ...dto, environment: "production" as const }
    expect(buildUpdatePayload(prod, { environment: "sandbox" })).toEqual({ environment: "sandbox" })
    expect(buildUpdatePayload(prod, { environment: "production", productionConfirmed: true })).toEqual({})
  })

  it("flag de UI (webhookSecretRevealed) nunca vai no corpo", () => {
    expect(buildUpdatePayload(dto, { webhookHeaderSecret: LONG_SECRET, webhookSecretRevealed: true })).toEqual({ webhookHeaderSecret: LONG_SECRET })
  })
})

describe("validateDraft", () => {
  it("segredo do webhook com 1 a 31 caracteres é erro (mínimo do servidor: 32); vazio/ausente/32+ não", () => {
    expect(WEBHOOK_SECRET_MIN).toBe(32)
    expect(validateDraft({ webhookHeaderSecret: "12345678" }).webhookHeaderSecret).toMatch(/32 caracteres/)
    expect(validateDraft({ webhookHeaderSecret: LONG_SECRET.slice(0, 31) }).webhookHeaderSecret).toMatch(/32 caracteres/)
    expect(validateDraft({ webhookHeaderSecret: LONG_SECRET })).toEqual({})
    expect(validateDraft({ webhookHeaderSecret: "" })).toEqual({})
    expect(validateDraft({})).toEqual({})
  })

  it("o mínimo vale depois do trim (espaços nas pontas não contam) e o gerador de 40 já atende", () => {
    expect(validateDraft({ webhookHeaderSecret: `  ${LONG_SECRET.slice(0, 31)}  ` }).webhookHeaderSecret).toBeDefined()
    expect(validateDraft({ webhookHeaderSecret: generateRandomSecret() })).toEqual({})
  })
})

describe("withCurrentPassword — step-up em TODO PUT", () => {
  it("junta a senha ao diff sem mutar o diff e sem perder campos", () => {
    const changes = buildUpdatePayload(dto, { pixEnabled: false })
    const body = withCurrentPassword(changes, "senha1234")
    expect(body).toEqual({ pixEnabled: false, currentPassword: "senha1234" })
    expect(changes).toEqual({ pixEnabled: false })
  })

  it("a senha NÃO é aparada (senha pode ter espaços) e o resumo do diálogo nunca a contém", () => {
    expect(withCurrentPassword({}, " s e n h a ").currentPassword).toBe(" s e n h a ")
    const changes = buildUpdatePayload(dto, { merchantKey: "chave-secreta-xyz" })
    expect(JSON.stringify(describeChanges(dto, changes))).not.toContain("chave-secreta-xyz")
  })
})

describe("describeChanges — o resumo nunca mostra valor de segredo", () => {
  it("segredos viram 'Será substituída'; o valor digitado não aparece em lugar nenhum", () => {
    const draft = { merchantKey: "SEGREDO-MK-123", sopClientSecret: "SEGREDO-SOP-456", webhookHeaderSecret: "SEGREDO-WH-789", merchantId: "mid-2", pixEnabled: false }
    const items = describeChanges(dto, buildUpdatePayload(dto, draft))
    expect(JSON.stringify(items)).not.toMatch(/SEGREDO/)
    expect(items.filter((i) => i.secret).map((i) => i.to)).toEqual(["Será substituída", "Será substituída", "Será substituída"])
    expect(items.find((i) => i.key === "merchantId")).toMatchObject({ from: "mid-1", to: "mid-2" })
    expect(items.find((i) => i.key === "pixEnabled")).toMatchObject({ from: "Habilitado", to: "Desabilitado" })
  })

  it("ambiente mostra de → para", () => {
    const items = describeChanges(dto, buildUpdatePayload(dto, { environment: "production", productionConfirmed: true }))
    expect(items).toEqual([{ key: "environment", label: "Ambiente", from: "Sandbox (testes)", to: "Produção" }])
  })
})

describe("extractRequirements / parseGatewaySaveError", () => {
  it("aceita array de strings e de objetos; ignora o que não reconhece e deduplica", () => {
    expect(extractRequirements(["MERCHANT_KEY", "MERCHANT_KEY", "LIXO", 42, { requirement: "SOP_CLIENT_ID" }, { path: "PAYMENT_SECRETS_KEY" }, { code: "WEBHOOK_HEADER_SECRET" }])).toEqual([
      "MERCHANT_KEY",
      "SOP_CLIENT_ID",
      "PAYMENT_SECRETS_KEY",
      "WEBHOOK_HEADER_SECRET",
    ])
    expect(extractRequirements(undefined)).toEqual([])
    expect(extractRequirements("MERCHANT_KEY")).toEqual([])
  })

  const axiosError = (status: number, data: unknown) =>
    new AxiosError("falhou", String(status), undefined, undefined, { status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data })

  it("GATEWAY_NOT_READY (409): devolve os requisitos que faltam", () => {
    const parsed = parseGatewaySaveError(axiosError(409, { error: "x", code: "GATEWAY_NOT_READY", details: ["MERCHANT_KEY", "WEBHOOK_PATH_TOKEN"] }))
    expect(parsed.code).toBe("GATEWAY_NOT_READY")
    expect(parsed.requirements).toEqual(["MERCHANT_KEY", "WEBHOOK_PATH_TOKEN"])
  })

  it("PAYMENT_SECRETS_KEY_MISSING (503): chave de segredos inválida/indisponível, manda conferir a configuração e NÃO manda criar variável nem gerar chave", () => {
    const parsed = parseGatewaySaveError(axiosError(503, { error: "x", code: "PAYMENT_SECRETS_KEY_MISSING" }))
    expect(parsed.message).toContain("A chave de segredos do servidor está inválida ou indisponível")
    expect(parsed.message).toContain("administrador do servidor")
    expect(parsed.message).toContain("JWT_SECRET")
    expect(parsed.message).not.toMatch(/openssl|criá-la/)
  })

  it("PRODUCTION_CONFIRMATION_REQUIRED, VALIDATION_ERROR, FORBIDDEN e genérico têm texto próprio", () => {
    expect(parseGatewaySaveError(axiosError(400, { error: "x", code: "PRODUCTION_CONFIRMATION_REQUIRED" })).message).toMatch(/confirmação digitada/)
    expect(parseGatewaySaveError(axiosError(400, { error: "webhookHeaderSecret: mínimo 32", code: "VALIDATION_ERROR" })).message).toMatch(/webhookHeaderSecret: mínimo 32/)
    expect(parseGatewaySaveError(axiosError(403, { error: "x", code: "FORBIDDEN" })).message).toMatch(/administradores/)
    expect(parseGatewaySaveError(axiosError(500, { error: "boom", code: "INTERNAL" })).message).toMatch(/Não foi possível salvar/)
  })

  it("STEPUP_UNAVAILABLE (503): mensagem própria, nada salvo, rascunho mantido (não é senha errada)", () => {
    const parsed = parseGatewaySaveError(axiosError(503, { error: "x", code: "STEPUP_UNAVAILABLE" }))
    expect(parsed).toMatchObject({ code: "STEPUP_UNAVAILABLE", draftKept: true })
    expect(parsed.message).toContain("Nada foi salvo")
    expect(parsed.message).not.toContain("incorreta")
  })

  it("INVALID_CURRENT_PASSWORD (403): 'Senha incorreta.' e o rascunho continua (o diálogo trata, sem deslogar)", () => {
    const parsed = parseGatewaySaveError(axiosError(403, { error: "x", code: "INVALID_CURRENT_PASSWORD" }))
    expect(parsed).toMatchObject({ code: "INVALID_CURRENT_PASSWORD", message: "Senha incorreta.", draftKept: true })
  })

  it("GATEWAY_HAS_INFLIGHT_PAYMENTS (409): N vem de details.count; sem número legível não inventa", () => {
    expect(parseGatewaySaveError(axiosError(409, { error: "x", code: "GATEWAY_HAS_INFLIGHT_PAYMENTS", details: { count: 3 } })).message).toBe(
      "Há 3 pagamentos em andamento neste ambiente. Aguarde liquidarem para trocar o ambiente.",
    )
    expect(inflightPaymentsMessage(1)).toBe("Há 1 pagamento em andamento neste ambiente. Aguarde liquidarem para trocar o ambiente.")
    const semNumero = parseGatewaySaveError(axiosError(409, { error: "x", code: "GATEWAY_HAS_INFLIGHT_PAYMENTS" })).message
    expect(semNumero).toMatch(/pagamentos em andamento/)
    expect(semNumero).not.toMatch(/\d/)
    expect(parseGatewaySaveError(axiosError(409, { error: "x", code: "GATEWAY_HAS_INFLIGHT_PAYMENTS", details: { count: 2 } })).draftKept).toBe(true)
  })

  it("extractInflightCount: aceita {count} e [{count}]; rejeita lixo", () => {
    expect(extractInflightCount({ count: 5 })).toBe(5)
    expect(extractInflightCount([{ count: 0 }])).toBe(0)
    for (const bad of [undefined, null, "3", [], {}, { count: "3" }, { count: -1 }, { count: 1.5 }, [null]]) expect(extractInflightCount(bad)).toBeNull()
  })

  it("sem resposta (rede caiu) e erro que não é do axios: mensagem de conexão", () => {
    expect(parseGatewaySaveError(new AxiosError("Network Error")).message).toMatch(/servidor/)
    expect(parseGatewaySaveError(new Error("qualquer")).message).toMatch(/servidor/)
  })
})

const axiosError = (status: number, data: unknown) =>
  new AxiosError("falhou", String(status), undefined, undefined, { status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data })

describe("PARES de credenciais (id + segredo no mesmo salvar)", () => {
  const fromEnv: PaymentGatewayConfigDTO = { ...dto, source: "env", merchantId: null, merchantKeySet: false, sopClientId: null, sopClientSecretSet: false, updatedAt: null }
  const pairs = (base: PaymentGatewayConfigDTO, draft: Parameters<typeof buildUpdatePayload>[1]) => validateCredentialPairs(base, buildUpdatePayload(base, draft))

  it("origem env: só o MerchantId => erro na MerchantKey, com a mensagem pedida", () => {
    expect(pairs(fromEnv, { merchantId: "mid-novo" })).toEqual({
      merchantKey: "Ao informar o MerchantId, informe também a MerchantKey nesta mesma alteração.",
    })
  })

  it("origem env: só a MerchantKey (id em branco) => erro no MerchantId", () => {
    expect(pairs(fromEnv, { merchantKey: "segredo" })).toEqual({
      merchantId: "Ao informar a MerchantKey, informe também o MerchantId nesta mesma alteração.",
    })
  })

  it("origem env: os dois lados juntos => sem erro", () => {
    expect(pairs(fromEnv, { merchantId: "mid-novo", merchantKey: "segredo" })).toEqual({})
  })

  it("origem env com id visível no campo (valor do env): trocar só a chave reenvia o id sozinho", () => {
    const envWithId: PaymentGatewayConfigDTO = { ...fromEnv, merchantId: "mid-do-env", merchantKeySet: true }
    const payload = buildUpdatePayload(envWithId, { merchantKey: "nova" })
    expect(payload).toEqual({ merchantKey: "nova", merchantId: "mid-do-env" })
    expect(validateCredentialPairs(envWithId, payload)).toEqual({})
  })

  it("banco SEM segredo salvo: só o id => erro; banco COM segredo salvo: só o id passa", () => {
    const dbNoKey: PaymentGatewayConfigDTO = { ...dto, merchantKeySet: false }
    expect(Object.keys(pairs(dbNoKey, { merchantId: "outro" }))).toEqual(["merchantKey"])
    expect(pairs(dto, { merchantId: "outro" })).toEqual({})
  })

  it("banco: trocar só a chave nunca exige o id (ele já está salvo)", () => {
    expect(pairs(dto, { merchantKey: "nova" })).toEqual({})
  })

  it("par do cartão (Client ID + Client Secret) segue a mesma regra, com mensagem própria", () => {
    // dto: sopClientSecretSet=false => só o Client ID não basta
    expect(pairs(dto, { sopClientId: "sop-2" })).toEqual({
      sopClientSecret: "Ao informar o Client ID do cadastro de cartão, informe também o Client Secret do cadastro de cartão nesta mesma alteração.",
    })
    expect(pairs(dto, { sopClientId: "sop-2", sopClientSecret: "s" })).toEqual({})
  })

  it("os dois pares são avaliados de forma independente", () => {
    expect(Object.keys(pairs(fromEnv, { merchantId: "a", sopClientId: "b" })).sort()).toEqual(["merchantKey", "sopClientSecret"])
  })

  it("alterar só flag/ambiente não dispara regra de par", () => {
    expect(pairs(fromEnv, { pixEnabled: true, environment: "production" })).toEqual({})
  })
})

describe("erros novos do servidor (F5.5): 401 / 429 / 503 / 500", () => {
  it.each(["RATE_LIMITED", "RATE_LIMITED_PAYMENT_GATEWAY"])("429 %s => 'Aguarde alguns minutos', rascunho mantido", (code) => {
    const parsed = parseGatewaySaveError(axiosError(429, { error: "x", code }))
    expect(parsed.message).toBe("Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.")
    expect(parsed.code).toBe(code)
    expect(parsed.draftKept).toBe(true)
  })

  it("429 sem code (proxy na frente) cai na mesma mensagem", () => {
    expect(parseGatewaySaveError(axiosError(429, undefined)).message).toMatch(/Aguarde alguns minutos/)
  })

  it("503 PAYMENT_GATEWAY_UNAVAILABLE explica leitura da configuração e que nada mudou — e não confunde com PAYMENT_SECRETS_KEY_MISSING", () => {
    const parsed = parseGatewaySaveError(axiosError(503, { error: "x", code: "PAYMENT_GATEWAY_UNAVAILABLE" }))
    expect(parsed.message).toMatch(/não conseguiu ler a configuração/)
    expect(parsed.message).toMatch(/JWT_SECRET do servidor foi trocado/)
    expect(parsed.message).toMatch(/Nada foi alterado/)
    expect(parsed.requirements).toEqual([]) // não é pendência para o admin resolver na tela
    expect(parsed.draftKept).toBe(true)
  })

  it("500 INTERNAL_ERROR: falha de auditoria => nada alterado, tente de novo", () => {
    const parsed = parseGatewaySaveError(axiosError(500, { error: "x", code: "INTERNAL_ERROR" }))
    expect(parsed.message).toBe("Não foi possível salvar e nada foi alterado. Tente novamente.")
    expect(parsed.draftKept).toBe(true)
  })

  it("401 UNAUTHORIZED: sessão expirou (o interceptor leva ao login); não promete rascunho", () => {
    const parsed = parseGatewaySaveError(axiosError(401, { error: "x", code: "UNAUTHORIZED" }))
    expect(parsed.message).toMatch(/sessão expirou/)
    expect(parsed.draftKept).toBe(false)
  })

  it("nenhuma dessas mensagens ecoa o texto cru do servidor (que poderia carregar dados)", () => {
    const parsed = parseGatewaySaveError(axiosError(500, { error: "SEGREDO-NO-ERRO", code: "INTERNAL_ERROR" }))
    expect(parsed.message).not.toContain("SEGREDO-NO-ERRO")
  })

  it("parseGatewayLoadError (GET): mesmas mensagens; 403/404 e rede ficam para o texto genérico (null)", () => {
    expect(parseGatewayLoadError(axiosError(503, { error: "x", code: "PAYMENT_GATEWAY_UNAVAILABLE" }))).toMatch(/não conseguiu ler a configuração/)
    expect(parseGatewayLoadError(axiosError(429, { error: "x", code: "RATE_LIMITED" }))).toMatch(/Aguarde alguns minutos/)
    expect(parseGatewayLoadError(axiosError(403, { error: "x", code: "FORBIDDEN" }))).toBeNull()
    expect(parseGatewayLoadError(new AxiosError("Network Error"))).toBeNull()
  })

  it("GATEWAY_NOT_READY por par não promete 'produção': a mensagem cobre pares e devolve a metade que falta", () => {
    const parsed = parseGatewaySaveError(axiosError(409, { error: "x", code: "GATEWAY_NOT_READY", details: ["MERCHANT_KEY"] }))
    expect(parsed.message).toMatch(/par de credenciais/)
    expect(parsed.requirements).toEqual(["MERCHANT_KEY"])
  })
})
