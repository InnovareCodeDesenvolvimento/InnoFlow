import { describe, expect, it } from 'vitest'
import { resolverDadosLegais, type FonteEnvLegal, type LinhaPerfilEmpresa } from '../../src/core/legal/dadosLegais'

const ENV: FonteEnvLegal = {
  LEGAL_TERMS_VERSION: 'env-termos-1',
  LEGAL_PRIVACY_VERSION: 'env-priv-1',
  LEGAL_COMPANY_NAME: 'Empresa da Env Ltda',
  LEGAL_COMPANY_CNPJ: '11222333000181',
  LEGAL_SUPPORT_EMAIL: 'suporte-env@empresa.com.br',
  LEGAL_SUPPORT_PHONE: '(11) 4000-0000',
  LEGAL_DPO_EMAIL: 'dpo-env@empresa.com.br',
}

function linha(parcial: Partial<LinhaPerfilEmpresa> = {}): LinhaPerfilEmpresa {
  return {
    legalName: null,
    tradeName: null,
    cnpj: null,
    supportEmail: null,
    supportPhone: null,
    address: null,
    website: null,
    dpoName: null,
    dpoEmail: null,
    termsVersion: null,
    privacyVersion: null,
    companyDataSavedAt: null,
    updatedByUserId: null,
    updatedAt: new Date('2026-10-06T12:00:00Z'),
    ...parcial,
  }
}

describe('resolverDadosLegais — painel > env', () => {
  it('sem linha: tudo vem da env (fonte "env") e campos inválidos da env são apontados', () => {
    const r = resolverDadosLegais(null, { ...ENV, LEGAL_DPO_EMAIL: 'isto-nao-e-email' })
    expect(r.fonteEmpresa).toBe('env')
    expect(r.fonteVersoes).toEqual({ terms: 'env', privacy: 'env' })
    expect(r.versoes).toEqual({ termsVersion: 'env-termos-1', privacyVersion: 'env-priv-1' })
    expect(r.empresa).toMatchObject({ name: 'Empresa da Env Ltda', cnpj: '11.222.333/0001-81', supportEmail: 'suporte-env@empresa.com.br', dpoEmail: null })
    expect(r.camposInvalidosDaEnv).toEqual(['dpoEmail'])
    expect(r.atualizadoEm).toBeNull()
  })

  it('o painel assumiu a empresa: TODOS os campos vêm do painel e campo vazio NÃO é completado pela env', () => {
    const r = resolverDadosLegais(linha({ companyDataSavedAt: new Date(), legalName: 'Razão do Painel Ltda', cnpj: '12ABC34501DE35' }), ENV)
    expect(r.fonteEmpresa).toBe('db')
    expect(r.empresa).toMatchObject({ name: 'Razão do Painel Ltda', cnpj: '12.ABC.345/01DE-35', supportEmail: null, supportPhone: null, dpoEmail: null, tradeName: null })
    expect(r.camposInvalidosDaEnv).toEqual([]) // a env nem é lida
  })

  it('só as VERSÕES foram salvas (companyDataSavedAt nulo): a empresa continua vindo da env', () => {
    const r = resolverDadosLegais(linha({ termsVersion: 'painel-2' }), ENV)
    expect(r.fonteEmpresa).toBe('env')
    expect(r.empresa.name).toBe('Empresa da Env Ltda')
    expect(r.versoes).toEqual({ termsVersion: 'painel-2', privacyVersion: 'env-priv-1' })
    expect(r.fonteVersoes).toEqual({ terms: 'db', privacy: 'env' })
  })

  it('versões são por campo: a de um documento no painel não arrasta a do outro', () => {
    const r = resolverDadosLegais(linha({ privacyVersion: 'painel-priv-9' }), ENV)
    expect(r.versoes).toEqual({ termsVersion: 'env-termos-1', privacyVersion: 'painel-priv-9' })
  })

  it('o nome público cai no fantasia quando não há razão social; cada campo do painel aparece', () => {
    const r = resolverDadosLegais(
      linha({ companyDataSavedAt: new Date(), tradeName: 'InnoFlow', address: 'Rua A, 10', website: 'https://innoflow.com.br', dpoName: 'Maria', dpoEmail: 'dpo@innoflow.com.br', supportPhone: '+55 11 4000-0000' }),
      ENV,
    )
    expect(r.empresa).toMatchObject({ name: 'InnoFlow', tradeName: 'InnoFlow', address: 'Rua A, 10', website: 'https://innoflow.com.br', dpoName: 'Maria', dpoEmail: 'dpo@innoflow.com.br', supportPhone: '+55 11 4000-0000' })
  })
})
