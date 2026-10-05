import { describe, expect, it } from 'vitest'
import { avaliarConsentimento, normalizarDadosDaEmpresa, normalizarSite, textoDeUmaLinha, type AceiteRegistrado } from '../../src/core/legal/termos'

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
    expect(normalizarDadosDaEmpresa({})).toEqual({
      dados: { name: null, cnpj: null, supportEmail: null, supportPhone: null, dpoEmail: null, tradeName: null, address: null, website: null, dpoName: null },
      invalidos: [],
    })
    expect(normalizarDadosDaEmpresa({ name: '  ', cnpj: '', supportEmail: ' ' }).dados.name).toBeNull()
  })

  it('valores válidos saem aparados e o CNPJ sai formatado', () => {
    const { dados, invalidos } = normalizarDadosDaEmpresa({ name: ' InnoFlow Ltda ', cnpj: '11222333000181', supportEmail: 'suporte@innoflow.com.br', supportPhone: '(11) 4000-0000', dpoEmail: 'dpo@innoflow.com.br' })
    expect(invalidos).toEqual([])
    expect(dados).toEqual({
      name: 'InnoFlow Ltda',
      cnpj: '11.222.333/0001-81',
      supportEmail: 'suporte@innoflow.com.br',
      supportPhone: '(11) 4000-0000',
      dpoEmail: 'dpo@innoflow.com.br',
      tradeName: null,
      address: null,
      website: null,
      dpoName: null,
    })
  })

  it('campos novos: fantasia, endereço, site e encarregado; sem razão social o "name" cai no fantasia; quebra de linha vira espaço', () => {
    const { dados, invalidos } = normalizarDadosDaEmpresa({ tradeName: 'InnoFlow', address: 'Rua A, 10\nSala 2', website: 'innoflow.com.br', dpoName: ' Maria Souza ', cnpj: '12.abc.345/01de-35' })
    expect(invalidos).toEqual([])
    expect(dados).toMatchObject({ name: 'InnoFlow', tradeName: 'InnoFlow', address: 'Rua A, 10 Sala 2', website: 'https://innoflow.com.br', dpoName: 'Maria Souza', cnpj: '12.ABC.345/01DE-35' })
    expect(normalizarDadosDaEmpresa({ name: 'Razão Ltda', tradeName: 'Fantasia' }).dados.name).toBe('Razão Ltda')
  })

  it('site inválido vira null e é apontado', () => {
    const { dados, invalidos } = normalizarDadosDaEmpresa({ website: 'javascript:alert(1)' })
    expect(dados.website).toBeNull()
    expect(invalidos).toEqual(['website'])
  })

  it('e-mail/CNPJ malformados viram null e são APONTADOS (só o nome do campo) — nunca derrubam nada', () => {
    const { dados, invalidos } = normalizarDadosDaEmpresa({ cnpj: '11.222.333/0001-82', supportEmail: 'sem-arroba', dpoEmail: 'x@y' })
    expect(dados).toMatchObject({ cnpj: null, supportEmail: null, dpoEmail: null })
    expect([...invalidos].sort()).toEqual(['cnpj', 'dpoEmail', 'supportEmail'])
  })
})

describe('normalizarSite / textoDeUmaLinha', () => {
  it('aceita http(s) e assume https sem esquema; tira a barra final só do domínio puro', () => {
    expect(normalizarSite('https://www.innoflow.com.br/')).toBe('https://www.innoflow.com.br')
    expect(normalizarSite('www.innoflow.com.br')).toBe('https://www.innoflow.com.br')
    expect(normalizarSite('http://innoflow.com.br/ajuda?x=1')).toBe('http://innoflow.com.br/ajuda?x=1')
    expect(normalizarSite('innoflow.com.br:8443/a')).toBe('https://innoflow.com.br:8443/a')
  })

  it('recusa esquemas perigosos, credencial embutida, host sem ponto, espaço e texto enorme', () => {
    for (const ruim of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://innoflow.com.br', 'mailto:a@b.com', 'https://user:senha@innoflow.com.br', 'https://localhost', 'http://innoflow', 'inno flow.com.br', 'https://' + 'a'.repeat(200) + '.com', '']) {
      expect(normalizarSite(ruim), ruim).toBeNull()
    }
  })

  it('textoDeUmaLinha: controles viram espaço, bordas aparadas, vazio/não-texto => null', () => {
    expect(textoDeUmaLinha('  a\r\nb\tc  ')).toBe('a b c')
    expect(textoDeUmaLinha('   ')).toBeNull()
    expect(textoDeUmaLinha(undefined)).toBeNull()
    expect(textoDeUmaLinha(null)).toBeNull()
  })
})
