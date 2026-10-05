import { layoutEmail } from '../comunicacao/layoutEmail'

/**
 * Os três e-mails da conta/senha (L1.3), em PT-BR, sobre a moldura `layoutEmail`. PUROS (sem I/O): devolvem `{ subject, text, html }`; o envio é de `enviarEmailTransacional`.
 * Regras de conteúdo: nada de dado sensível (nem IP, nem CPF, nem saldo); o único segredo que existe aqui é o token DENTRO do link de redefinição (no fragmento `#t=`);
 * o assunto é fixo (nunca monta cabeçalho com texto de usuário — o nome só entra no corpo, escapado pelo layout).
 */

export interface EmailPronto {
  subject: string
  text: string
  html: string
}

/** Primeiro nome, para a saudação (ou nada, se o cadastro não tem nome utilizável). */
function saudacao(nome: string | null | undefined): string {
  const primeiro = (nome ?? '').trim().split(/\s+/)[0] ?? ''
  return primeiro ? `Olá, ${primeiro.slice(0, 40)}.` : 'Olá.'
}

export function emailDeRedefinicao(e: { nome?: string | null; link: string; validadeMinutos: number }): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Redefina sua senha',
    preheader: 'Use o link para escolher uma nova senha. Ele vale por tempo limitado.',
    paragrafos: [
      saudacao(e.nome),
      'Recebemos um pedido para redefinir a senha da sua conta no InnoFlow. Clique no botão abaixo para escolher uma nova senha.',
      `O link vale por ${e.validadeMinutos} minutos e só pode ser usado uma vez.`,
    ],
    cta: { rotulo: 'Escolher nova senha', url: e.link },
    aviso: 'Se não foi você quem pediu, é só ignorar este e-mail: sua senha continua a mesma e ninguém consegue alterá-la sem este link.\nNunca compartilhe este link com ninguém.',
    rodape: 'Você recebeu este e-mail porque alguém pediu a redefinição de senha para este endereço no InnoFlow.',
  })
  return { subject: 'Redefinição de senha — InnoFlow', text, html }
}

export function emailDeAvisoGoogle(e: { nome?: string | null }): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Sua conta entra com o Google',
    preheader: 'Esta conta não tem senha própria: entre com o Google.',
    paragrafos: [
      saudacao(e.nome),
      'Alguém pediu para redefinir a senha deste e-mail no InnoFlow. Mas a sua conta entra com o Google e não tem uma senha própria.',
      'Para entrar, use o botão "Entrar com o Google" na tela de login.',
    ],
    aviso: 'Se não foi você quem pediu, é só ignorar este e-mail: nada foi alterado na sua conta.',
    rodape: 'Você recebeu este e-mail porque alguém pediu a redefinição de senha para este endereço no InnoFlow.',
  })
  return { subject: 'Sua conta InnoFlow entra com o Google', text, html }
}

/** `quando` já formatado em PT-BR (horário de Brasília) por quem chama. `linkEsqueciSenha` pode ser `null` se não houver origem pública configurada. */
export function emailDeSenhaAlterada(e: { nome?: string | null; quando: string; linkEsqueciSenha: string | null }): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Sua senha foi alterada',
    preheader: 'A senha da sua conta InnoFlow foi alterada.',
    paragrafos: [
      saudacao(e.nome),
      `A senha da sua conta no InnoFlow foi alterada em ${e.quando}. Por segurança, você foi desconectado de todos os aparelhos e precisa entrar de novo com a senha nova.`,
      'Se foi você, não precisa fazer mais nada.',
    ],
    ...(e.linkEsqueciSenha ? { cta: { rotulo: 'Não fui eu — redefinir a senha', url: e.linkEsqueciSenha } } : {}),
    aviso: 'Se você NÃO fez esta alteração, redefina a senha agora e entre em contato com o suporte do InnoFlow.',
    rodape: 'Este aviso de segurança é enviado sempre que a senha da conta muda.',
  })
  return { subject: 'Sua senha do InnoFlow foi alterada', text, html }
}

/** Data/hora em PT-BR no horário de Brasília (a pessoa lê no celular, no fuso dela — o servidor roda em UTC). */
export function formatarQuando(data: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(data).replace(',', ' às')
}
