import { emailDeSenhaAlterada, formatarQuando, saudacao, type EmailPronto } from '../auth/emailsDeSenha'
import { layoutEmail, type CtaDoEmail } from '../comunicacao/layoutEmail'
import type { DadosPublicosDaEmpresa } from '../legal/termos'
import { ehSempreLigado, type TipoDeNotificacao } from './politica'

/**
 * Os e-mails ao motorista (L1.6), em PT-BR, sobre a moldura `layoutEmail`. PUROS: devolvem `{ subject, text, html }`; quem envia é `enviarEmailTransacional`.
 *
 * Regras de conteúdo (testadas em `tests/unit/emailsDeNotificacao.test.ts`):
 *  - o ASSUNTO é fixo ou só leva valor em reais (nunca texto vindo de gente: nome de posto, nome do motorista...);
 *  - SEM dado sensível: nenhum número de cartão (nem os 4 últimos), nenhum idTag/token, nenhum CPF, nenhum e-mail no corpo;
 *  - SEM pixel de rastreio nem imagem remota (o `layoutEmail` já garante); links só para o PWA (`<PUBLIC_APP_URL>/app/...`);
 *  - rodapé com a identificação da empresa (painel Admin > Dados da empresa; reserva: `LEGAL_*`) (L1.9): campo ausente = bloco omitido, NUNCA um CNPJ/nome inventado; e o link "Gerenciar notificações".
 * Valores em REAIS formatados (R$ 1.234,56), nunca centavos crus.
 */

export interface ContextoDoEmail {
  /** Nome do titular (só o primeiro nome entra na saudação). */
  nome: string | null
  /** Origem pública do PWA (`PUBLIC_APP_URL`); `null` = sem origem confiável => o e-mail sai SEM botão/links (nunca com link inventado). */
  baseUrl: string | null
  empresa: DadosPublicosDaEmpresa
}

/** "R$ 1.234,56" (espaço comum no lugar do NBSP do ICU, para o texto puro não ter caractere invisível). */
export function formatarReais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(new RegExp(String.fromCharCode(160), 'g'), ' ')
}

export function formatarKwh(wh: number): string {
  return `${(wh / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`
}

export function formatarDuracao(inicio: Date, fim: Date): string {
  const minutos = Math.max(0, Math.round((fim.getTime() - inicio.getTime()) / 60_000))
  if (minutos < 60) return `${minutos} min`
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  return `${h} h ${String(m).padStart(2, '0')} min`
}

