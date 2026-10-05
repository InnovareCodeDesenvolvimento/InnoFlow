import { env } from '../../lib/env'
import { decryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { AppError } from '../../api/middleware/errorHandler'
import type { TestEmailInput, TestWhatsappInput } from '../../api/schemas/communicationSettings.schema'
import { FalhaDeCanal, enviarPorEvolution, enviarPorSmtp, type DepsDoCanalEmail, type DepsDoCanalHttp } from '../../lib/alertas/canais'
import { EMAIL_SIMPLES, normalizarNumeroWhatsapp } from '../../lib/alertas/config'
import {
  camposEmailDaLinha,
  camposEvolutionDaLinha,
  emailDeCampos,
  evolutionDeCampos,
  politicaDeDestinoDoPainel,
  type CamposEmail,
  type CamposEvolution,
} from '../../lib/alertas/configDb'
import { getConfigComunicacaoEstrita, type ConfigComunicacaoEfetiva } from './configComunicacao'

/**
 * Teste dos canais pelo painel — `POST /api/admin/communication-settings/test-email|test-whatsapp`. Envia UMA mensagem de teste usando a configuração SALVA
 * (painel > env) ou a que veio no corpo e ainda NÃO foi salva (não persiste nada). Sempre devolve um RESULTADO (`ok`/`error`) — erro do provedor é o resultado do
 * teste, não erro da rota. Nunca devolve nem loga segredo, token, host interno ou a mensagem crua da biblioteca.
 *
 * ANTI-EXFILTRAÇÃO: o teste com destino DIFERENTE do salvo (host/usuário SMTP, URL/instância da Evolution) não reaproveita o segredo salvo — o admin precisa informar o
 * segredo novo (400 `SECRET_REQUIRED_FOR_NEW_DESTINATION`). Sem isso, um token roubado apontaria o host para o servidor do atacante e receberia a senha salva.
 * ANTI-SSRF: o destino passa pela mesma trava do envio real (`core/comunicacao/destinoSeguro.ts`), inclusive a checagem na hora de conectar.
 */

export type CodigoErroTeste =
  | 'DESTINATION_BLOCKED'
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_CONNECTION_FAILED'
  | 'SMTP_TLS_REQUIRED'
  | 'SMTP_REJECTED'
  | 'WHATSAPP_AUTH_FAILED'
  | 'WHATSAPP_INSTANCE_OR_URL_NOT_FOUND'
  | 'WHATSAPP_REJECTED'
  | 'WHATSAPP_REDIRECT'
  | 'WHATSAPP_PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIGURATION'

export interface ResultadoTesteCanal {
  channel: 'email' | 'whatsapp'
  ok: boolean
  testedAt: string
  durationMs: number
  /** Só o destinatário MASCARADO (`d***@dominio.com`, `5511*****9999`). */
  to: string | null
  error: { code: CodigoErroTeste; message: string } | null
}

const TEXTO_DO_TESTE = 'Mensagem de TESTE do InnoFlow: se você recebeu isto, o canal está funcionando. Nenhuma ação é necessária.'

export function mascararEmail(email: string): string {
  const [local, dominio] = email.split('@')
  return `${(local ?? '').slice(0, 1)}***@${dominio ?? ''}`
}

export function mascararNumero(numero: string): string {
  return numero.length <= 6 ? '***' : `${numero.slice(0, 4)}*****${numero.slice(-4)}`
}

/** Traduz o `motivo` curto de `FalhaDeCanal` em código + mensagem PT-BR para o admin. */
export function classificarFalhaDeCanal(err: unknown): { code: CodigoErroTeste; message: string } {
  const motivo = err instanceof FalhaDeCanal ? err.motivo : ''
  if (motivo.startsWith('destino bloqueado')) return { code: 'DESTINATION_BLOCKED', message: 'O endereço aponta para um destino não permitido (rede interna/reservada). Use o endereço público do serviço.' }
  if (motivo.startsWith('smtp')) {
    if (/EAUTH|535|534|530/.test(motivo)) return { code: 'SMTP_AUTH_FAILED', message: 'O servidor de e-mail recusou o usuário/senha. Confira o login (Gmail exige senha de app).' }
    if (/ECONNECTION|ESOCKET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EDNS|ECONNRESET/.test(motivo)) return { code: 'SMTP_CONNECTION_FAILED', message: 'Não foi possível conectar ao servidor de e-mail. Confira o endereço, a porta, o TLS e o firewall.' }
    if (/ETLS|STARTTLS|TLS/.test(motivo)) return { code: 'SMTP_TLS_REQUIRED', message: 'O servidor não ofereceu uma conexão segura (TLS). Use a porta 465 com "TLS direto" ou 587 com STARTTLS.' }
    if (/EENVELOPE|EMESSAGE|55\d/.test(motivo)) return { code: 'SMTP_REJECTED', message: 'O servidor de e-mail recusou a mensagem (remetente ou destinatário não aceito).' }
    return { code: 'SMTP_CONNECTION_FAILED', message: 'O envio por e-mail falhou. Confira os dados do servidor.' }
  }
  if (motivo.startsWith('sem resposta')) return { code: 'TIMEOUT', message: 'O servidor não respondeu a tempo (5 s).' }
  if (motivo.startsWith('redirect')) return { code: 'WHATSAPP_REDIRECT', message: 'A URL respondeu com redirecionamento, que não é seguido por segurança. Use o endereço final (https).' }
  const http = /^http (\d{3})$/.exec(motivo)
  if (http) {
    const status = Number(http[1])
    if (status === 401 || status === 403) return { code: 'WHATSAPP_AUTH_FAILED', message: 'A Evolution API recusou a apikey. Confira a chave (global ou da instância).' }
    if (status === 404) return { code: 'WHATSAPP_INSTANCE_OR_URL_NOT_FOUND', message: 'Instância ou URL não encontrada na Evolution API. Confira o nome da instância e se ela está conectada.' }
    if (status >= 500) return { code: 'WHATSAPP_PROVIDER_ERROR', message: 'A Evolution API respondeu com erro interno. Tente de novo e confira se a instância está conectada ao WhatsApp.' }
    return { code: 'WHATSAPP_REJECTED', message: 'A Evolution API recusou a mensagem (confira o número e a versão da API 1/2).' }
  }
  return { code: 'NETWORK_ERROR', message: 'Falha de rede ao falar com o servidor.' }
}

// ------------------------------------------------------------------------------------------------ e-mail

function camposEmailEfetivos(c: ConfigComunicacaoEfetiva): { campos: CamposEmail; ilegivel: boolean } {
  if (c.linha && c.linha.emailEnabled !== null) return camposEmailDaLinha(c.linha, decryptPaymentSecret)
  const e = c.config.email
  return {
    campos: { host: e?.host ?? null, porta: e?.porta ?? null, secure: e?.secure ?? false, usuario: e?.usuario ?? null, senha: e?.senha, nomeRemetente: null, emailRemetente: e?.de ?? null, destinatarios: e?.para ?? [], minSeveridade: e?.minSeveridade ?? 'IMPORTANTE' },
    ilegivel: false,
  }
}

export async function testarEmail(input: TestEmailInput, deps: DepsDoCanalEmail = {}): Promise<ResultadoTesteCanal> {
  const inicio = performance.now()
  const efetiva = await getConfigComunicacaoEstrita()
  const base = camposEmailEfetivos(efetiva)
  const o = input.config ?? {}
  const campos: CamposEmail = {
    host: o.host ?? base.campos.host,
    porta: o.port ?? base.campos.porta,
    secure: o.secure ?? base.campos.secure,
    usuario: o.user !== undefined ? o.user : base.campos.usuario,
    senha: o.password ?? base.campos.senha,
    nomeRemetente: o.fromName !== undefined ? o.fromName : base.campos.nomeRemetente,
    emailRemetente: o.fromAddress ?? base.campos.emailRemetente,
    destinatarios: base.campos.destinatarios,
    minSeveridade: base.campos.minSeveridade,
  }
  const destinoMudou = (o.host !== undefined && o.host.toLowerCase() !== (base.campos.host ?? '').toLowerCase()) || (o.user !== undefined && (o.user ?? null) !== base.campos.usuario)
  if (destinoMudou && o.password === undefined && (base.campos.senha !== undefined || base.ilegivel)) {
    throw new AppError('Para testar outro servidor ou usuário, informe a senha (a senha salva não é reaproveitada para outro destino).', 400, 'SECRET_REQUIRED_FOR_NEW_DESTINATION', [{ field: 'config.password' }])
  }
  if (destinoMudou && o.password === undefined) campos.senha = undefined

  const para = input.to ?? campos.destinatarios[0]
  const falhaDeConfig = (message: string): ResultadoTesteCanal => ({ channel: 'email', ok: false, testedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - inicio), to: null, error: { code: 'INVALID_CONFIGURATION', message } })
  if (!para || !EMAIL_SIMPLES.test(para)) return falhaDeConfig('Informe um destinatário para o teste (ou salve ao menos um destinatário de alertas).')
  if (base.ilegivel && o.password === undefined) return falhaDeConfig('A senha SMTP salva não pôde ser decifrada (chave de cifragem trocada ou perdida): informe a senha de novo.')

  const avisos: string[] = []
  const cfg = emailDeCampos(campos, politicaDeDestinoDoPainel(process.env), avisos, { exigirDestinatarios: false })
  if (!cfg) return falhaDeConfig(avisos[0] ?? 'Configuração de e-mail incompleta.')

  try {
    await enviarPorSmtp(cfg, { subject: `[InnoFlow][INFO] teste_de_comunicacao (${env.NODE_ENV})`, text: TEXTO_DO_TESTE, para: [para] }, deps)
    return { channel: 'email', ok: true, testedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - inicio), to: mascararEmail(para), error: null }
  } catch (err) {
    return { channel: 'email', ok: false, testedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - inicio), to: mascararEmail(para), error: classificarFalhaDeCanal(err) }
  }
}

