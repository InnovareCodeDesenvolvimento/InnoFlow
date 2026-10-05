import { describe, expect, it } from 'vitest'
import { confirmRefundSchema, referenciaParecePessoalOuCartao } from '../../src/api/schemas/paymentReversals.schema'

describe('confirmRefundSchema (L1.8) — referência do comprovante', () => {
  const ok = (proofReference: unknown) => confirmRefundSchema.safeParse({ proofReference, currentPassword: 'x' }).success

  it('aceita códigos de comprovante (5 a 120; letras, dígitos . _ - / # :) e apara os espaços das pontas', () => {
    for (const v of ['ABCDE', 'A'.repeat(120), 'NSU:123456/2026#7', 'comp.2026-10_05', '4111111111111112']) expect(ok(v), v).toBe(true)
    expect(confirmRefundSchema.parse({ proofReference: '  ABCDE-1  ', currentPassword: 'x' }).proofReference).toBe('ABCDE-1')
  })

  it('recusa curto, longo, vazio, com espaço no meio, e-mail, CPF mascarado, cartão (Luhn), tipo errado e campo extra', () => {
    for (const v of ['ABCD', 'A'.repeat(121), '', '     ', 'Joao Silva', 'a@b.co', '123.456.789-09', '4111111111111111', '5500000000000004', 'AB\nCDE', 12345678, null, undefined]) expect(ok(v), String(v)).toBe(false)
    expect(confirmRefundSchema.safeParse({ proofReference: 'ABCDE', currentPassword: 'x', status: 'CONFIRMED' }).success).toBe(false)
    expect(confirmRefundSchema.safeParse({ proofReference: 'ABCDE' }).success).toBe(false) // senha obrigatória
  })

  it('referenciaParecePessoalOuCartao: Luhn só vale para 13 a 19 dígitos seguidos', () => {
    expect(referenciaParecePessoalOuCartao('4111111111111111')).toBe(true)
    expect(referenciaParecePessoalOuCartao('4111111111111112')).toBe(false) // 16 dígitos mas não passa no Luhn
    expect(referenciaParecePessoalOuCartao('411111111111')).toBe(false) // 12 dígitos: abaixo do mínimo de um PAN
    expect(referenciaParecePessoalOuCartao('123.456.789-09')).toBe(true)
  })
})
