/**
 * Canais de saída dos avisos ao dono: interface de provedor + e-mail (SMTP via nodemailer) + WhatsApp (Evolution API e adaptador HTTP genérico).
 *
 * Regras de todos os canais:
 *  - `enviar` PODE lançar (o notificador captura e loga SEM segredo); nunca é chamado no caminho de requisição/OCPP/job.
 *  - Prazo curto (SMTP 5 s de conexão/greeting, HTTP 5 s) e SEM seguir redirect (um redirect levaria a chave `apikey`/Bearer para outro host).
 *  - O texto/assunto vêm de `core/alertas/formatar.ts` (já sanitizado); o canal só transporta.
 *  - Segredos (senha SMTP, apikey, token) ficam só dentro do canal e NUNCA entram em mensagem de erro/log.
 *  - ANTI-SSRF (destino vindo do painel): o host é resolvido UMA vez, TODOS os endereços são validados (`core/comunicacao/destinoSeguro.ts`) e a conexão vai para o IP validado
 *    (com SNI/Host do nome original) — um DNS que muda entre a checagem e a conexão (rebinding) não fura a trava. Config da env usa uma política confiável.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import nodemailer from 'nodemailer'
import { assuntoDoAlerta, corpoDoEmail, nomeSeguroDoAlerta, textoDoWhatsapp, type EventoDeAlerta } from '../../core/alertas/formatar'
import type { SeveridadeNotificacao } from '../../core/alertas/severidade'
import { DestinoBloqueadoError, hostSemColchetes, resolverDestinoSeguro, type PoliticaDeDestino, type ResolvedorDns } from '../../core/comunicacao/destinoSeguro'
import type { ConfigEmail, ConfigWhatsapp, ConfigWhatsappEvolution, ConfigWhatsappGenerico } from './config'

export interface CanalDeAlerta {
  readonly nome: 'email' | 'whatsapp'
  /** Severidade mínima para ESTE canal. */
  readonly minSeveridade: SeveridadeNotificacao
  enviar(evento: EventoDeAlerta): Promise<void>
}

export const PRAZO_HTTP_MS = 5_000

/** Falha de canal SEM dado sensível: código/status/nome do erro, nunca a mensagem crua da biblioteca (pode embutir host/credencial). */
export class FalhaDeCanal extends Error {
  constructor(readonly canal: string, readonly motivo: string) {
    super(`${canal}: ${motivo}`)
    this.name = 'FalhaDeCanal'
  }
}

export const resolvedorDnsPadrao: ResolvedorDns = async (host) => {
  const r = await dnsLookup(host, { all: true, verbatim: true })
  return r.map((x) => ({ address: x.address, family: x.family }))
}

/** Resolve e valida o destino; traduz o bloqueio em `FalhaDeCanal` (motivo curto, sem endereço). */
async function destinoOuFalha(canal: string, host: string, politica: PoliticaDeDestino, dns: ResolvedorDns): Promise<{ ip: string }> {
  try {
    return await resolverDestinoSeguro(host, politica, dns)
  } catch (err) {
    if (err instanceof DestinoBloqueadoError) throw new FalhaDeCanal(canal, `destino bloqueado (${err.motivo})`)
    throw new FalhaDeCanal(canal, 'falha ao resolver o endereço')
  }
}

// ------------------------------------------------------------------------------------------------ e-mail

export interface OpcoesDoTransporteSmtp {
  host: string
  porta: number
  secure: boolean
  exigirTls: boolean
  usuario?: string
  senha?: string
  /** IP validado onde conectar; `host` segue como nome de SNI/certificado. */
  ip: string
}

export interface TransporteDeEmail {
  sendMail(msg: { from: string; to: string[]; subject: string; text: string; html?: string }): Promise<unknown>
  close?(): void
}

export function criarTransporteSmtp(o: OpcoesDoTransporteSmtp): TransporteDeEmail {
  return nodemailer.createTransport({
    host: o.ip,
    port: o.porta,
    secure: o.secure,
    requireTLS: o.exigirTls,
    // O certificado é conferido contra o NOME configurado, não contra o IP onde conectamos.
    tls: { servername: hostSemColchetes(o.host) },
    auth: o.usuario && o.senha ? { user: o.usuario, pass: o.senha } : undefined,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 8_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  }) as unknown as TransporteDeEmail
}

