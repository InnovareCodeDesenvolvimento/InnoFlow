import { describe, expect, it } from 'vitest'
import { avaliarConsentimento, normalizarDadosDaEmpresa, type AceiteRegistrado } from '../../src/core/legal/termos'

/** L1.9 — regras PURAS dos termos: quem está em dia e os dados públicos da empresa (vazio = null, nunca inventado). */

const VIGENTES = { termsVersion: 'T2', privacyVersion: 'P2' }
const aceite = (kind: AceiteRegistrado['kind'], version: string, iso: string): AceiteRegistrado => ({ kind, version, acceptedAt: new Date(iso) })

describe('avaliarConsentimento', () => {
  it('quem nunca aceitou nada (conta anterior ao L1.9) NÃO está em dia — não se fabrica consentimento retroativo', () => {
    expect(avaliarConsentimento(VIGENTES, [])).toEqual({ termsVersion: null, privacyVersion: null, acceptedAt: null, upToDate: false })
  })

  it('em dia só com a versão VIGENTE dos DOIS documentos', () => {
    const ok = avaliarConsentimento(VIGENTES, [aceite('TERMS', 'T2', '2026-10-02T10:00:00Z'), aceite('PRIVACY', 'P2', '2026-10-02T10:00:00Z')])
    expect(ok.upToDate).toBe(true)
    expect(ok).toMatchObject({ termsVersion: 'T2', privacyVersion: 'P2', acceptedAt: '2026-10-02T10:00:00.000Z' })

    expect(avaliarConsentimento(VIGENTES, [aceite('TERMS', 'T2', '2026-10-02T10:00:00Z')]).upToDate).toBe(false) // falta a privacidade
    expect(avaliarConsentimento(VIGENTES, [aceite('TERMS', 'T1', '2026-09-01T10:00:00Z'), aceite('PRIVACY', 'P2', '2026-10-02T10:00:00Z')]).upToDate).toBe(false) // termos antigos
  })

  it('a "última versão aceita" é a de acceptedAt mais recente; a versão vigente aceita em qualquer data vale', () => {
    const r = avaliarConsentimento(VIGENTES, [
      aceite('TERMS', 'T1', '2026-09-01T10:00:00Z'),
      aceite('TERMS', 'T2', '2026-10-03T10:00:00Z'),
      aceite('PRIVACY', 'P1', '2026-09-01T10:00:00Z'),
      aceite('PRIVACY', 'P2', '2026-10-04T10:00:00Z'),
    ])
    expect(r).toEqual({ termsVersion: 'T2', privacyVersion: 'P2', acceptedAt: '2026-10-04T10:00:00.000Z', upToDate: true })
  })
})

describe('normalizarDadosDaEmpresa', () => {
  it('nada informado = tudo null (sem placeholder inventado) e nada inválido', () => {
    expect(normalizarDadosDaEmpresa({})).toEqual({ dados: { name: null, cnpj: null, supportEmail: null, supportPhone: null, dpoEmail: null }, invalidos: [] })
    expect(normalizarDadosDaEmpresa({ name: '  ', cnpj: '', supportEmail: ' ' }).dados.name).toBeNull()
  })

  it('valores válidos saem aparados e o CNPJ sai formatado', () => {
    const { dados, invalidos } = normalizarDadosDaEmpresa({ name: ' InnoFlow Ltda ', cnpj: '11222333000181', supportEmail: 'suporte@innoflow.com.br', supportPhone: '(11) 4000-0000', dpoEmail: 'dpo@innoflow.com.br' })
    expect(invalidos).toEqual([])
    expect(dados).toEqual({ name: 'InnoFlow Ltda', cnpj: '11.222.333/0001-81', supportEmail: 'suporte@innoflow.com.br', supportPhone: '(11) 4000-0000', dpoEmail: 'dpo@innoflow.com.br' })
  })

  it('e-mail/CNPJ malformados viram null e são APONTADOS (só o nome do campo) — nunca derrubam nada', () => {
    const { dados, invalidos } = normalizarDadosDaEmpresa({ cnpj: '11.222.333/0001-82', supportEmail: 'sem-arroba', dpoEmail: 'x@y' })
    expect(dados).toMatchObject({ cnpj: null, supportEmail: null, dpoEmail: null })
    expect([...invalidos].sort()).toEqual(['cnpj', 'dpoEmail', 'supportEmail'])
  })
})
