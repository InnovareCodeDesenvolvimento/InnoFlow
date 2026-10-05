import { formatarCnpjNormalizado, validarENormalizarCnpj } from './cnpj'

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

/**
 * Espelha `PublicLegalConfig['company']`. Tudo opcional: o dono pode não ter informado CNPJ, e-mail de suporte nem encarregado (DPO). Vazio = `null`, nunca texto inventado.
 * `name` = razão social (ou, na falta dela, o nome fantasia). Os quatro últimos campos (`tradeName`, `address`, `website`, `dpoName`) são OPCIONAIS no tipo para não quebrar quem já
 * monta este objeto sem eles (e-mails, testes); o normalizador e a rota pública sempre os devolvem (com `null` quando vazios).
 */
export interface DadosPublicosDaEmpresa {
  name: string | null
  cnpj: string | null
  supportEmail: string | null
  supportPhone: string | null
  dpoEmail: string | null
  tradeName?: string | null
  address?: string | null
  website?: string | null
  dpoName?: string | null
}

export interface DadosBrutosDaEmpresa {
  name?: string | null | undefined
  tradeName?: string | null | undefined
  cnpj?: string | null | undefined
  supportEmail?: string | null | undefined
  supportPhone?: string | null | undefined
  address?: string | null | undefined
  website?: string | null | undefined
  dpoName?: string | null | undefined
  dpoEmail?: string | null | undefined
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// eslint-disable-next-line no-control-regex -- é exatamente o que se quer: trocar quebra de linha/tabulação/controle por espaço
const CARACTERES_DE_CONTROLE = /[\u0000-\u001f\u007f]+/g

/** Texto de UMA linha: controles viram espaço e as bordas são aparadas. Vazio => `null`. */
export function textoDeUmaLinha(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(CARACTERES_DE_CONTROLE, ' ').trim()
  return t === '' ? null : t
}

/** Formata um CNPJ já normalizado (14 caracteres). Mantido com este nome porque o restante do código já o conhece. */
export function formatarCnpj(normalizado: string): string {
  return formatarCnpjNormalizado(normalizado)
}

/**
 * Site: só `http(s)`, sem credencial embutida, com domínio de verdade (ponto no host). Sem esquema (`innoflow.com.br`) assume `https://`. Devolve a URL canônica (sem a barra final
 * quando é só o domínio) ou `null`. Esquemas como `javascript:` nunca passam — o valor vira um link na página pública.
 */
export function normalizarSite(bruto: string | null | undefined): string | null {
  const t = textoDeUmaLinha(bruto)
  if (t === null || t.length > 200 || /\s/.test(t)) return null
  const comEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`
  let u: URL
  try {
    u = new URL(comEsquema)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username !== '' || u.password !== '') return null
  if (!u.hostname.includes('.') || u.hostname.endsWith('.')) return null
  const texto = u.toString()
  return u.pathname === '/' && u.search === '' && u.hash === '' ? texto.replace(/\/$/, '') : texto
}

/**
 * Valores inválidos viram `null` e voltam em `invalidos` (o serviço loga o NOME do campo, uma vez): uma env mal digitada no EasyPanel não pode derrubar o boot dos 3 entrypoints
 * nem publicar lixo numa página pública — o campo simplesmente fica vazio até o dono corrigir.
 */
export function normalizarDadosDaEmpresa(bruto: DadosBrutosDaEmpresa): { dados: Required<DadosPublicosDaEmpresa>; invalidos: Array<keyof DadosPublicosDaEmpresa> } {
  const invalidos: Array<keyof DadosPublicosDaEmpresa> = []

  const email = (campo: 'supportEmail' | 'dpoEmail'): string | null => {
    const v = textoDeUmaLinha(bruto[campo])
    if (v === null) return null
    if (!EMAIL.test(v) || v.length > 180) {
      invalidos.push(campo)
      return null
    }
    return v
  }

  let cnpj: string | null = null
  const cnpjBruto = textoDeUmaLinha(bruto.cnpj)
  if (cnpjBruto !== null) {
    const n = validarENormalizarCnpj(cnpjBruto)
    if (n === null) invalidos.push('cnpj')
    else cnpj = formatarCnpj(n)
  }

  let website: string | null = null
  if (textoDeUmaLinha(bruto.website) !== null) {
    website = normalizarSite(bruto.website)
    if (website === null) invalidos.push('website')
  }

  const limitar = (v: string | null | undefined, max: number): string | null => {
    const t = textoDeUmaLinha(v)
    return t !== null ? t.slice(0, max) : null
  }
  const razaoSocial = limitar(bruto.name, 160)
  const fantasia = limitar(bruto.tradeName, 120)
  return {
    dados: {
      name: razaoSocial ?? fantasia,
      cnpj,
      supportEmail: email('supportEmail'),
      supportPhone: limitar(bruto.supportPhone, 30),
      dpoEmail: email('dpoEmail'),
      tradeName: fantasia,
      address: limitar(bruto.address, 300),
      website,
      dpoName: limitar(bruto.dpoName, 120),
    },
    invalidos,
  }
}
