/**
 * Resolução da configuração de comunicação: PAINEL (linha `NotificationChannelConfig`) manda, ENV (`ALERT_*`) é reserva — o mesmo princípio do gateway de pagamento (F5.5).
 * Função PURA (a decifragem entra por injeção; nada de Prisma/Redis/logger aqui).
 *
 * Regras (por GRUPO/canal, nunca misturando campos de fontes diferentes):
 *  - E-mail está "no banco" quando `emailEnabled !== null`; WhatsApp quando `whatsappEnabled !== null`. Nesse caso o canal é lido SÓ da linha (inclusive o segredo):
 *    `false` desliga o canal mesmo que a env o tenha configurado. Grupo ainda nulo => vale a env (ou nada, se a env não configura).
 *  - Linha inexistente => tudo da env (`source: 'env'`).
 *  - A janela de dedupe vem da linha quando preenchida, senão da env/padrão. Teto por hora, piso global (`ALERT_MIN_SEVERITY`), ambiente e serviço são da env.
 *  - Configuração do banco inválida (host proibido, https faltando, destinatários vazios, segredo que não decifra) NUNCA derruba nada: o canal fica desligado e o motivo (sem
 *    segredo) vai em `avisos` — fail-closed para envio, o painel mostra o problema.
 */
import { ORDEM_SEVERIDADE, type SeveridadeNotificacao } from '../../core/alertas/severidade'
import { validarHostDeclarado, type PoliticaDeDestino } from '../../core/comunicacao/destinoSeguro'
import {
  EMAIL_SIMPLES,
  REMETENTE,
  lerConfigAlertas,
  normalizarNumeroWhatsapp,
  permitirRedePrivadaDaEnv,
  urlHttpValida,
  type ConfigAlertas,
  type ConfigEmail,
  type ConfigWhatsappEvolution,
  type FonteEnv,
} from './config'

/** Colunas de `NotificationChannelConfig` que a resolução usa. */
export interface LinhaComunicacao {
  emailEnabled: boolean | null
  smtpHost: string | null
  smtpPort: number | null
  smtpSecure: boolean
  smtpUser: string | null
  smtpPasswordCiphertext: string | null
  emailFromName: string | null
  emailFromAddress: string | null
  alertEmailRecipients: string[]
  emailMinSeverity: string
  whatsappEnabled: boolean | null
  evolutionBaseUrl: string | null
  evolutionInstance: string | null
  evolutionApiKeyCiphertext: string | null
  evolutionApiVersion: number
  alertWhatsappRecipients: string[]
  whatsappMinSeverity: string
  alertDedupeMinutes: number | null
  updatedAt: Date
}

export type FonteDoCanal = 'database' | 'env' | 'none'

export interface ResolucaoDeComunicacao {
  config: ConfigAlertas
  /** `database` se existe linha salva no painel; senão `env`. */
  source: 'database' | 'env'
  fontes: { email: FonteDoCanal; whatsapp: FonteDoCanal; dedupe: 'database' | 'env' }
  /** Problemas de configuração (sem segredo) — aparecem no painel e no log. */
  avisos: string[]
  /** Há segredo salvo no banco que NÃO decifra (chave trocada/perdida). */
  segredosIlegiveis: boolean
}

export type Decifrador = (ciphertext: string) => string

const SEV = new Set(Object.keys(ORDEM_SEVERIDADE))
const sev = (v: string, padrao: SeveridadeNotificacao): SeveridadeNotificacao => (SEV.has(v) ? (v as SeveridadeNotificacao) : padrao)

export function politicaDeDestinoDoPainel(fonteEnv: FonteEnv): PoliticaDeDestino {
  return { producao: fonteEnv.NODE_ENV === 'production', permitirRedePrivada: permitirRedePrivadaDaEnv(fonteEnv) }
}

/** Campos de e-mail em TEXTO PURO (segredo já decifrado): o que a resolução e o teste do painel montam. */
export interface CamposEmail {
  host: string | null
  porta: number | null
  secure: boolean
  usuario: string | null
  senha: string | undefined
  nomeRemetente: string | null
  emailRemetente: string | null
  destinatarios: string[]
  minSeveridade: string
}

export interface CamposEvolution {
  baseUrl: string | null
  instancia: string | null
  apikey: string | undefined
  versao: number
  destinatarios: string[]
  minSeveridade: string
}