/** Motivo CURTO e seguro de uma falha do nodemailer (código + código de resposta SMTP), sem a mensagem crua. */
export function motivoDeFalhaSmtp(err: unknown): string {
  const codigo = (err as { code?: unknown } | null)?.code
  const resposta = (err as { responseCode?: unknown } | null)?.responseCode
  return `smtp ${typeof codigo === 'string' ? codigo : 'erro'}${typeof resposta === 'number' ? ` ${resposta}` : ''}`
}

export interface DepsDoCanalEmail {
  /** Substitui o transporte real (testes). */
  criarTransporte?: (o: OpcoesDoTransporteSmtp) => TransporteDeEmail
  dns?: ResolvedorDns
}

/** Id que o servidor SMTP deu à mensagem (quando devolve): aceito só como texto curto sem espaço — nunca vai para log/banco sem esta checagem. */
function messageIdSeguro(info: unknown): string | undefined {
  const id = (info as { messageId?: unknown } | null)?.messageId
  return typeof id === 'string' && id.length > 0 && id.length <= 255 && !/\s/.test(id) ? id : undefined
}

/**
 * `msg.para` = destinatários DESTA mensagem (e-mail transacional ao motorista, teste do painel); sem ele vale a lista de ALERTAS do canal (`c.para`). Lista efetiva vazia NÃO envia
 * (L1.6: o canal pode estar ativo só para o transacional, sem destinatário de alerta) — falha curta e sem endereço.
 */
export async function enviarPorSmtp(c: ConfigEmail, msg: { subject: string; text: string; html?: string; para?: string[] }, deps: DepsDoCanalEmail = {}): Promise<{ messageId?: string }> {
  const para = msg.para ?? c.para
  if (para.length === 0) throw new FalhaDeCanal('email', 'sem destinatário')
  const destino = await destinoOuFalha('email', c.host, c.politicaDeDestino, deps.dns ?? resolvedorDnsPadrao)
  const transporte = (deps.criarTransporte ?? criarTransporteSmtp)({ host: c.host, porta: c.porta, secure: c.secure, exigirTls: c.exigirTls, usuario: c.usuario, senha: c.senha, ip: destino.ip })
  try {
    const info = await transporte.sendMail({ from: c.de, to: para, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) })
    return { messageId: messageIdSeguro(info) }
  } catch (err) {
    throw new FalhaDeCanal('email', motivoDeFalhaSmtp(err))
  } finally {
    try {
      transporte.close?.()
    } catch {
      /* ignorado */
    }
  }
}

export function criarCanalEmail(c: ConfigEmail, deps: DepsDoCanalEmail = {}): CanalDeAlerta {
  return {
    nome: 'email',
    minSeveridade: c.minSeveridade,
    enviar: async (evento) => {
      await enviarPorSmtp(c, { subject: assuntoDoAlerta(evento), text: corpoDoEmail(evento) }, deps)
    },
  }
}

// ------------------------------------------------------------------------------------------------ WhatsApp

/** O mínimo de `http.request` que usamos (testes injetam). */
export type RequisitorHttp = (opcoes: RequestOptions & { protocolo: 'http:' | 'https:' }, corpo: string) => Promise<{ status: number }>

/** POST com prazo, SEM seguir redirect, conectando no IP já validado (SNI/Host do nome original). Esvazia a resposta sem lê-la. */
export const requisitorHttpPadrao: RequisitorHttp = (opcoes, corpo) =>
  new Promise((resolve, reject) => {
    const { protocolo, ...resto } = opcoes
    const req = (protocolo === 'https:' ? httpsRequest : httpRequest)(resto, (res: IncomingMessage) => {
      res.resume() // a resposta do provedor pode ecoar número/mensagem: nunca é lida nem logada
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      res.on('error', reject)
    })
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), PRAZO_HTTP_MS)
    timer.unref?.()
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.on('close', () => clearTimeout(timer))
    req.end(corpo)
  })

export interface DepsDoCanalHttp {
  dns?: ResolvedorDns
  requisitor?: RequisitorHttp
}