function url(baseUrl: string | null, caminho: string): string | null {
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}${caminho}` : null
}

function cta(rotulo: string, destino: string | null): { cta: CtaDoEmail } | Record<string, never> {
  return destino ? { cta: { rotulo, url: destino } } : {}
}

/** Bloco de identificação da empresa (razão social, CNPJ, endereço, suporte): só o que EXISTE. Sem nenhum campo => string vazia (bloco omitido). */
export function blocoDaEmpresa(e: DadosPublicosDaEmpresa): string {
  const linhas: string[] = []
  if (e.name) linhas.push(e.name)
  if (e.cnpj) linhas.push(`CNPJ ${e.cnpj}`)
  if (e.address) linhas.push(e.address)
  const contato = [e.supportEmail, e.supportPhone].filter((v): v is string => Boolean(v))
  if (contato.length > 0) linhas.push(`Suporte: ${contato.join(' · ')}`)
  return linhas.join('\n')
}

function rodapeDoTipo(tipo: TipoDeNotificacao, ctx: ContextoDoEmail): { rodape: string; linkRodape?: CtaDoEmail } {
  const motivo = ehSempreLigado(tipo)
    ? 'Este é um aviso de segurança ou de cobrança da sua conta e é sempre enviado.'
    : 'Você recebe este aviso porque tem uma conta no InnoFlow. Dá para desativar os opcionais no seu perfil.'
  const empresa = blocoDaEmpresa(ctx.empresa)
  const gerenciar = tipo === 'ACCOUNT_DELETED' ? null : url(ctx.baseUrl, '/app/perfil') // a conta excluída não tem mais perfil para abrir
  return {
    rodape: [motivo, empresa].filter(Boolean).join('\n'),
    ...(gerenciar ? { linkRodape: { rotulo: 'Gerenciar notificações', url: gerenciar } } : {}),
  }
}

export interface ResumoDeSessao {
  sessionId: string
  /** "Posto — Carregador" (texto de cadastro; escapado pelo layout). */
  local: string
  energiaWh: number | null
  inicio: Date
  fim: Date | null
  totalCents: number
  pagamento: 'WALLET' | 'CARD'
}

function linhasDoResumo(s: ResumoDeSessao): string[] {
  const linhas = [`Local: ${s.local}`]
  if (s.energiaWh !== null) linhas.push(`Energia: ${formatarKwh(s.energiaWh)}`)
  if (s.fim) linhas.push(`Duração: ${formatarDuracao(s.inicio, s.fim)}`)
  linhas.push(`Total: ${formatarReais(s.totalCents)}`)
  linhas.push(`Pago com: ${s.pagamento === 'CARD' ? 'cartão' : 'saldo da carteira'}`)
  return [linhas.join('\n')]
}

export function emailSessaoConcluida(ctx: ContextoDoEmail, s: ResumoDeSessao): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Recarga concluída',
    preheader: `Sua recarga terminou: ${formatarReais(s.totalCents)}.`,
    paragrafos: [saudacao(ctx.nome), 'Sua recarga terminou. Aqui está o resumo:', ...linhasDoResumo(s)],
    ...cta('Ver recibo', url(ctx.baseUrl, `/app/sessoes/${encodeURIComponent(s.sessionId)}`)),
    ...rodapeDoTipo('SESSION_COMPLETED', ctx),
  })
  return { subject: `Recarga concluída — ${formatarReais(s.totalCents)} — InnoFlow`, text, html }
}

export function emailSessaoEncerradaPeloServidor(ctx: ContextoDoEmail, s: ResumoDeSessao): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Sua recarga foi encerrada pelo sistema',
    preheader: 'O carregador não confirmou o fim da recarga e o InnoFlow encerrou a sessão.',
    paragrafos: [
      saudacao(ctx.nome),
      'O carregador não confirmou o encerramento da sua recarga dentro do prazo, então o InnoFlow encerrou a sessão por conta própria, com base na última leitura de energia recebida.',
      ...linhasDoResumo(s),
      s.totalCents > 0 ? 'O valor acima já considera a energia que o carregador informou.' : 'Nenhum valor foi cobrado por esta sessão.',
    ],
    aviso: 'Se algo não parece certo, fale com o suporte informando a data e o local da recarga.',
    ...cta('Ver recibo', url(ctx.baseUrl, `/app/sessoes/${encodeURIComponent(s.sessionId)}`)),
    ...rodapeDoTipo('SESSION_CLOSED_BY_SERVER', ctx),
  })
  return { subject: 'Sua recarga foi encerrada pelo sistema — InnoFlow', text, html }
}

export function emailFalhaDeCobranca(ctx: ContextoDoEmail, f: { sessionId: string; local: string; valorCents: number }): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Não conseguimos cobrar a sua recarga',
    preheader: `Há ${formatarReais(f.valorCents)} pendentes. Regularize para voltar a carregar.`,
    paragrafos: [
      saudacao(ctx.nome),
      `Não foi possível cobrar o valor total da sua recarga em ${f.local}. Ficaram ${formatarReais(f.valorCents)} pendentes na sua conta.`,
      'Enquanto houver valor pendente, novas recargas ficam bloqueadas. Adicione saldo na carteira para quitar automaticamente — da próxima vez que um Pix for creditado, o valor pendente é descontado primeiro.',
    ],
    aviso: 'Se você acha que esta cobrança está errada, fale com o suporte antes de adicionar saldo.',
    ...cta('Adicionar saldo', url(ctx.baseUrl, '/app/carteira/adicionar')),
    ...rodapeDoTipo('SESSION_PAYMENT_FAILED', ctx),
  })
  return { subject: `Cobrança pendente: ${formatarReais(f.valorCents)} — InnoFlow`, text, html }
}

export function emailSaldoBaixo(ctx: ContextoDoEmail, s: { saldoCents: number; limiarCents: number }): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Seu saldo está baixo',
    preheader: `Saldo atual: ${formatarReais(s.saldoCents)}.`,
    paragrafos: [
      saudacao(ctx.nome),
      `O saldo da sua carteira no InnoFlow caiu para ${formatarReais(s.saldoCents)}, abaixo do limite de ${formatarReais(s.limiarCents)} que você definiu para este aviso.`,
      'Para não ser pego de surpresa na próxima recarga, vale adicionar saldo antes.',
    ],
    ...cta('Adicionar saldo', url(ctx.baseUrl, '/app/carteira/adicionar')),
    ...rodapeDoTipo('LOW_BALANCE', ctx),
  })
  return { subject: `Saldo baixo: ${formatarReais(s.saldoCents)} — InnoFlow`, text, html }
}

export function emailRecargaDeSaldoCreditada(ctx: ContextoDoEmail, s: { creditadoCents: number; quitouDividaCents: number; saldoCents: number }): EmailPronto {
  const paragrafos = [saudacao(ctx.nome), `Recebemos o seu Pix: ${formatarReais(s.creditadoCents)} foram creditados na sua carteira.`]
  if (s.quitouDividaCents > 0) paragrafos.push(`${formatarReais(s.quitouDividaCents)} foram usados para quitar valores pendentes de recargas anteriores.`)
  paragrafos.push(`Saldo atual: ${formatarReais(s.saldoCents)}.`)
  const { html, text } = layoutEmail({
    titulo: 'Saldo adicionado à sua carteira',
    preheader: `${formatarReais(s.creditadoCents)} creditados.`,
    paragrafos,
    ...cta('Ver carteira', url(ctx.baseUrl, '/app/carteira')),
    ...rodapeDoTipo('TOPUP_CREDITED', ctx),
  })
  return { subject: `Pix recebido: ${formatarReais(s.creditadoCents)} na sua carteira — InnoFlow`, text, html }
}

export function emailRecargaIniciadaPeloSuporte(ctx: ContextoDoEmail, s: { local: string; operador: string | null; quando: Date }): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Uma recarga foi iniciada na sua conta pelo suporte',
    preheader: 'A equipe de suporte iniciou uma recarga em seu nome.',
    paragrafos: [
      saudacao(ctx.nome),
      `A equipe de suporte${s.operador ? ` de ${s.operador}` : ''} pediu o início de uma recarga em ${s.local}, em seu nome, em ${formatarQuando(s.quando)}. Se o carregador aceitar, o valor será cobrado da sua carteira como qualquer outra recarga; se ele recusar, nada é cobrado.`,
    ],
    aviso: 'Se você não pediu isso ou não reconhece essa recarga, fale com o suporte.',
    ...cta('Ver minhas recargas', url(ctx.baseUrl, '/app/sessoes')),
    ...rodapeDoTipo('REMOTE_START_BY_SUPPORT', ctx),
  })
  return { subject: 'Uma recarga foi iniciada na sua conta pelo suporte — InnoFlow', text, html }
}

export function emailSenhaAlteradaDoMotorista(ctx: ContextoDoEmail, s: { quando: Date }): EmailPronto {
  const gerenciar = url(ctx.baseUrl, '/app/perfil')
  const empresa = blocoDaEmpresa(ctx.empresa)
  // A moldura e o texto de segurança são os mesmos do aviso da redefinição por e-mail (L1.3) — uma fonte só; aqui só entram a identificação da empresa e o link do perfil.
  return emailDeSenhaAlterada({
    nome: ctx.nome,
    quando: formatarQuando(s.quando),
    linkEsqueciSenha: url(ctx.baseUrl, '/esqueci-senha'),
    ...(empresa ? { rodapeAdicional: empresa } : {}),
    ...(gerenciar ? { linkRodape: { rotulo: 'Gerenciar notificações', url: gerenciar } } : {}),
  })
}

export function emailContaExcluida(ctx: ContextoDoEmail): EmailPronto {
  const { html, text } = layoutEmail({
    titulo: 'Sua conta foi excluída',
    preheader: 'Confirmamos a exclusão da sua conta InnoFlow.',
    paragrafos: [
      saudacao(ctx.nome),
      'Confirmamos a exclusão da sua conta no InnoFlow. Seus dados pessoais foram anonimizados e você não consegue mais entrar com este e-mail.',
      'Registros financeiros das recargas e dos pagamentos são mantidos, sem ligação com o seu nome, porque a lei exige guardá-los.',
      'Se a sua carteira tinha saldo, ele será devolvido por Pix à chave que você informou no pedido de exclusão; o suporte confirma quando a devolução for feita.',
    ],
    aviso: 'Se você NÃO pediu a exclusão da conta, fale com o suporte imediatamente.',
    ...rodapeDoTipo('ACCOUNT_DELETED', ctx),
  })
  return { subject: 'Sua conta InnoFlow foi excluída', text, html }
}
