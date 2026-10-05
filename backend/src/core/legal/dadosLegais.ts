import { normalizarDadosDaEmpresa, type DadosPublicosDaEmpresa, type VersoesVigentes } from './termos'

/**
 * Resolução PURA dos dados legais efetivos: o PAINEL (tabela `CompanyProfile`) manda, as envs `LEGAL_*` são a reserva. Sem banco, sem env global — recebe a linha e a env.
 *
 * Regras (decididas para o dono nunca ser surpreendido):
 *  - DADOS DA EMPRESA são um GRUPO: se o painel já salvou algum campo da empresa (`companyDataSavedAt` preenchido), TODOS vêm do painel — campo vazio fica vazio (limpar o CNPJ no
 *    painel não o faz reaparecer pela env). Sem isso, vale a env inteira (`source: 'env'`).
 *  - VERSÕES são por campo: `null` no banco = vale a env (que, sem a variável, é o padrão do código).
 */

export interface LinhaPerfilEmpresa {
  legalName: string | null
  tradeName: string | null
  cnpj: string | null
  supportEmail: string | null
  supportPhone: string | null
  address: string | null
  website: string | null
  dpoName: string | null
  dpoEmail: string | null
  termsVersion: string | null
  privacyVersion: string | null
  companyDataSavedAt: Date | null
  updatedByUserId: string | null
  updatedAt: Date
}

export interface FonteEnvLegal {
  LEGAL_TERMS_VERSION: string
  LEGAL_PRIVACY_VERSION: string
  LEGAL_COMPANY_NAME?: string | undefined
  LEGAL_COMPANY_CNPJ?: string | undefined
  LEGAL_SUPPORT_EMAIL?: string | undefined
  LEGAL_SUPPORT_PHONE?: string | undefined
  LEGAL_DPO_EMAIL?: string | undefined
}

export type FonteDoDado = 'db' | 'env'

export interface DadosLegaisEfetivos {
  versoes: VersoesVigentes
  fonteVersoes: { terms: FonteDoDado; privacy: FonteDoDado }
  empresa: Required<DadosPublicosDaEmpresa>
  /** `db` = o painel já assumiu os dados da empresa; `env` = nada salvo no painel, valem as envs `LEGAL_*`. */
  fonteEmpresa: FonteDoDado
  /** Campos da ENV com valor inválido (viram vazios na página pública). Sempre vazio quando a fonte da empresa é o painel. */
  camposInvalidosDaEnv: Array<keyof DadosPublicosDaEmpresa>
  atualizadoEm: Date | null
}

export function resolverDadosLegais(linha: LinhaPerfilEmpresa | null, env: FonteEnvLegal): DadosLegaisEfetivos {
  const empresaNoPainel = linha !== null && linha.companyDataSavedAt !== null
  const { dados, invalidos } = normalizarDadosDaEmpresa(
    empresaNoPainel
      ? {
          name: linha.legalName,
          tradeName: linha.tradeName,
          cnpj: linha.cnpj,
          supportEmail: linha.supportEmail,
          supportPhone: linha.supportPhone,
          address: linha.address,
          website: linha.website,
          dpoName: linha.dpoName,
          dpoEmail: linha.dpoEmail,
        }
      : { name: env.LEGAL_COMPANY_NAME, cnpj: env.LEGAL_COMPANY_CNPJ, supportEmail: env.LEGAL_SUPPORT_EMAIL, supportPhone: env.LEGAL_SUPPORT_PHONE, dpoEmail: env.LEGAL_DPO_EMAIL },
  )
  const termsNoPainel = linha?.termsVersion != null
  const privacyNoPainel = linha?.privacyVersion != null
  return {
    versoes: {
      termsVersion: termsNoPainel ? (linha.termsVersion as string) : env.LEGAL_TERMS_VERSION,
      privacyVersion: privacyNoPainel ? (linha.privacyVersion as string) : env.LEGAL_PRIVACY_VERSION,
    },
    fonteVersoes: { terms: termsNoPainel ? 'db' : 'env', privacy: privacyNoPainel ? 'db' : 'env' },
    empresa: dados,
    fonteEmpresa: empresaNoPainel ? 'db' : 'env',
    camposInvalidosDaEnv: empresaNoPainel ? [] : invalidos,
    atualizadoEm: linha?.updatedAt ?? null,
  }
}