// ------------------------------------------------------------------------------------------------ WhatsApp

function camposEvolutionEfetivos(c: ConfigComunicacaoEfetiva): { campos: CamposEvolution; ilegivel: boolean } {
  if (c.linha && c.linha.whatsappEnabled !== null) return camposEvolutionDaLinha(c.linha, decryptPaymentSecret)
  const w = c.config.whatsapp
  if (w && w.provedor === 'evolution') {
    return { campos: { baseUrl: w.baseUrl, instancia: w.instancia, apikey: w.apikey, versao: w.versao, destinatarios: w.para, minSeveridade: w.minSeveridade }, ilegivel: false }
  }
  return { campos: { baseUrl: null, instancia: null, apikey: undefined, versao: 2, destinatarios: w?.para ?? [], minSeveridade: 'CRITICO' }, ilegivel: false }
}

export async function testarWhatsapp(input: TestWhatsappInput, deps: DepsDoCanalHttp = {}): Promise<ResultadoTesteCanal> {
  const inicio = performance.now()
  const efetiva = await getConfigComunicacaoEstrita()
  const base = camposEvolutionEfetivos(efetiva)
  const o = input.config ?? {}
  const campos: CamposEvolution = {
    baseUrl: o.baseUrl ?? base.campos.baseUrl,
    instancia: o.instance ?? base.campos.instancia,
    apikey: o.apiKey ?? base.campos.apikey,
    versao: o.apiVersion ?? base.campos.versao,
    destinatarios: base.campos.destinatarios,
    minSeveridade: base.campos.minSeveridade,
  }
  const norm = (u: string | null): string => (u ?? '').replace(/\/+$/, '').toLowerCase()
  const destinoMudou = (o.baseUrl !== undefined && norm(o.baseUrl) !== norm(base.campos.baseUrl)) || (o.instance !== undefined && o.instance !== base.campos.instancia)
  if (destinoMudou && o.apiKey === undefined && (base.campos.apikey !== undefined || base.ilegivel)) {
    throw new AppError('Para testar outra URL ou instância, informe a apikey (a chave salva não é reaproveitada para outro destino).', 400, 'SECRET_REQUIRED_FOR_NEW_DESTINATION', [{ field: 'config.apiKey' }])
  }
  if (destinoMudou && o.apiKey === undefined) campos.apikey = undefined

  const falhaDeConfig = (message: string): ResultadoTesteCanal => ({ channel: 'whatsapp', ok: false, testedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - inicio), to: null, error: { code: 'INVALID_CONFIGURATION', message } })
  const numero = input.to !== undefined ? normalizarNumeroWhatsapp(input.to) : (campos.destinatarios.map(normalizarNumeroWhatsapp).find((n) => n !== null) ?? null)
  if (!numero) return falhaDeConfig('Informe um número de destino para o teste (só dígitos com DDI) ou salve ao menos um destinatário de alertas.')
  if (base.ilegivel && o.apiKey === undefined) return falhaDeConfig('A apikey salva não pôde ser decifrada (chave de cifragem trocada ou perdida): informe a apikey de novo.')

  const avisos: string[] = []
  const cfg = evolutionDeCampos(campos, politicaDeDestinoDoPainel(process.env), avisos, { exigirDestinatarios: false })
  if (!cfg) return falhaDeConfig(avisos[0] ?? 'Configuração do WhatsApp incompleta.')

  try {
    await enviarPorEvolution(cfg, `*[InnoFlow][INFO] teste_de_comunicacao* (${env.NODE_ENV})\n${TEXTO_DO_TESTE}`, deps, [numero])
    return { channel: 'whatsapp', ok: true, testedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - inicio), to: mascararNumero(numero), error: null }
  } catch (err) {
    return { channel: 'whatsapp', ok: false, testedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - inicio), to: mascararNumero(numero), error: classificarFalhaDeCanal(err) }
  }
}
