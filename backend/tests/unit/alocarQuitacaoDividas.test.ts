import { describe, expect, it } from 'vitest'
import { alocarQuitacaoDividas } from '../../src/core/pagamentos/alocarQuitacaoDividas'

describe('alocarQuitacaoDividas', () => {
  it('sem dívidas: tudo vira restante (saldo livre)', () => {
    const r = alocarQuitacaoDividas(5_000, [])
    expect(r).toEqual({ alocacoes: [], restanteCents: 5_000, totalAlocadoCents: 0 })
  })

  it('crédito cobre TODAS as dívidas: quita todas na ordem recebida, sobra o resto como saldo livre', () => {
    const r = alocarQuitacaoDividas(5_000, [
      { id: 'd1', amountCents: 1_000 },
      { id: 'd2', amountCents: 1_500 },
    ])
    expect(r.alocacoes).toEqual([
      { debtId: 'd1', amountCents: 1_000 },
      { debtId: 'd2', amountCents: 1_500 },
    ])
    expect(r.totalAlocadoCents).toBe(2_500)
    expect(r.restanteCents).toBe(2_500)
  })

  it('crédito cobre a 1ª dívida INTEIRA mas não a 2ª: para no meio, nunca quita parcial', () => {
    const r = alocarQuitacaoDividas(1_200, [
      { id: 'antiga', amountCents: 1_000 },
      { id: 'nova', amountCents: 1_500 },
    ])
    expect(r.alocacoes).toEqual([{ debtId: 'antiga', amountCents: 1_000 }])
    expect(r.restanteCents).toBe(200) // sobra como saldo livre — NUNCA quita 200 dos 1500 da dívida "nova"
  })

  it('crédito EXATAMENTE igual a uma dívida: quita e não sobra nada', () => {
    const r = alocarQuitacaoDividas(1_000, [{ id: 'd1', amountCents: 1_000 }])
    expect(r.alocacoes).toEqual([{ debtId: 'd1', amountCents: 1_000 }])
    expect(r.restanteCents).toBe(0)
  })

  it('crédito não cobre nem a mais antiga: nenhuma alocação, tudo vira restante', () => {
    const r = alocarQuitacaoDividas(300, [{ id: 'd1', amountCents: 1_000 }])
    expect(r.alocacoes).toEqual([])
    expect(r.restanteCents).toBe(300)
  })

  it('respeita a ORDEM recebida (quem chama é responsável por ordenar mais antiga primeiro) — não reordena por valor', () => {
    // Se a lista chegasse ordenada por valor em vez de idade, o resultado mudaria — prova que a função NÃO reordena sozinha.
    const r = alocarQuitacaoDividas(1_000, [
      { id: 'cara-mas-antiga', amountCents: 1_500 },
      { id: 'barata-mas-nova', amountCents: 500 },
    ])
    expect(r.alocacoes).toEqual([]) // não pula a 1ª (cara) para caber a 2ª (barata) — para na 1ª que não cabe
    expect(r.restanteCents).toBe(1_000)
  })
})
