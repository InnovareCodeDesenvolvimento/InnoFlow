import { describe, expect, it } from "vitest"
import { AxiosError, AxiosHeaders } from "axios"
import {
  buildUpdatePayload,
  describeChanges,
  extractRequirements,
  generateRandomSecret,
  GENERATED_SECRET_MIN_LENGTH,
  hasChanges,
  isProductionConfirmation,
  parseGatewaySaveError,
  readinessSummary,
  REQUIREMENT_INFO,
  requirementInfo,
  splitRequirements,
  validateDraft,
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

  it("os 4 'só do servidor' do contrato apontam para a variável do EasyPanel; os demais se resolvem na tela", () => {
    const serverOnly: PaymentGatewayRequirement[] = ["SOP_SCRIPT_URL", "SOP_OAUTH_TOKEN_URL", "WEBHOOK_PATH_TOKEN", "PAYMENT_SECRETS_KEY"]
    for (const code of ALL_REQUIREMENTS) {
      const info = REQUIREMENT_INFO[code]
      if (serverOnly.includes(code)) {
        expect(info.where).toBe("server")
        expect(info.envVar).toBeTruthy()
      } else {
        expect(info.where).toBe("screen")
        expect(info.section).toBeTruthy()
      }
    }
    expect(REQUIREMENT_INFO.PAYMENT_SECRETS_KEY.envVar).toBe("PAYMENT_SECRETS_KEY")
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
    expect(buildUpdatePayload(dto, { merchantKey: "nova-chave\n", sopClientSecret: "s3gredo", webhookHeaderSecret: "12345678" })).toEqual({
      merchantKey: "nova-chave",
      sopClientSecret: "s3gredo",
      webhookHeaderSecret: "12345678",
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
    expect(buildUpdatePayload(dto, { webhookHeaderSecret: "abcdefgh1234", webhookSecretRevealed: true })).toEqual({ webhookHeaderSecret: "abcdefgh1234" })
  })
})

describe("validateDraft", () => {
  it("segredo do webhook com 1 a 7 caracteres é erro (mínimo do contrato: 8); vazio/ausente/8+ não", () => {
    expect(validateDraft({ webhookHeaderSecret: "1234567" }).webhookHeaderSecret).toMatch(/8 caracteres/)
    expect(validateDraft({ webhookHeaderSecret: "12345678" })).toEqual({})
    expect(validateDraft({ webhookHeaderSecret: "" })).toEqual({})
    expect(validateDraft({})).toEqual({})
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

  it("PAYMENT_SECRETS_KEY_MISSING (503): explica a variável e o comando openssl", () => {
    const parsed = parseGatewaySaveError(axiosError(503, { error: "x", code: "PAYMENT_SECRETS_KEY_MISSING" }))
    expect(parsed.message).toContain("PAYMENT_SECRETS_KEY")
    expect(parsed.message).toContain("openssl rand -base64 32")
  })

  it("PRODUCTION_CONFIRMATION_REQUIRED, VALIDATION_ERROR, FORBIDDEN e genérico têm texto próprio", () => {
    expect(parseGatewaySaveError(axiosError(400, { error: "x", code: "PRODUCTION_CONFIRMATION_REQUIRED" })).message).toMatch(/confirmação digitada/)
    expect(parseGatewaySaveError(axiosError(400, { error: "webhookHeaderSecret: mínimo 8", code: "VALIDATION_ERROR" })).message).toMatch(/webhookHeaderSecret: mínimo 8/)
    expect(parseGatewaySaveError(axiosError(403, { error: "x", code: "FORBIDDEN" })).message).toMatch(/administradores/)
    expect(parseGatewaySaveError(axiosError(500, { error: "boom", code: "INTERNAL" })).message).toMatch(/Não foi possível salvar/)
  })

  it("sem resposta (rede caiu) e erro que não é do axios: mensagem de conexão", () => {
    expect(parseGatewaySaveError(new AxiosError("Network Error")).message).toMatch(/servidor/)
    expect(parseGatewaySaveError(new Error("qualquer")).message).toMatch(/servidor/)
  })
})