/** Valida e monta o canal de e-mail (política de destino do PAINEL). `null` + motivo em `avisos` se algo falta/é proibido. Não lança. */
export function emailDeCampos(c: CamposEmail, politica: PoliticaDeDestino, avisos: string[], opcoes: { exigirDestinatarios?: boolean } = {}): ConfigEmail | null {
  if (!c.host) {
    avisos.push('e-mail ligado no painel, mas sem servidor SMTP (host)')
    return null
  }
  const proibido = validarHostDeclarado(c.host, politica)
  if (proibido) {
    avisos.push(`e-mail desligado: servidor SMTP recusado (${proibido})`)
    return null
  }
  const para = c.destinatarios.filter((e) => EMAIL_SIMPLES.test(e))
  if (para.length === 0 && opcoes.exigirDestinatarios !== false) {
    avisos.push('e-mail ligado no painel, mas sem destinatário válido')
    return null
  }
  const remetente = c.emailRemetente ?? (c.usuario && EMAIL_SIMPLES.test(c.usuario) ? c.usuario : null)
  if (!remetente) {
    avisos.push('e-mail ligado no painel, mas sem remetente (e-mail "de")')
    return null
  }
  const de = c.nomeRemetente ? `${c.nomeRemetente.replace(/[<>"\r\n]/g, '')} <${remetente}>` : remetente
  if (!REMETENTE.test(de)) {
    avisos.push('e-mail ligado no painel, mas o remetente é inválido')
    return null
  }
  return {
    para,
    de,
    host: c.host,
    porta: c.porta ?? (c.secure ? 465 : 587),
    usuario: c.usuario ?? undefined,
    senha: c.senha,
    secure: c.secure,
    exigirTls: politica.producao && !c.secure,
    minSeveridade: sev(c.minSeveridade, 'IMPORTANTE'),
    origem: 'database',
    politicaDeDestino: politica,
  }
}

