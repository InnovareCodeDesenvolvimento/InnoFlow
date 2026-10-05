import { enviarPorSmtp, type DepsDoCanalEmail } from '../../lib/alertas/canais'
import { getConfigComunicacao } from './configComunicacao'
import { classificarFalhaDeCanal, type CodigoErroTeste } from './testarCanais'

/**
 * Módulo de e-mail TRANSACIONAL (notificações ao motorista, redefinição de senha — ainda não implementadas): usa a MESMA configuração SMTP do painel de comunicação
 * (painel > env, cache curto, segredo cifrado, trava de SSRF, prazo de 5 s). Quem for enviar e-mail ao motorista chama `enviarEmailTransacional` — nunca monta SMTP por conta própria.
 *
 * Nunca lança e nunca devolve segredo: o resultado é `{ ok: true }` ou `{ ok: false, code }`. NÃO passa pelo dedupe/teto dos avisos ao dono (são mensagens de natureza
 * diferente; cada fluxo decide o próprio throttle). Limite atual: o canal de e-mail só fica ATIVO com ao menos um destinatário de alerta salvo (o dono) — a mesma validação do aviso.
 */
export type ResultadoEmailTransacional = { ok: true } | { ok: false; code: CodigoErroTeste | 'EMAIL_NOT_CONFIGURED' }

export async function enviarEmailTransacional(msg: { to: string; subject: string; text: string }, deps: DepsDoCanalEmail = {}): Promise<ResultadoEmailTransacional> {
  try {
    const { config } = await getConfigComunicacao()
    if (!config.email) return { ok: false, code: 'EMAIL_NOT_CONFIGURED' }
    await enviarPorSmtp(config.email, { subject: msg.subject, text: msg.text, para: [msg.to] }, deps)
    return { ok: true }
  } catch (err) {
    return { ok: false, code: classificarFalhaDeCanal(err).code }
  }
}
