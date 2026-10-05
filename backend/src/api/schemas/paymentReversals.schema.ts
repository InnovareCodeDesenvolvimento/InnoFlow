import { z } from 'zod'

/**
 * Estorno e chargeback (L1.8). Contrato LITERAL: `CreateSessionRefundRequest`, `CreateChargebackRequest`, `UpdateChargebackRequest` em `frontend/src/types/api.ts`.
 * `.strict()` em tudo: campo desconhecido é 400 (o ator, o pagador e o estado NUNCA vêm do cliente).
 */

/** Teto de sanidade por lançamento (R$ 100.000,00): o teto REAL é o valor cobrado da sessão (regra de negócio + trigger do banco). */
const VALOR_MAXIMO_CENTS = 10_000_000

const amountCents = z.number({ invalid_type_error: 'Informe o valor em centavos.' }).int('O valor deve ser inteiro (centavos).').positive('O valor deve ser maior que zero.').max(VALOR_MAXIMO_CENTS)

/** Sem caractere de controle (quebra de linha/tab incluídos): o texto vai para tela e relatório. */
const semControle = (v: string) => ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

const textoCurto = (min: number, max: number, mensagem: string) => z.string().trim().min(min, mensagem).max(max).refine(semControle, { message: 'Não use quebra de linha nem caracteres de controle.' })

const senhaAtual = z.string().min(1, 'Informe a sua senha.').max(200)

const dataIso = (nome: string) => z.string().datetime({ offset: true, message: `${nome}: use uma data ISO 8601 (ex.: 2026-10-05T12:00:00Z).` })

export const createSessionRefundSchema = z
  .object({
    amountCents,
    reason: textoCurto(10, 500, 'Explique o motivo (mínimo 10 caracteres).'),
    destination: z.enum(['WALLET', 'CARD_VIA_PORTAL']),
    portalReference: textoCurto(1, 120, 'Referência inválida.').optional(),
    currentPassword: senhaAtual,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.portalReference !== undefined && v.destination !== 'CARD_VIA_PORTAL') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['portalReference'], message: 'A referência do portal só vale para devolução no cartão (CARD_VIA_PORTAL).' })
    }
  })
export type CreateSessionRefundInput = z.infer<typeof createSessionRefundSchema>

export const cancelRefundSchema = z.object({ currentPassword: senhaAtual }).strict()
export type CancelRefundInput = z.infer<typeof cancelRefundSchema>

/**
 * Referência do COMPROVANTE do estorno no portal da Cielo (confirmação manual). Vai para a linha do estorno e para a auditoria, então é validada como CÓDIGO, não como texto livre:
 * só letras, dígitos e . _ - / # : (sem espaço nem @ — barra nome e e-mail de quem escreve uma frase em vez do código), 5 a 120. Recusa também o que parece dado pessoal/de cartão colado
 * por engano: CPF com máscara e sequência numérica de 13 a 19 dígitos que passa no Luhn (número de cartão).
 */
const REFERENCIA_COMPROVANTE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/
const CPF_COM_MASCARA = /\d{3}\.\d{3}\.\d{3}-\d{2}/
const NUMERO_LONGO = /^\d{13,19}$/

function passaNoLuhn(digitos: string): boolean {
  let soma = 0
  for (let i = 0; i < digitos.length; i += 1) {
    let d = Number(digitos[digitos.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    soma += d
  }
  return soma % 10 === 0
}

/** Exportada para o teste do formato (a regra mora num lugar só). */
export function referenciaParecePessoalOuCartao(v: string): boolean {
  if (CPF_COM_MASCARA.test(v)) return true
  return NUMERO_LONGO.test(v) && passaNoLuhn(v)
}

export const confirmRefundSchema = z
  .object({
    proofReference: z
      .string({ required_error: 'Informe a referência do comprovante do portal da Cielo.', invalid_type_error: 'A referência do comprovante deve ser um texto.' })
      .trim()
      .min(5, 'A referência do comprovante precisa ter ao menos 5 caracteres.')
      .max(120, 'A referência do comprovante pode ter no máximo 120 caracteres.')
      .regex(REFERENCIA_COMPROVANTE, 'Use só o código do comprovante (letras, números e . _ - / # :), sem espaços nem e-mail.')
      .refine((v) => !referenciaParecePessoalOuCartao(v), { message: 'Isto parece um CPF ou número de cartão: informe só a referência do comprovante.' }),
    currentPassword: senhaAtual,
  })
  .strict()
export type ConfirmRefundInput = z.infer<typeof confirmRefundSchema>

export const createChargebackSchema = z
  .object({
    amountCents,
    notifiedAt: dataIso('notifiedAt'),
    caseReference: textoCurto(1, 120, 'Informe a referência do caso na Cielo.'),
    reasonCode: textoCurto(1, 40, 'Código inválido.').optional(),
    responseDeadline: dataIso('responseDeadline').optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const aviso = new Date(v.notifiedAt)
    // Chargeback "do futuro" é erro de digitação (e o prazo do banco compara com este aviso). Tolerância de 5 min de relógio.
    if (aviso.getTime() > Date.now() + 5 * 60_000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notifiedAt'], message: 'A data do aviso não pode estar no futuro.' })
    if (v.responseDeadline && new Date(v.responseDeadline).getTime() < aviso.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['responseDeadline'], message: 'O prazo de resposta não pode ser anterior ao aviso.' })
    }
  })
export type CreateChargebackInput = z.infer<typeof createChargebackSchema>

export const updateChargebackSchema = z
  .object({
    outcome: z.enum(['WON', 'LOST', 'ACCEPTED']),
    debtPolicy: z.enum(['CREATE_DEBT', 'ABSORB']).optional(),
    currentPassword: senhaAtual,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.debtPolicy === 'CREATE_DEBT' && v.outcome === 'WON') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['debtPolicy'], message: 'Chargeback ganho não gera dívida: use apenas em LOST ou ACCEPTED.' })
    }
  })
export type UpdateChargebackInput = z.infer<typeof updateChargebackSchema>

export const unblockCardSchema = z
  .object({
    reason: textoCurto(10, 500, 'Explique por que o cartão volta a ser liberado (mínimo 10 caracteres).'),
    currentPassword: senhaAtual,
  })
  .strict()
export type UnblockCardInput = z.infer<typeof unblockCardSchema>

export const listChargebacksQuerySchema = z.object({
  outcome: z.enum(['OPEN', 'WON', 'LOST', 'ACCEPTED']).optional(),
  paymentIntentId: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListChargebacksQuery = z.infer<typeof listChargebacksQuerySchema>

export const listRefundsQuerySchema = z.object({
  status: z.enum(['PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListRefundsQuery = z.infer<typeof listRefundsQuerySchema>
