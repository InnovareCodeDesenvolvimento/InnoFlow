import { describe, expect, it } from "vitest"
import { AxiosError, type AxiosResponse } from "axios"
import {
  buildCompanyPayload,
  describeCompanyChanges,
  formatCnpj,
  hasCompanyChanges,
  isValidCnpj,
  normalizeCnpj,
  normalizeWebsite,
  parseCompanyError,
  validateCompanyDraft,
  versionWouldChange,
} from "./companyProfile"
import type { CompanyProfileDTO } from "@/types/api"

const DTO: CompanyProfileDTO = {
  source: "db",
  profile: {
    legalName: "InnoFlow Ltda",
    tradeName: null,
    cnpj: "11.222.333/0001-81",
    supportEmail: "suporte@innoflow.example",
    supportPhone: null,
    address: null,
    website: "https://www.innoflow.example",
    dpoName: null,
    dpoEmail: null,
  },
  versions: { termsVersion: "2026-10-01", privacyVersion: "2026-09-01", termsSource: "db", privacySource: "env", envTermsVersion: "2026-09-01", envPrivacyVersion: "2026-09-01" },
  invalidEnvFields: [],
  updatedAt: "2026-10-04T13:20:00.000Z",
}

function httpError(status: number, data: unknown): AxiosError {
  return new AxiosError("falhou", String(status), undefined, undefined, { status, data, headers: {}, statusText: "", config: {} as never } as AxiosResponse)
}

describe("CNPJ (espelha o servidor: numérico e alfanumérico, módulo 11)", () => {
  it("aceita numérico com ou sem pontuação e alfanumérico (vetor do teste do backend)", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true)
    expect(isValidCnpj("11222333000181")).toBe(true)
    expect(isValidCnpj("12.ABC.345/01DE-35")).toBe(true)
    expect(isValidCnpj("12.abc.345/01de-35")).toBe(true)
  })

  it("recusa dígito verificador errado, repetido, tamanho errado e caractere estranho", () => {
    expect(isValidCnpj("11.222.333/0001-82")).toBe(false)
    expect(isValidCnpj("00.000.000/0000-00")).toBe(false)
    expect(isValidCnpj("AAAAAAAAAAAAAA")).toBe(false)
    expect(isValidCnpj("1122233300018")).toBe(false)
    expect(isValidCnpj("12.ABC.345/01DE-3A")).toBe(false)
    expect(isValidCnpj("11.222.333/0001-8!")).toBe(false)
  })

  it("normaliza e formata", () => {
    expect(normalizeCnpj(" 12.abc.345/01de-35 ")).toBe("12ABC34501DE35")
    expect(formatCnpj("12ABC34501DE35")).toBe("12.ABC.345/01DE-35")
  })
})

describe("site", () => {
  it("completa https:// e tira a barra final", () => {
    expect(normalizeWebsite("www.innoflow.example")).toBe("https://www.innoflow.example")
    expect(normalizeWebsite("https://innoflow.example/")).toBe("https://innoflow.example")
    expect(normalizeWebsite("https://innoflow.example/sobre")).toBe("https://innoflow.example/sobre")
  })
  it("recusa host sem ponto, credenciais, espaço e esquema que não é http", () => {
    expect(normalizeWebsite("localhost")).toBeNull()
    expect(normalizeWebsite("https://user:pw@innoflow.example")).toBeNull()
    expect(normalizeWebsite("inno flow.com")).toBeNull()
    expect(normalizeWebsite("ftp://innoflow.example")).toBeNull()
  })
})

describe("validateCompanyDraft", () => {
  it("só avalia o que foi mexido; vazio é válido (limpa o campo)", () => {
    expect(validateCompanyDraft({})).toEqual({})
    expect(validateCompanyDraft({ cnpj: "", supportEmail: "", website: "" })).toEqual({})
  })
  it("acusa cada campo inválido pelo nome", () => {
    const errors = validateCompanyDraft({ cnpj: "11.222.333/0001-82", supportEmail: "sem-arroba", supportPhone: "123", website: "x", termsVersion: "versão com espaço", legalName: "x".repeat(161) })
    expect(Object.keys(errors).sort()).toEqual(["cnpj", "legalName", "supportEmail", "supportPhone", "termsVersion", "website"])
  })
})

