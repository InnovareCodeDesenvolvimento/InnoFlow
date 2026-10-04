import { describe, expect, it } from "vitest"
import { isTestFailure, testSupportText, testVerdict } from "./paymentGatewayTest"
import type { PaymentGatewayTestResult, PaymentGatewayTestStatus } from "@/types/api"

const result = (statuses: [PaymentGatewayTestStatus, PaymentGatewayTestStatus, PaymentGatewayTestStatus], ok: boolean): PaymentGatewayTestResult => ({
  environment: "sandbox",
  testedAt: "2026-10-04T12:00:00.000Z",
  ok,
  steps: [
    { step: "MERCHANT_CREDENTIALS", status: statuses[0], host: null, httpStatus: null, durationMs: 0, message: "m" },
    { step: "SOP_OAUTH", status: statuses[1], host: null, httpStatus: null, durationMs: 0, message: "m" },
    { step: "SOP_ACCESS_TOKEN", status: statuses[2], host: null, httpStatus: null, durationMs: 0, message: "m" },
  ],
})

describe("isTestFailure — mesma regra do servidor para `ok`", () => {
  it("NOT_CONFIGURED, SKIPPED e OK não são falha; todo o resto é", () => {
    for (const s of ["OK", "NOT_CONFIGURED", "SKIPPED"] as const) expect(isTestFailure(s)).toBe(false)
    for (const s of ["CREDENTIAL_REJECTED", "IP_NOT_ALLOWED", "UNAVAILABLE", "RATE_LIMITED", "REQUEST_REFUSED", "MISCONFIGURED"] as const) expect(isTestFailure(s)).toBe(true)
  })
})

describe("testVerdict", () => {
  it("ok do servidor manda", () => expect(testVerdict(result(["OK", "OK", "OK"], true))).toBe("ok"))
  it("qualquer falha real = failed, mesmo com outro passo OK", () => expect(testVerdict(result(["IP_NOT_ALLOWED", "OK", "OK"], false))).toBe("failed"))
  it("só NOT_CONFIGURED/SKIPPED = nada para testar (não é falha nem sucesso)", () => expect(testVerdict(result(["NOT_CONFIGURED", "NOT_CONFIGURED", "NOT_CONFIGURED"], false))).toBe("nothing-configured"))
})

describe("testSupportText", () => {
  it("IP: manda conferir a lista de IPs confiáveis do Site Cielo ANTES de trocar a credencial", () => {
    expect(testSupportText("IP_NOT_ALLOWED", "production")).toMatch(/lista de IPs confiáveis do Site Cielo antes de trocar a credencial/)
  })
  it("credencial recusada: lembra os dois servidores e cita o ambiente salvo e o outro", () => {
    const text = testSupportText("CREDENTIAL_REJECTED", "production")!
    expect(text).toMatch(/sandbox e produção são servidores separados/)
    expect(text).toMatch(/O ambiente salvo aqui é produção; se a credencial é de sandbox/)
  })
  it("OK e SKIPPED não têm orientação", () => {
    expect(testSupportText("OK", "sandbox")).toBeNull()
    expect(testSupportText("SKIPPED", "sandbox")).toBeNull()
  })
})
