import { z } from 'zod'
import { validarENormalizarCnpj } from '../../core/legal/cnpj'
import { normalizarSite, textoDeUmaLinha } from '../../core/legal/termos'

/**
 * `PUT /api/admin/company-profile` — contrato literal em `docs/CONTRATO-EMPRESA-ADMIN.md`.
 * Campo AUSENTE = "não mexer"; `null` (ou texto vazio) = "limpar o campo". `.strict()`: campo desconhecido é 400 (typo nunca é ignorado em silêncio).
 * Os valores saem NORMALIZADOS do schema (CNPJ só com 14 caracteres, site canônico, e-mail em minúsculas, texto de uma linha), então o serviço grava exatamente o que passou aqui.
 */

/** Texto livre de UMA linha com limite; vazio/null => `null` (limpa). */
function texto(max: number) {
  return z
    .union([z.string().max(2000), z.null()])
    .transform((v) => textoDeUmaLinha(v))
    .refine((v) => v === null || v.length <= max, { message: `Use no máximo ${max} caracteres.` })
    .optional()
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const email = z
  .union([z.string().max(2000), z.null()])
  .transform((v) => textoDeUmaLinha(v)?.toLowerCase() ?? null)
  .refine((v) => v === null || (v.length <= 180 && EMAIL.test(v)), { message: 'E-mail inválido.' })
  .optional()

const cnpj = z
  .union([z.string().max(100), z.null()])
  .transform((v, ctx) => {
    const t = textoDeUmaLinha(v)
    if (t === null) return null
    const n = validarENormalizarCnpj(t)
    if (n === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CNPJ inválido: confira os números (os dois últimos são os dígitos verificadores).' })
      return z.NEVER
    }
    return n
  })
  .optional()

const telefone = z
  .union([z.string().max(100), z.null()])
  .transform((v) => textoDeUmaLinha(v))
  .refine((v) => v === null || (/^[0-9+()\s.-]{8,30}$/.test(v) && (v.match(/\d/g)?.length ?? 0) >= 8), { message: 'Telefone inválido: use números, DDD e, se quiser, +55 ( ) - e espaços (de 8 a 30 caracteres).' })
  .optional()

const site = z
  .union([z.string().max(2000), z.null()])
  .transform((v, ctx) => {
    const t = textoDeUmaLinha(v)
    if (t === null) return null
    const u = normalizarSite(t)
    if (u === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Endereço do site inválido: use algo como https://www.suaempresa.com.br.' })
      return z.NEVER
    }
    return u
  })
  .optional()

/** Versão dos documentos: letras, números, ponto, hífen e sublinhado (cabe na coluna e na URL); vazio/null => volta a valer a env `LEGAL_*_VERSION`. */
const versao = z
  .union([z.string().max(100), z.null()])
  .transform((v) => textoDeUmaLinha(v))
  .refine((v) => v === null || /^[A-Za-z0-9._-]{1,32}$/.test(v), { message: 'Versão inválida: use até 32 caracteres entre letras, números, ponto, hífen e sublinhado (ex.: 2026-10-06).' })
  .optional()

export const updateCompanyProfileSchema = z
  .object({
    legalName: texto(160),
    tradeName: texto(120),
    cnpj,
    supportEmail: email,
    supportPhone: telefone,
    address: texto(300),
    website: site,
    dpoName: texto(120),
    dpoEmail: email,
    termsVersion: versao,
    privacyVersion: versao,
    /** Obrigatório (`true`) quando o PUT MUDA a versão efetiva dos Termos ou da Privacidade: todos os motoristas voltam a `upToDate=false` e precisam aceitar de novo. */
    confirmVersionChange: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.entries(b).some(([k, v]) => k !== 'confirmVersionChange' && v !== undefined), { message: 'Informe ao menos um campo para alterar.' })

export type UpdateCompanyProfileBody = z.infer<typeof updateCompanyProfileSchema>