async function postarJson(canal: string, urlTexto: string, politica: PoliticaDeDestino, cabecalhos: Record<string, string>, corpo: unknown, deps: DepsDoCanalHttp): Promise<void> {
  const url = new URL(urlTexto)
  const host = hostSemColchetes(url.hostname)
  const destino = await destinoOuFalha(canal, host, politica, deps.dns ?? resolvedorDnsPadrao)
  const protocolo = url.protocol === 'https:' ? 'https:' : 'http:'
  const texto = JSON.stringify(corpo)
  let resposta: { status: number }
  try {
    resposta = await (deps.requisitor ?? requisitorHttpPadrao)(
      {
        protocolo,
        host: destino.ip,
        port: url.port ? Number(url.port) : protocolo === 'https:' ? 443 : 80,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        servername: host, // SNI/certificado = nome configurado (ignorado em http)
        headers: { Host: url.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto), ...cabecalhos },
      },
      texto,
    )
  } catch (err) {
    const nome = (err as { name?: unknown } | null)?.name
    throw new FalhaDeCanal(canal, nome === 'TimeoutError' ? `sem resposta em ${PRAZO_HTTP_MS}ms` : 'falha de rede')
  }
  if (resposta.status >= 300 && resposta.status < 400) throw new FalhaDeCanal(canal, `redirect ${resposta.status} recusado (nao sigo redirect)`)
  if (resposta.status < 200 || resposta.status >= 300) throw new FalhaDeCanal(canal, `http ${resposta.status}`)
}

/** Corpo do `sendText` da Evolution (v2: `{number,text}`; v1: `{number,textMessage:{text}}`). */
export function corpoSendTextEvolution(versao: 1 | 2, number: string, text: string): Record<string, unknown> {
  return versao === 1 ? { number, textMessage: { text } } : { number, text }
}

export function urlSendTextEvolution(c: Pick<ConfigWhatsappEvolution, 'baseUrl' | 'instancia'>): string {
  return `${c.baseUrl}/message/sendText/${encodeURIComponent(c.instancia)}`
}

/** Envia o texto a cada número; só falha se NINGUÉM recebeu (um número errado não pode esconder o aviso dos outros). */
export async function enviarPorEvolution(c: ConfigWhatsappEvolution, text: string, deps: DepsDoCanalHttp = {}, numeros: string[] = c.para): Promise<void> {
  const url = urlSendTextEvolution(c)
  const resultados = await Promise.allSettled(numeros.map((number) => postarJson('whatsapp', url, c.politicaDeDestino, { apikey: c.apikey }, corpoSendTextEvolution(c.versao, number, text), deps)))
  const falhas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (falhas.length === resultados.length) throw falhas[0].reason
}

/**
 * Evolution API. v2: `POST {base}/message/sendText/{instancia}` com `{ number, text }`; v1: `{ number, textMessage: { text } }`. Autenticação pelo header
 * `apikey`. Um POST por destinatário (a API não tem lista). Conferido contra o CÓDIGO da Evolution (rotas, DTO e guard de apikey no GitHub oficial),
 * NÃO contra uma instância viva.
 */
export function criarCanalEvolution(c: ConfigWhatsappEvolution, deps: DepsDoCanalHttp = {}): CanalDeAlerta {
  return { nome: 'whatsapp', minSeveridade: c.minSeveridade, enviar: (evento) => enviarPorEvolution(c, textoDoWhatsapp(evento), deps) }
}

/** Adaptador HTTP genérico (provedor ainda não definido ou ponte própria): `POST url` com `Authorization: Bearer` e JSON `{to,text,severity,alert,service,at}`. */
export function criarCanalWebhookGenerico(c: ConfigWhatsappGenerico, deps: DepsDoCanalHttp = {}): CanalDeAlerta {
  return {
    nome: 'whatsapp',
    minSeveridade: c.minSeveridade,
    async enviar(evento) {
      const text = textoDoWhatsapp(evento)
      const cab: Record<string, string> = c.token ? { authorization: `Bearer ${c.token}` } : {}
      const resultados = await Promise.allSettled(
        c.para.map((to) =>
          postarJson('whatsapp', c.url, c.politicaDeDestino, cab, { to, text, severity: evento.severidade, alert: nomeSeguroDoAlerta(evento.alerta), service: evento.servico, at: evento.em }, deps),
        ),
      )
      const falhas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (falhas.length === resultados.length) throw falhas[0].reason
    },
  }
}

export function criarCanalWhatsapp(c: ConfigWhatsapp, deps: DepsDoCanalHttp = {}): CanalDeAlerta {
  return c.provedor === 'evolution' ? criarCanalEvolution(c, deps) : criarCanalWebhookGenerico(c, deps)
}
