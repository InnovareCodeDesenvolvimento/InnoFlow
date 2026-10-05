/**
 * Configuração dos avisos ao dono (N-7), lida de variáveis de ambiente. Função PURA sobre um `Record` (testável sem tocar `process.env`).
 *
 * TUDO desligado por padrão: sem as envs do canal, o canal não existe e nada acontece (sem erro). Configuração torta NUNCA derruba o boot (mesma lição
 * de `bug-env-eager-todos-entrypoints`): o canal com problema fica desligado e o motivo vai em `avisos` (o notificador loga, sem segredo, uma vez).
 * Por isso isto NÃO passa por `lib/env.ts` (cujo parse é eager e dá `process.exit(1)`).
 */
import { ORDEM_SEVERIDADE, type SeveridadeNotificacao } from '../../core/alertas/severidade'
import { hostEhRedePrivada, hostSemColchetes, type PoliticaDeDestino } from '../../core/comunicacao/destinoSeguro'

/** De onde veio a configuração do canal: do painel (banco, destino NÃO confiável: passa pela trava de SSRF) ou da env (definida por quem faz o deploy: confiável). */
export type OrigemDoCanal = 'database' | 'env'

/** Política de destino das envs: confiável (rede interna do EasyPanel permitida), mas metadados/endereços não roteáveis continuam bloqueados. */
export const POLITICA_DE_DESTINO_DA_ENV: PoliticaDeDestino = { producao: false, permitirRedePrivada: true }

export type FonteEnv = Readonly<Record<string, string | undefined>>

export interface ConfigEmail {
  para: string[]
  de: string
  host: string
  porta: number
  usuario?: string
  senha?: string
  /** TLS implícito (porta 465). `false` = STARTTLS. */
  secure: boolean
  /** Em produção com STARTTLS, recusa enviar sem TLS (não manda a senha em claro). */
  exigirTls: boolean
  minSeveridade: SeveridadeNotificacao
  origem: OrigemDoCanal
  politicaDeDestino: PoliticaDeDestino
}

export interface ConfigWhatsappEvolution {
  provedor: 'evolution'
  baseUrl: string
  instancia: string
  apikey: string
  /** Versão da Evolution API: 2 = `{number,text}`; 1 = `{number,textMessage:{text}}`. */
  versao: 1 | 2
  para: string[]
  minSeveridade: SeveridadeNotificacao
  origem: OrigemDoCanal
  politicaDeDestino: PoliticaDeDestino
}

export interface ConfigWhatsappGenerico {
  provedor: 'generic'
  url: string
  token?: string
  para: string[]
  minSeveridade: SeveridadeNotificacao
  origem: OrigemDoCanal
  politicaDeDestino: PoliticaDeDestino
}

export type ConfigWhatsapp = ConfigWhatsappEvolution | ConfigWhatsappGenerico

export interface ConfigAlertas {
  servico: string
  ambiente: string
  producao: boolean
  /** Mínimo para QUALQUER canal; cada canal ainda tem o seu (vale o mais restritivo). */
  minSeveridade: SeveridadeNotificacao
  dedupeMinutos: number
  maxPorHora: number
  email: ConfigEmail | null
  whatsapp: ConfigWhatsapp | null
  /** Problemas de configuração (SEM valores secretos), para o log de boot. */
  avisos: string[]
}

const SEVERIDADES = new Set<string>(Object.keys(ORDEM_SEVERIDADE))

