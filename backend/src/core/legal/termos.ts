import { validarCnpj } from '../lgpd/chavePix'

/**
 * Termos de uso / política de privacidade (L1.9) — regras PURAS: versão vigente, "o titular está em dia?" e normalização dos dados públicos da empresa.
 * Sem env, sem Prisma, sem relógio: o serviço (`services/legal/consentimento.ts`) liga estas regras ao banco e à configuração.
 */

export type TipoDeDocumento = 'TERMS' | 'PRIVACY'

export interface VersoesVigentes {
  termsVersion: string
  privacyVersion: string
}

export interface AceiteRegistrado {
  kind: TipoDeDocumento
  version: string
  acceptedAt: Date
}

/** Espelha `MeConsentStatus` de `frontend/src/types/api.ts`. */
export interface StatusDeConsentimento {
  termsVersion: string | null
  privacyVersion: string | null
  acceptedAt: string | null
  upToDate: boolean
}

/**
 * Última versão aceita de cada documento (pelo `acceptedAt` mais recente) e se o titular está EM DIA: `upToDate` só quando existe aceite da versão VIGENTE dos DOIS documentos.
 * Quem nunca aceitou nada (conta anterior ao L1.9) fica `upToDate=false` — não se fabrica consentimento retroativo; o modal de reaceite cuida disso.
 */
export function avaliarConsentimento(vigentes: VersoesVigentes, aceites: readonly AceiteRegistrado[]): StatusDeConsentimento {
  const ultimo = (tipo: TipoDeDocumento): AceiteRegistrado | null =>
    aceites.filter((a) => a.kind === tipo).reduce<AceiteRegistrado | null>((melhor, a) => (melhor === null || a.acceptedAt > melhor.acceptedAt ? a : melhor), null)

  const termos = ultimo('TERMS')
  const privacidade = ultimo('PRIVACY')
  const emDia = (tipo: TipoDeDocumento, vigente: string): boolean => aceites.some((a) => a.kind === tipo && a.version === vigente)

  const datas = [termos?.acceptedAt, privacidade?.acceptedAt].filter((d): d is Date => d instanceof Date)
  const maisRecente = datas.length > 0 ? new Date(Math.max(...datas.map((d) => d.getTime()))) : null

  return {
    termsVersion: termos?.version ?? null,
    privacyVersion: privacidade?.version ?? null,
    acceptedAt: maisRecente ? maisRecente.toISOString() : null,
    upToDate: emDia('TERMS', vigentes.termsVersion) && emDia('PRIVACY', vigentes.privacyVersion),
  }
}

// ---- dados públicos da empresa (controlador, suporte, encarregado) ----------------------------------------------------------------------------------

/** Espelha `PublicLegalConfig['company']`. Tudo opcional: o dono ainda não informou CNPJ, e-mail de suporte nem encarregado (DPO). Vazio = `null`, nunca texto inventado. */
export interface DadosPublicosDaEmpresa {
  name: string | null
  cnpj: string | null
  supportEmail: string | null
  supportPhone: string | null
  dpoEmail: string | null
}

export interface DadosBrutosDaEmpresa {
  name?: string | undefined
  cnpj?: string | undefined
  supportEmail?: string | undefined
  supportPhone?: string | undefined
  dpoEmail?: string | undefined
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function digitosDoCnpjValido(texto: string): string | null {
  const d = texto.replace(/\D/g, '')
  return validarCnpj(d) ? d : null
}

export function formatarCnpj(digitos: string): string {
  return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12)}`
}

/**
 * Valores inválidos viram `null` e voltam em `invalidos` (o serviço loga o NOME do campo, uma vez): uma env mal digitada no EasyPanel não pode derrubar o boot dos 3 entrypoints
 * nem publicar lixo numa página pública — o campo simplesmente fica vazio até o dono corrigir.
 */
export function normalizarDadosDaEmpresa(bruto: DadosBrutosDaEmpresa): { dados: DadosPublicosDaEmpresa; invalidos: Array<keyof DadosPublicosDaEmpresa> } {
  const invalidos: Array<keyof DadosPublicosDaEmpresa> = []
  const texto = (v: string | undefined): string | null => (v && v.trim() !== '' ? v.trim() : null)

  const email = (campo: 'supportEmail' | 'dpoEmail'): string | null => {
    const v = texto(bruto[campo])
    if (v === null) return null
    if (!EMAIL.test(v) || v.length > 180) {
      invalidos.push(campo)
      return null
    }
    return v
  }

  let cnpj: string | null = null
  const cnpjBruto = texto(bruto.cnpj)
  if (cnpjBruto !== null) {
    const d = digitosDoCnpjValido(cnpjBruto)
    if (d === null) invalidos.push('cnpj')
    else cnpj = formatarCnpj(d)
  }

  const name = texto(bruto.name)
  const supportPhone = texto(bruto.supportPhone)
  return {
    dados: {
      name: name !== null ? name.slice(0, 160) : null,
      cnpj,
      supportEmail: email('supportEmail'),
      supportPhone: supportPhone !== null ? supportPhone.slice(0, 30) : null,
      dpoEmail: email('dpoEmail'),
    },
    invalidos,
  }
}