export function evolutionDeCampos(c: CamposEvolution, politica: PoliticaDeDestino, avisos: string[], opcoes: { exigirDestinatarios?: boolean } = {}): ConfigWhatsappEvolution | null {
  if (!c.baseUrl || !c.instancia) {
    avisos.push('WhatsApp ligado no painel, mas sem a URL da Evolution API e/ou o nome da instância')
    return null
  }
  const aviso: string[] = []
  const u = urlHttpValida(c.baseUrl, politica.producao, 'URL da Evolution API', aviso, politica.permitirRedePrivada)
  if (!u) {
    avisos.push(`WhatsApp desligado: ${aviso[0] ?? 'URL da Evolution API inválida'}`)
    return null
  }
  const proibido = validarHostDeclarado(u.hostname, politica)
  if (proibido) {
    avisos.push(`WhatsApp desligado: URL da Evolution API recusada (${proibido})`)
    return null
  }
  const para = c.destinatarios.map(normalizarNumeroWhatsapp).filter((n): n is string => n !== null)
  if (para.length === 0 && opcoes.exigirDestinatarios !== false) {
    avisos.push('WhatsApp ligado no painel, mas sem número de destino válido')
    return null
  }
  if (!c.apikey) {
    avisos.push('WhatsApp ligado no painel, mas sem a chave (apikey) da Evolution API')
    return null
  }
  return {
    provedor: 'evolution',
    baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`,
    instancia: c.instancia,
    apikey: c.apikey,
    versao: c.versao === 1 ? 1 : 2,
    para,
    minSeveridade: sev(c.minSeveridade, 'CRITICO'),
    origem: 'database',
    politicaDeDestino: politica,
  }
}

/** Decifra o segredo da linha; `undefined` se não há; `'ILEGIVEL'` se não decifra. */
function decifrarSeHouver(ciphertext: string | null, decifrar: Decifrador): string | undefined | 'ILEGIVEL' {
  if (!ciphertext) return undefined
  try {
    return decifrar(ciphertext)
  } catch {
    return 'ILEGIVEL'
  }
}

export function camposEmailDaLinha(l: LinhaComunicacao, decifrar: Decifrador): { campos: CamposEmail; ilegivel: boolean } {
  const senha = decifrarSeHouver(l.smtpPasswordCiphertext, decifrar)
  return {
    campos: {
      host: l.smtpHost,
      porta: l.smtpPort,
      secure: l.smtpSecure,
      usuario: l.smtpUser,
      senha: senha === 'ILEGIVEL' ? undefined : senha,
      nomeRemetente: l.emailFromName,
      emailRemetente: l.emailFromAddress,
      destinatarios: l.alertEmailRecipients,
      minSeveridade: l.emailMinSeverity,
    },
    ilegivel: senha === 'ILEGIVEL',
  }
}

export function camposEvolutionDaLinha(l: LinhaComunicacao, decifrar: Decifrador): { campos: CamposEvolution; ilegivel: boolean } {
  const apikey = decifrarSeHouver(l.evolutionApiKeyCiphertext, decifrar)
  return {
    campos: {
      baseUrl: l.evolutionBaseUrl,
      instancia: l.evolutionInstance,
      apikey: apikey === 'ILEGIVEL' ? undefined : apikey,
      versao: l.evolutionApiVersion,
      destinatarios: l.alertWhatsappRecipients,
      minSeveridade: l.whatsappMinSeverity,
    },
    ilegivel: apikey === 'ILEGIVEL',
  }
}

function emailDaLinha(l: LinhaComunicacao, fonteEnv: FonteEnv, decifrar: Decifrador, avisos: string[]): { cfg: ConfigEmail | null; ilegivel: boolean } {
  const { campos, ilegivel } = camposEmailDaLinha(l, decifrar)
  if (ilegivel) {
    avisos.push('e-mail desligado: a senha SMTP salva não pôde ser decifrada (chave de cifragem trocada ou perdida) — salve a senha de novo')
    return { cfg: null, ilegivel: true }
  }
  return { cfg: emailDeCampos(campos, politicaDeDestinoDoPainel(fonteEnv), avisos), ilegivel: false }
}

function whatsappDaLinha(l: LinhaComunicacao, fonteEnv: FonteEnv, decifrar: Decifrador, avisos: string[]): { cfg: ConfigWhatsappEvolution | null; ilegivel: boolean } {
  const { campos, ilegivel } = camposEvolutionDaLinha(l, decifrar)
  if (ilegivel) {
    avisos.push('WhatsApp desligado: a apikey salva não pôde ser decifrada (chave de cifragem trocada ou perdida) — salve a apikey de novo')
    return { cfg: null, ilegivel: true }
  }
  return { cfg: evolutionDeCampos(campos, politicaDeDestinoDoPainel(fonteEnv), avisos), ilegivel: false }
}

export function resolverConfigAlertas(linha: LinhaComunicacao | null, fonteEnv: FonteEnv, decifrar: Decifrador, argv1: string | undefined = process.argv[1]): ResolucaoDeComunicacao {
  const doEnv = lerConfigAlertas(fonteEnv, argv1)
  if (!linha) {
    return {
      config: doEnv,
      source: 'env',
      fontes: { email: doEnv.email ? 'env' : 'none', whatsapp: doEnv.whatsapp ? 'env' : 'none', dedupe: 'env' },
      avisos: doEnv.avisos,
      segredosIlegiveis: false,
    }
  }
  const avisos: string[] = []
  let segredosIlegiveis = false

  let email = doEnv.email
  let fonteEmail: FonteDoCanal = email ? 'env' : 'none'
  if (linha.emailEnabled !== null) {
    fonteEmail = 'database'
    if (linha.emailEnabled) {
      const r = emailDaLinha(linha, fonteEnv, decifrar, avisos)
      email = r.cfg
      segredosIlegiveis ||= r.ilegivel
    } else {
      email = null
    }
  }

  let whatsapp = doEnv.whatsapp
  let fonteWhatsapp: FonteDoCanal = whatsapp ? 'env' : 'none'
  if (linha.whatsappEnabled !== null) {
    fonteWhatsapp = 'database'
    if (linha.whatsappEnabled) {
      const r = whatsappDaLinha(linha, fonteEnv, decifrar, avisos)
      whatsapp = r.cfg
      segredosIlegiveis ||= r.ilegivel
    } else {
      whatsapp = null
    }
  }

  // Avisos da env só importam quando algum canal ainda depende dela.
  const avisosEnv = fonteEmail === 'env' || fonteWhatsapp === 'env' ? doEnv.avisos : []
  return {
    config: { ...doEnv, email, whatsapp, dedupeMinutos: linha.alertDedupeMinutes ?? doEnv.dedupeMinutos, avisos: [...avisos, ...avisosEnv] },
    source: 'database',
    fontes: { email: fonteEmail, whatsapp: fonteWhatsapp, dedupe: linha.alertDedupeMinutes !== null ? 'database' : 'env' },
    avisos: [...avisos, ...avisosEnv],
    segredosIlegiveis,
  }
}
