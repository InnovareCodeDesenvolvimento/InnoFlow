import { env } from '../../lib/env'
import type { DadosLegaisEfetivos, FonteDoDado, LinhaPerfilEmpresa } from '../../core/legal/dadosLegais'

/**
 * DTO da tela "Dados da empresa" (`GET/PUT /api/admin/company-profile`). Contrato literal em `docs/CONTRATO-EMPRESA-ADMIN.md`.
 * Nada aqui é segredo (tudo aparece na página pública de termos/rodapé/e-mails), então tudo volta em claro. `profile` traz o que o dono DIGITOU (a razão social verdadeira, não o
 * "nome de exibição" com fallback para o fantasia que a rota pública usa).
 */
export interface CompanyProfileDto {
  /** `db` = o painel já assumiu os dados da empresa; `env` = nada salvo, valem as variáveis `LEGAL_*` do deploy (reserva). */
  source: FonteDoDado
  profile: {
    legalName: string | null
    tradeName: string | null
    /** Formatado `00.000.000/0000-00` (ou alfanumérico, mesma máscara). O PUT aceita com ou sem pontuação. */
    cnpj: string | null
    supportEmail: string | null
    supportPhone: string | null
    address: string | null
    website: string | null
    dpoName: string | null
    dpoEmail: string | null
  }
  versions: {
    /** Versões VIGENTES agora (o que o front manda em `acceptedTermsVersion` e o que `GET /api/me/consents` compara). */
    termsVersion: string
    privacyVersion: string
    termsSource: FonteDoDado
    privacySource: FonteDoDado
    /** A versão que vale se o campo do painel for limpo (`null`): a variável `LEGAL_*_VERSION` do deploy ou o padrão do código. */
    envTermsVersion: string
    envPrivacyVersion: string
  }
  /** Campos da ENV com valor inválido (ficam vazios na página pública). Só aparece enquanto `source = env`. */
  invalidEnvFields: string[]
  updatedAt: string | null
}

export function toCompanyProfileDto(dados: DadosLegaisEfetivos, linha: LinhaPerfilEmpresa | null): CompanyProfileDto {
  const doPainel = dados.fonteEmpresa === 'db' && linha !== null
  const e = dados.empresa
  const profile: CompanyProfileDto['profile'] = doPainel
    ? {
        legalName: linha.legalName,
        tradeName: linha.tradeName,
        cnpj: e.cnpj, // já normalizado e formatado pelo resolvedor; vazio/ilegível => null
        supportEmail: linha.supportEmail,
        supportPhone: linha.supportPhone,
        address: linha.address,
        website: linha.website,
        dpoName: linha.dpoName,
        dpoEmail: linha.dpoEmail,
      }
    : { legalName: e.name, tradeName: null, cnpj: e.cnpj, supportEmail: e.supportEmail, supportPhone: e.supportPhone, address: null, website: null, dpoName: null, dpoEmail: e.dpoEmail }
  return {
    source: dados.fonteEmpresa,
    profile,
    versions: {
      termsVersion: dados.versoes.termsVersion,
      privacyVersion: dados.versoes.privacyVersion,
      termsSource: dados.fonteVersoes.terms,
      privacySource: dados.fonteVersoes.privacy,
      envTermsVersion: env.LEGAL_TERMS_VERSION,
      envPrivacyVersion: env.LEGAL_PRIVACY_VERSION,
    },
    invalidEnvFields: dados.camposInvalidosDaEnv.map(String),
    updatedAt: dados.atualizadoEm ? dados.atualizadoEm.toISOString() : null,
  }
}