describe("buildCompanyPayload (só o diff)", () => {
  it("sem rascunho ou igual ao salvo, não manda nada", () => {
    expect(buildCompanyPayload(DTO, {})).toEqual({})
    // mesmo CNPJ sem pontuação, e-mail com outra caixa e espaços sobrando: não é alteração
    expect(buildCompanyPayload(DTO, { cnpj: "11222333000181", supportEmail: " SUPORTE@innoflow.example ", legalName: "InnoFlow   Ltda" })).toEqual({})
  })
  it("campo alterado vai; campo esvaziado vai como null (limpa); campo vazio que já era vazio não vai", () => {
    expect(buildCompanyPayload(DTO, { tradeName: "Inno", supportEmail: "", dpoName: "" })).toEqual({ tradeName: "Inno", supportEmail: null })
  })
  it("versão digitada igual à vigente do painel não é alteração; em branco onde vale a do painel limpa", () => {
    expect(buildCompanyPayload(DTO, { termsVersion: "2026-10-01" })).toEqual({})
    expect(buildCompanyPayload(DTO, { termsVersion: "" })).toEqual({ termsVersion: null })
    // a versão de privacidade vem do servidor (env): digitar o mesmo valor que ela já tem grava (passa a ser do painel) e não muda a versão efetiva
    expect(buildCompanyPayload(DTO, { privacyVersion: "2026-09-01" })).toEqual({ privacyVersion: "2026-09-01" })
    expect(versionWouldChange(DTO, { privacyVersion: "2026-09-01" })).toBe(false)
  })
  it("hasCompanyChanges ignora confirmVersionChange; describe lista de -> para", () => {
    expect(hasCompanyChanges({ confirmVersionChange: true })).toBe(false)
    const payload = buildCompanyPayload(DTO, { tradeName: "Inno", supportEmail: "" })
    expect(hasCompanyChanges(payload)).toBe(true)
    expect(describeCompanyChanges(DTO, payload)).toEqual([
      { key: "tradeName", label: "Nome fantasia", from: "(vazio)", to: "Inno" },
      { key: "supportEmail", label: "E-mail de suporte", from: "suporte@innoflow.example", to: "(vazio)" },
    ])
  })
})

describe("versionWouldChange", () => {
  it("nova versão diferente da vigente muda; igual não", () => {
    expect(versionWouldChange(DTO, { termsVersion: "2026-11-01" })).toBe(true)
    expect(versionWouldChange(DTO, { termsVersion: "2026-10-01" })).toBe(false)
    expect(versionWouldChange(DTO, { tradeName: "Inno" })).toBe(false)
  })
  it("limpar (null) volta à versão do servidor: só muda se ela difere da vigente", () => {
    expect(versionWouldChange(DTO, { termsVersion: null })).toBe(true) // vigente 2026-10-01, servidor 2026-09-01
    expect(versionWouldChange(DTO, { privacyVersion: null })).toBe(false) // já vale a do servidor
  })
})

describe("parseCompanyError (por code, nunca pelo texto do servidor)", () => {
  it("409 VERSION_CHANGE_NOT_CONFIRMED traz o resumo e o número de motoristas", () => {
    const parsed = parseCompanyError(
      httpError(409, {
        code: "VERSION_CHANGE_NOT_CONFIRMED",
        error: "texto do servidor que não deve aparecer",
        details: [{ field: "confirmVersionChange", reason: "REQUIRED_TRUE", currentTermsVersion: "A", currentPrivacyVersion: "B", newTermsVersion: "C", newPrivacyVersion: "B", driversAffected: 42 }],
      }),
    )
    expect(parsed.code).toBe("VERSION_CHANGE_NOT_CONFIRMED")
    expect(parsed.versionChange).toMatchObject({ currentTermsVersion: "A", newTermsVersion: "C", driversAffected: 42 })
    expect(parsed.message).not.toContain("servidor que não")
  })
  it("400 VALIDATION_ERROR aponta os campos; 429, 503, 401, 403 e rede têm texto próprio", () => {
    expect(parseCompanyError(httpError(400, { code: "VALIDATION_ERROR", details: [{ path: "cnpj", message: "x" }, { path: "desconhecido", message: "y" }] })).fields).toEqual(["cnpj"])
    expect(parseCompanyError(httpError(429, { code: "RATE_LIMITED" })).message).toMatch(/Aguarde/)
    expect(parseCompanyError(httpError(503, {})).message).toMatch(/Nada foi alterado/)
    expect(parseCompanyError(httpError(401, { code: "UNAUTHORIZED" })).draftKept).toBe(false)
    expect(parseCompanyError(httpError(403, { code: "FORBIDDEN" })).message).toMatch(/administradores/)
    expect(parseCompanyError(new Error("rede")).message).toMatch(/servidor/)
  })
})
