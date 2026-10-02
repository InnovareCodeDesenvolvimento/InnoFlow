import { describe, expect, it } from "vitest"
import { AxiosError, AxiosHeaders } from "axios"
import {
  CARD_GATEWAY_DISABLED_ADD_MESSAGE,
  CARD_GATEWAY_DISABLED_START_MESSAGE,
  isGatewayDisabledError,
  parseGatewayDisabledDetail,
  PIX_GATEWAY_DISABLED_MESSAGE,
} from "./paymentMethodDisabled"

const axiosError = (status: number, data: unknown) =>
  new AxiosError("falhou", String(status), undefined, undefined, { status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data })

describe("parseGatewayDisabledDetail — sentido 2 de PAYMENT_METHOD_DISABLED", () => {
  it("reconhece details[0].reason === GATEWAY_DISABLED, para CARD e PIX", () => {
    expect(parseGatewayDisabledDetail([{ method: "CARD", reason: "GATEWAY_DISABLED" }])).toEqual({ method: "CARD", reason: "GATEWAY_DISABLED" })
    expect(parseGatewayDisabledDetail([{ method: "PIX", reason: "GATEWAY_DISABLED" }])).toEqual({ method: "PIX", reason: "GATEWAY_DISABLED" })
  })

  it("SANDBOX_RESTRICTED cai no MESMO ramo, preservando o reason (e o method), para CARD e PIX", () => {
    expect(parseGatewayDisabledDetail([{ method: "CARD", reason: "SANDBOX_RESTRICTED" }])).toEqual({ method: "CARD", reason: "SANDBOX_RESTRICTED" })
    expect(parseGatewayDisabledDetail([{ method: "PIX", reason: "SANDBOX_RESTRICTED" }])).toEqual({ method: "PIX", reason: "SANDBOX_RESTRICTED" })
  })

  it("sem reason (ou details ausente/vazio/lixo) => null: vale o sentido antigo (cartão removido/desativado)", () => {
    for (const details of [undefined, null, [], {}, "x", [null], [42], [{}], [{ method: "CARD" }], [{ method: "CARD", reason: "OUTRA" }], [{ path: "x", message: "y" }]]) {
      expect(parseGatewayDisabledDetail(details)).toBeNull()
    }
  })

  it("só olha o primeiro item", () => {
    expect(parseGatewayDisabledDetail([{ method: "CARD" }, { method: "CARD", reason: "GATEWAY_DISABLED" }])).toBeNull()
  })

  it("method desconhecido cai em CARD (o servidor só manda CARD/PIX; o fallback não esconde o aviso)", () => {
    expect(parseGatewayDisabledDetail([{ method: "BOLETO", reason: "GATEWAY_DISABLED" }])?.method).toBe("CARD")
  })
})

describe("isGatewayDisabledError", () => {
  it("true: 409 PAYMENT_METHOD_DISABLED com GATEWAY_DISABLED", () => {
    expect(isGatewayDisabledError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_DISABLED", details: [{ method: "PIX", reason: "GATEWAY_DISABLED" }] }))).toBe(true)
  })

  it("true: 409 PAYMENT_METHOD_DISABLED com SANDBOX_RESTRICTED (cartão e Pix)", () => {
    expect(isGatewayDisabledError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_DISABLED", details: [{ method: "PIX", reason: "SANDBOX_RESTRICTED" }] }))).toBe(true)
    expect(isGatewayDisabledError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_DISABLED", details: [{ method: "CARD", reason: "SANDBOX_RESTRICTED" }] }))).toBe(true)
  })

  it("a mensagem ao motorista NÃO muda nem revela o motivo (testadores/sandbox)", () => {
    for (const text of [CARD_GATEWAY_DISABLED_START_MESSAGE, CARD_GATEWAY_DISABLED_ADD_MESSAGE, PIX_GATEWAY_DISABLED_MESSAGE]) {
      expect(text).toMatch(/indisponível no momento/)
      expect(text).not.toMatch(/sandbox|testador|restri/i)
    }
  })

  it("false: PAYMENT_METHOD_DISABLED sem reason (cartão desativado pelo motorista)", () => {
    expect(isGatewayDisabledError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_DISABLED" }))).toBe(false)
    expect(isGatewayDisabledError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_DISABLED", details: [] }))).toBe(false)
  })

  it("false: outro code mesmo com details parecidos; erro sem resposta; não-axios", () => {
    expect(isGatewayDisabledError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_NOT_FOUND", details: [{ method: "CARD", reason: "GATEWAY_DISABLED" }] }))).toBe(false)
    expect(isGatewayDisabledError(new AxiosError("Network Error"))).toBe(false)
    expect(isGatewayDisabledError(new Error("x"))).toBe(false)
    expect(isGatewayDisabledError(undefined)).toBe(false)
  })
})