export function texto(fonte: FonteEnv, nome: string): string | undefined {
  const v = fonte[nome]
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

export function inteiro(fonte: FonteEnv, nome: string, padrao: number, min: number, max: number): number {
  const t = texto(fonte, nome)
  if (t === undefined) return padrao
  const n = Number(t)
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao
}

function severidade(fonte: FonteEnv, nome: string, padrao: SeveridadeNotificacao, avisos: string[]): SeveridadeNotificacao {
  const t = texto(fonte, nome)?.toUpperCase()
  if (t === undefined) return padrao
  if (SEVERIDADES.has(t)) return t as SeveridadeNotificacao
  avisos.push(`${nome} invalida (use INFO, IMPORTANTE ou CRITICO) — usando ${padrao}`)
  return padrao
}

export function booleano(fonte: FonteEnv, nome: string, padrao: boolean): boolean {
  const t = texto(fonte, nome)?.toLowerCase()
  if (t === undefined) return padrao
  if (['true', '1', 'yes', 'on'].includes(t)) return true
  if (['false', '0', 'no', 'off'].includes(t)) return false
  return padrao
}

function lista(fonte: FonteEnv, nome: string): string[] {
  return (texto(fonte, nome) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** `COMMUNICATION_ALLOW_PRIVATE_HOSTS=true` (só quem controla o deploy define; NÃO há campo no painel): libera destinos de rede privada (ver `core/comunicacao/destinoSeguro.ts`). */
export function permitirRedePrivadaDaEnv(fonte: FonteEnv): boolean {
  return booleano(fonte, 'COMMUNICATION_ALLOW_PRIVATE_HOSTS', false)
}

export const EMAIL_SIMPLES = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
/** `Nome <a@b.c>` ou `a@b.c`. */
export const REMETENTE = /^(?:[^<>\r\n]+<[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+>|[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+)$/

/** Servidor derivado do arquivo: `api` | `ocpp` | `worker` (pelo entrypoint em execução) — ou `ALERT_SERVICE_NAME`. */
export function detectarServico(fonte: FonteEnv, argv1: string | undefined): string {
  const forcado = texto(fonte, 'ALERT_SERVICE_NAME')
  if (forcado && /^[a-z0-9_-]{1,30}$/i.test(forcado)) return forcado
  const m = /entrypoints[\\/](api|ocpp|worker)\.(?:ts|js)$/i.exec(argv1 ?? '')
  return m ? m[1].toLowerCase() : 'processo'
}

function configurarEmail(fonte: FonteEnv, producao: boolean, avisos: string[]): ConfigEmail | null {
  const bruto = lista(fonte, 'ALERT_EMAIL_TO')
  const host = texto(fonte, 'ALERT_SMTP_HOST')
  if (bruto.length === 0 && !host) return null // canal simplesmente não configurado
  const para = bruto.filter((e) => EMAIL_SIMPLES.test(e))
  if (para.length < bruto.length) avisos.push(`ALERT_EMAIL_TO: ${bruto.length - para.length} endereco(s) invalido(s) ignorado(s)`)
  if (!host) {
    avisos.push('e-mail desligado: ALERT_SMTP_HOST ausente')
    return null
  }
  // L1.6 (MUDANÇA DELIBERADA): o canal SMTP vale pelo servidor + remetente. Os destinatários de ALERTA (`ALERT_EMAIL_TO`) são opcionais — sem eles o canal segue ativo para o e-mail
  // TRANSACIONAL ao motorista (redefinição de senha, avisos), e só os alertas ao dono por e-mail deixam de sair (ver `montarCanais`).
  const usuario = texto(fonte, 'ALERT_SMTP_USER')
  const de = texto(fonte, 'ALERT_EMAIL_FROM') ?? (usuario && EMAIL_SIMPLES.test(usuario) ? usuario : undefined)
  if (!de || !REMETENTE.test(de)) {
    avisos.push('e-mail desligado: ALERT_EMAIL_FROM ausente ou invalido (e ALERT_SMTP_USER nao e um e-mail)')
    return null
  }
  const secure = booleano(fonte, 'ALERT_SMTP_SECURE', false)
  return {
    para,
    de,
    host,
    porta: inteiro(fonte, 'ALERT_SMTP_PORT', secure ? 465 : 587, 1, 65535),
    usuario,
    senha: texto(fonte, 'ALERT_SMTP_PASS'),
    secure,
    exigirTls: producao && !secure,
    minSeveridade: severidade(fonte, 'ALERT_EMAIL_MIN_SEVERITY', 'IMPORTANTE', avisos),
    origem: 'env',
    politicaDeDestino: POLITICA_DE_DESTINO_DA_ENV,
  }
}

/** Número para o WhatsApp: só dígitos, com DDI (10 a 15). Aceita `+55 (11) 99999-9999` e normaliza. */
export function normalizarNumeroWhatsapp(bruto: string): string | null {
  const d = bruto.replace(/\D/g, '')
  return d.length >= 10 && d.length <= 15 ? d : null
}

/**
 * `https` obrigatório em produção; `http` só fora dela, ou em produção SE a permissão de rede privada (`COMMUNICATION_ALLOW_PRIVATE_HOSTS`) está ligada E o host é
 * de rede interna (Evolution no mesmo projeto do EasyPanel). Sem usuário/senha na URL.
 */
export function urlHttpValida(bruto: string, producao: boolean, nome: string, avisos: string[], permitirRedePrivada = false): URL | null {
  let u: URL
  try {
    u = new URL(bruto)
  } catch {
    avisos.push(`${nome} nao e uma URL valida`)
    return null
  }
  const httpInternoPermitido = permitirRedePrivada && hostEhRedePrivada(hostSemColchetes(u.hostname))
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (!producao || httpInternoPermitido))) {
    avisos.push(`${nome} precisa ser https${producao ? ' em producao' : ''}`)
    return null
  }
  if (u.username || u.password) {
    avisos.push(`${nome} nao pode ter usuario/senha na URL (use o campo proprio de credencial)`)
    return null
  }
  return u
}

function configurarWhatsapp(fonte: FonteEnv, producao: boolean, avisos: string[]): ConfigWhatsapp | null {
  const provedorBruto = texto(fonte, 'ALERT_WHATSAPP_PROVIDER')?.toLowerCase()
  const temEvolution = texto(fonte, 'ALERT_EVOLUTION_BASE_URL') !== undefined
  const temGenerico = texto(fonte, 'ALERT_WHATSAPP_WEBHOOK_URL') !== undefined
  const provedor = provedorBruto ?? (temEvolution ? 'evolution' : temGenerico ? 'generic' : undefined)
  if (provedor === undefined) return null // não configurado
  if (provedor !== 'evolution' && provedor !== 'generic') {
    avisos.push('whatsapp desligado: ALERT_WHATSAPP_PROVIDER deve ser "evolution" ou "generic"')
    return null
  }
  const brutos = lista(fonte, 'ALERT_WHATSAPP_TO')
  const para = brutos.map(normalizarNumeroWhatsapp).filter((n): n is string => n !== null)
  if (para.length < brutos.length) avisos.push(`ALERT_WHATSAPP_TO: ${brutos.length - para.length} numero(s) invalido(s) ignorado(s) (use so digitos com DDI, ex.: 5511999999999)`)
  if (para.length === 0) {
    avisos.push('whatsapp desligado: ALERT_WHATSAPP_TO sem nenhum numero valido')
    return null
  }
  const minSeveridade = severidade(fonte, 'ALERT_WHATSAPP_MIN_SEVERITY', 'CRITICO', avisos)

  if (provedor === 'evolution') {
    const base = texto(fonte, 'ALERT_EVOLUTION_BASE_URL')
    const instancia = texto(fonte, 'ALERT_EVOLUTION_INSTANCE')
    const apikey = texto(fonte, 'ALERT_EVOLUTION_APIKEY')
    if (!base || !instancia || !apikey) {
      avisos.push('whatsapp (evolution) desligado: faltam ALERT_EVOLUTION_BASE_URL, ALERT_EVOLUTION_INSTANCE e/ou ALERT_EVOLUTION_APIKEY')
      return null
    }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(instancia)) {
      avisos.push('whatsapp (evolution) desligado: ALERT_EVOLUTION_INSTANCE so aceita letras, numeros, ponto, hifen e sublinhado')
      return null
    }
    const u = urlHttpValida(base, producao, 'ALERT_EVOLUTION_BASE_URL', avisos, permitirRedePrivadaDaEnv(fonte))
    if (!u) return null
    const versaoBruta = texto(fonte, 'ALERT_EVOLUTION_API_VERSION') ?? '2'
    if (versaoBruta !== '1' && versaoBruta !== '2') avisos.push('ALERT_EVOLUTION_API_VERSION invalida (use 1 ou 2) — usando 2')
    return {
      provedor: 'evolution',
      baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`,
      instancia,
      apikey,
      versao: versaoBruta === '1' ? 1 : 2,
      para,
      minSeveridade,
      origem: 'env',
      politicaDeDestino: POLITICA_DE_DESTINO_DA_ENV,
    }
  }

  const url = texto(fonte, 'ALERT_WHATSAPP_WEBHOOK_URL')
  if (!url) {
    avisos.push('whatsapp (generic) desligado: ALERT_WHATSAPP_WEBHOOK_URL ausente')
    return null
  }
  const u = urlHttpValida(url, producao, 'ALERT_WHATSAPP_WEBHOOK_URL', avisos, permitirRedePrivadaDaEnv(fonte))
  if (!u) return null
  return { provedor: 'generic', url: u.toString(), token: texto(fonte, 'ALERT_WHATSAPP_WEBHOOK_TOKEN'), para, minSeveridade, origem: 'env', politicaDeDestino: POLITICA_DE_DESTINO_DA_ENV }
}

export function lerConfigAlertas(fonte: FonteEnv, argv1: string | undefined = process.argv[1]): ConfigAlertas {
  const avisos: string[] = []
  const producao = texto(fonte, 'NODE_ENV') === 'production'
  const minSeveridade = severidade(fonte, 'ALERT_MIN_SEVERITY', 'IMPORTANTE', avisos)
  return {
    servico: detectarServico(fonte, argv1),
    ambiente: texto(fonte, 'ALERT_ENV_LABEL')?.replace(/[^\w .-]/g, '').slice(0, 30) || texto(fonte, 'NODE_ENV') || 'development',
    producao,
    minSeveridade,
    dedupeMinutos: inteiro(fonte, 'ALERT_DEDUPE_MINUTES', 30, 1, 1440),
    maxPorHora: inteiro(fonte, 'ALERT_MAX_PER_HOUR', 20, 1, 100000),
    email: configurarEmail(fonte, producao, avisos),
    whatsapp: configurarWhatsapp(fonte, producao, avisos),
    avisos,
  }
}

export function algumCanalAtivo(c: ConfigAlertas): boolean {
  return c.email !== null || c.whatsapp !== null
}
