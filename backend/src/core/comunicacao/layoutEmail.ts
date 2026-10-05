/**
 * Moldura de e-mail TRANSACIONAL da marca InnoFlow — reaproveitável pelos próximos e-mails (L1.6: recibo, saldo baixo, confirmação de exclusão...). PURA: recebe dados, devolve
 * `{ html, text }`; nada de I/O. Quem envia é `services/comunicacao/email.ts` (`enviarEmailTransacional`).
 *
 * Regras (todas testadas em `tests/unit/layoutEmail.test.ts`):
 *  - todo texto que entra é ESCAPADO para HTML (nome do motorista, rótulos...): nenhum campo é tratado como HTML;
 *  - o CTA só aceita `https:`/`http:` (um `javascript:` ou `data:` vindo por engano vira erro, não link);
 *  - sempre sai a versão em TEXTO PURO junto com o HTML (cliente de e-mail sem HTML, leitor de tela, filtros anti-spam que desconfiam de HTML sem texto);
 *  - HTML simples e compatível com cliente de e-mail: tabela, estilos inline, sem imagem externa/JS/CSS remoto (nada que o cliente precise baixar — e nada que vaze que o
 *    e-mail foi aberto); o link também aparece por extenso abaixo do botão (para copiar, quando o botão não funciona).
 * Cores da marca (do `index.css` do frontend): petróleo `#022439` (texto "Inno"), teal `#0D899C` (detalhe).
 */

export interface CtaDoEmail {
  rotulo: string
  url: string
}

export interface EntradaLayoutEmail {
  /** Título visível no topo do corpo. */
  titulo: string
  /** Texto curto que o cliente de e-mail mostra ao lado do assunto (opcional). */
  preheader?: string
  /** Parágrafos em TEXTO PURO (escapados aqui). `\n` dentro de um parágrafo vira quebra de linha. */
  paragrafos: readonly string[]
  cta?: CtaDoEmail
  /** Caixa de destaque ao fim (ex.: "Se não foi você, ignore este e-mail"). Texto puro. */
  aviso?: string
  /** Linha pequena no rodapé (ex.: por que a pessoa recebeu; identificação da empresa). Texto puro; `\n` vira quebra de linha. */
  rodape?: string
  /** Link discreto no rodapé (ex.: "Gerenciar notificações"). Mesma regra do CTA: só http/https. */
  linkRodape?: CtaDoEmail
}

export interface EmailMontado {
  html: string
  text: string
}

const COR_PETROLEO = '#022439'
const COR_TEAL = '#0D899C'
const COR_TEXTO = '#1f2d3a'
const COR_FUNDO = '#f2f5f7'

export function escaparHtml(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Escapa e converte quebras de linha em `<br>`. */
function textoParaHtml(texto: string): string {
  return escaparHtml(texto).replace(/\r?\n/g, '<br>')
}

function urlDoCta(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('layoutEmail: URL do botão inválida')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('layoutEmail: só http/https no botão')
  return u.toString()
}

export function layoutEmail(e: EntradaLayoutEmail): EmailMontado {
  const cta = e.cta ? { rotulo: e.cta.rotulo, url: urlDoCta(e.cta.url) } : null

  const preheader = e.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escaparHtml(e.preheader)}</div>`
    : ''
  const paragrafos = e.paragrafos
    .map((p) => `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:${COR_TEXTO};">${textoParaHtml(p)}</p>`)
    .join('')
  const botao = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 12px 0;"><tr><td style="background:${COR_PETROLEO};border-radius:8px;">` +
      `<a href="${escaparHtml(cta.url)}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${escaparHtml(cta.rotulo)}</a>` +
      `</td></tr></table>` +
      `<p style="margin:0 0 20px 0;font-size:13px;line-height:20px;color:#5b6b78;">Se o botão não funcionar, copie e cole este endereço no navegador:<br>` +
      `<span style="word-break:break-all;">${escaparHtml(cta.url)}</span></p>`
    : ''
  const aviso = e.aviso
    ? `<div style="margin:8px 0 0 0;padding:14px 16px;background:#eaf4f6;border-left:4px solid ${COR_TEAL};border-radius:4px;font-size:14px;line-height:21px;color:${COR_TEXTO};">${textoParaHtml(e.aviso)}</div>`
    : ''
  const rodape = e.rodape ? `<p style="margin:0 0 6px 0;font-size:12px;line-height:18px;color:#7a8894;">${textoParaHtml(e.rodape)}</p>` : ''
  const linkRodape = e.linkRodape ? { rotulo: e.linkRodape.rotulo, url: urlDoCta(e.linkRodape.url) } : null
  const linkRodapeHtml = linkRodape
    ? `<p style="margin:0 0 6px 0;font-size:12px;line-height:18px;color:#7a8894;"><a href="${escaparHtml(linkRodape.url)}" style="color:${COR_TEAL};text-decoration:underline;">${escaparHtml(linkRodape.rotulo)}</a></p>`
    : ''

  const html =
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaparHtml(e.titulo)}</title></head>` +
    `<body style="margin:0;padding:0;background:${COR_FUNDO};font-family:Arial,Helvetica,sans-serif;">${preheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COR_FUNDO};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">` +
    `<tr><td style="background:${COR_PETROLEO};padding:20px 28px;font-size:22px;font-weight:bold;color:#ffffff;">Inno<span style="color:${COR_TEAL};">Flow</span></td></tr>` +
    `<tr><td style="padding:28px;">` +
    `<h1 style="margin:0 0 18px 0;font-size:22px;line-height:28px;color:${COR_PETROLEO};">${escaparHtml(e.titulo)}</h1>` +
    `${paragrafos}${botao}${aviso}` +
    `</td></tr>` +
    `<tr><td style="padding:16px 28px 22px 28px;border-top:1px solid #e3e9ed;">${rodape}${linkRodapeHtml}<p style="margin:0;font-size:12px;line-height:18px;color:#7a8894;">InnoFlow — recarga de veículos elétricos.</p></td></tr>` +
    `</table></td></tr></table></body></html>`

  const linhas: string[] = ['InnoFlow', '', e.titulo, '', ...e.paragrafos.flatMap((p) => [p, ''])]
  if (cta) linhas.push(`${cta.rotulo}:`, cta.url, '')
  if (e.aviso) linhas.push(e.aviso, '')
  if (e.rodape) linhas.push('--', e.rodape)
  else linhas.push('--')
  if (linkRodape) linhas.push(`${linkRodape.rotulo}: ${linkRodape.url}`)
  linhas.push('InnoFlow — recarga de veículos elétricos.')

  return { html, text: linhas.join('\n') }
}
