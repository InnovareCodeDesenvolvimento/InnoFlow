/**
 * Diagnóstico de SPF / DKIM / DMARC do domínio do e-mail remetente — regras PURAS (sem DNS, sem rede, sem env): recebem os TEXTOS (TXT) já consultados e devolvem um veredito em
 * PT-BR simples, para um dono que não é programador. A consulta de verdade e a orquestração moram em `services/comunicacao/verificarDominio.ts`.
 *
 * REGRA DE OURO: o valor exato do SPF e do DKIM depende do provedor do servidor de e-mail (SMTP) — este módulo NUNCA inventa esses valores, só manda pedir ao provedor. Só o DMARC tem
 * um exemplo seguro (`p=none`, que apenas monitora e não derruba nenhum e-mail).
 */

export type StatusDns = 'OK' | 'ATENCAO' | 'AUSENTE' | 'ERRO'

export interface RegistroDns {
  status: StatusDns
  /** Nome DNS que foi consultado (ex.: `_dmarc.empresa.com.br`); `null` = não consultado (DKIM sem seletor). */
  nomeConsultado: string | null
  /** O TXT encontrado, truncado; `null` quando não há. É dado público de DNS. */
  valorEncontrado: string | null
  recomendacao: string
}

// ---- domínio e seletor: nunca de input livre -------------------------------------------------------------------------------------------------------

const ROTULO = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const SUFIXOS_PROIBIDOS = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'invalid', 'example', 'onion', 'arpa']

/**
 * Domínio público de verdade: nomes de rótulos válidos, ao menos 2 rótulos, TLD só de letras, e NADA de IP, `localhost` ou sufixo interno/reservado. O domínio vem do e-mail remetente
 * configurado pelo admin, mas passa por aqui assim mesmo (a consulta DNS nunca deve ser usada para varrer a rede interna).
 */
export function dominioPublicoValido(dominio: string): boolean {
  if (dominio.length < 4 || dominio.length > 253) return false
  const d = dominio.toLowerCase()
  const rotulos = d.split('.')
  if (rotulos.length < 2) return false
  if (!rotulos.every((r) => ROTULO.test(r))) return false
  const tld = rotulos[rotulos.length - 1] as string
  if (!/^[a-z]{2,24}$/.test(tld) && !/^xn--[a-z0-9-]{1,59}$/.test(tld)) return false // também barra IPv4 (TLD numérico)
  return !SUFIXOS_PROIBIDOS.includes(tld)
}

/** Parte depois do ÚLTIMO `@`, em minúsculas, ou `null` se não for um domínio público válido. */
export function dominioDoRemetente(endereco: string | null | undefined): string | null {
  if (typeof endereco !== 'string') return null
  const t = endereco.trim()
  const i = t.lastIndexOf('@')
  if (i < 1) return null
  const d = t.slice(i + 1).toLowerCase()
  return dominioPublicoValido(d) ? d : null
}

/** Seletor DKIM: letras, dígitos e hífen (não começa nem termina com hífen), até 63 — é UM rótulo DNS, por isso nada de ponto. */
export function seletorDkimValido(seletor: string): boolean {
  return seletor.length >= 1 && seletor.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(seletor)
}

const SUFIXOS_COM_DOIS_NIVEIS = new Set(['com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'ind.br', 'eco.br', 'art.br', 'blog.br', 'co.uk', 'org.uk', 'me.uk', 'com.au', 'net.au', 'com.ar', 'com.pt', 'com.mx', 'co.za', 'co.nz', 'co.jp'])

/** Domínio "principal" (o que o dono registrou): `mail.empresa.com.br` -> `empresa.com.br`. Aproximação com lista curta de sufixos de dois níveis — usada só para HERDAR o DMARC. */
export function dominioOrganizacional(dominio: string): string {
  const r = dominio.split('.')
  const doisNiveis = r.length >= 3 && SUFIXOS_COM_DOIS_NIVEIS.has(r.slice(-2).join('.'))
  return r.slice(doisNiveis ? -3 : -2).join('.')
}

const EMAIL_GRATUITO = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br', 'proton.me', 'protonmail.com', 'zoho.com'])

export function ehDominioDeEmailGratuito(dominio: string): boolean {
  return EMAIL_GRATUITO.has(dominio.toLowerCase())
}

// ---- provedores SMTP conhecidos (só para CONFERIR o SPF, nunca para sugerir valor) ----------------------------------------------------------------------

interface ProvedorSmtp {
  nome: string
  host: RegExp
  /** O alvo de um `include:` do SPF que mostra que o provedor está autorizado. */
  incluido: RegExp
}

const PROVEDORES: readonly ProvedorSmtp[] = [
  { nome: 'Google (Gmail / Workspace)', host: /(^|\.)(smtp|smtp-relay)\.gmail\.com$/, incluido: /^_spf\.google\.com$/ },
  { nome: 'Microsoft 365 / Outlook', host: /(^|\.)(office365|outlook)\.com$/, incluido: /^spf\.protection\.outlook\.com$/ },
  { nome: 'SendGrid', host: /(^|\.)sendgrid\.net$/, incluido: /^sendgrid\.net$/ },
  { nome: 'Mailgun', host: /(^|\.)mailgun\.org$/, incluido: /^mailgun\.org$/ },
  { nome: 'Amazon SES', host: /^email-smtp\.[a-z0-9-]+\.amazonaws\.com$/, incluido: /^amazonses\.com$/ },
  { nome: 'Brevo (Sendinblue)', host: /(^|\.)(brevo\.com|sendinblue\.com)$/, incluido: /^spf\.(brevo|sendinblue)\.com$/ },
  { nome: 'Zoho Mail', host: /(^|\.)zoho(mail)?\.[a-z.]+$/, incluido: /^zoho(mail)?\./ },
  { nome: 'Postmark', host: /(^|\.)postmarkapp\.com$/, incluido: /^spf\.mtasv\.net$/ },
  { nome: 'Mandrill', host: /(^|\.)mandrillapp\.com$/, incluido: /^spf\.mandrillapp\.com$/ },
]

export function provedorSmtpConhecido(host: string | null | undefined): ProvedorSmtp | null {
  if (!host) return null
  const h = host.trim().toLowerCase()
  return PROVEDORES.find((p) => p.host.test(h)) ?? null
}

// ---- helpers ---------------------------------------------------------------------------------------------------------------------------------------

export const TAMANHO_MAXIMO_DO_VALOR = 300

/** Texto de DNS para exibir: sem caracteres de controle e truncado (com reticências). Nunca devolve mais do que o TXT público consultado. */
export function truncarValor(v: string): string {
  // eslint-disable-next-line no-control-regex -- remove controles de um texto vindo de fora
  const limpo = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return limpo.length > TAMANHO_MAXIMO_DO_VALOR ? `${limpo.slice(0, TAMANHO_MAXIMO_DO_VALOR)}…` : limpo
}

const comecaCom = (txt: string, prefixo: string): boolean => txt.trim().toLowerCase().startsWith(prefixo)

const AUSENTE_SPF =
  'Não encontrei o registro SPF do seu domínio. O SPF é uma lista, guardada no DNS do domínio, dos servidores que podem enviar e-mail em nome da sua empresa; sem ele, Gmail e Outlook costumam mandar os seus e-mails para o spam. Peça ao provedor do seu servidor de e-mail (SMTP) o valor exato do registro SPF e cadastre-o no DNS do domínio como um registro do tipo TXT.'

// ---- SPF -------------------------------------------------------------------------------------------------------------------------------------------

export function avaliarSpf(dominio: string, txts: readonly string[], provedor: ProvedorSmtp | null): RegistroDns {
  const registros = txts.filter((t) => comecaCom(t, 'v=spf1'))
  if (registros.length === 0) return { status: 'AUSENTE', nomeConsultado: dominio, valorEncontrado: null, recomendacao: AUSENTE_SPF }
  if (registros.length > 1) {
    return {
      status: 'ATENCAO',
      nomeConsultado: dominio,
      valorEncontrado: truncarValor(registros.join('  |  ')),
      recomendacao: 'Há mais de um registro SPF no seu domínio, e isso faz o SPF inteiro ser ignorado. Junte tudo em UM só registro (o provedor do seu e-mail ou o suporte do seu DNS ajudam a combinar os valores).',
    }
  }
  const registro = registros[0] as string
  const termos = registro.trim().split(/\s+/).slice(1)
  const todos = termos.find((t) => /^[+\-~?]?all$/i.test(t))
  const redireciona = termos.some((t) => /^redirect=/i.test(t))
  const incluidos = termos.filter((t) => /^\+?include:/i.test(t)).map((t) => t.slice(t.indexOf(':') + 1).toLowerCase())
  const problemas: string[] = []

  if (todos === undefined) {
    if (!redireciona) problemas.push('O registro não termina com uma regra final (como "-all" ou "~all"), então qualquer servidor pode se passar pela sua empresa. Peça ao provedor o registro completo.')
  } else if (/^\+all$/i.test(todos) || /^all$/i.test(todos)) {
    problemas.push('O registro termina com "+all", que autoriza QUALQUER servidor a enviar e-mail em nome do seu domínio — isso anula a proteção. Troque por "-all" (ou "~all").')
  } else if (/^\?all$/i.test(todos)) {
    problemas.push('O registro termina com "?all", que não protege de fato. O recomendado é terminar com "-all" (rígido) ou "~all" (mais tolerante).')
  }
  if (provedor !== null && !redireciona && !incluidos.some((i) => provedor.incluido.test(i))) {
    problemas.push(`Não vi a autorização do ${provedor.nome} (o servidor de e-mail configurado) dentro do SPF. Confirme com o provedor como ela deve aparecer; se o seu e-mail sai por outro caminho, pode ignorar este aviso.`)
  }
  if (problemas.length > 0) return { status: 'ATENCAO', nomeConsultado: dominio, valorEncontrado: truncarValor(registro), recomendacao: problemas.join(' ') }

  const rigido = todos !== undefined && /^-all$/i.test(todos)
  return {
    status: 'OK',
    nomeConsultado: dominio,
    valorEncontrado: truncarValor(registro),
    recomendacao: rigido ? 'SPF encontrado e bem configurado.' : 'SPF encontrado. Ele termina com "~all" (tolerante), que costuma ser suficiente; quando tudo estiver funcionando, "-all" é a opção mais rígida.',
  }
}

// ---- DMARC -----------------------------------------------------------------------------------------------------------------------------------------

/** Exemplo SEGURO de DMARC: só monitora (p=none), não bloqueia nenhum e-mail. O endereço que recebe os relatórios precisa ser do próprio domínio (ou o DNS do outro domínio precisa autorizar). */
export function exemploDeDmarc(rua: string): string {
  return `v=DMARC1; p=none; rua=mailto:${rua}`
}

export function avaliarDmarc(nome: string, txts: readonly string[], herdadoDe: string | null, rua: string): RegistroDns {
  const registros = txts.filter((t) => comecaCom(t, 'v=dmarc1'))
  const origem = herdadoDe ? ` (herdado do domínio principal ${herdadoDe}, que vale também para este)` : ''
  if (registros.length === 0) {
    return {
      status: 'AUSENTE',
      nomeConsultado: nome,
      valorEncontrado: null,
      recomendacao: `Não encontrei o registro DMARC. Ele diz aos provedores o que fazer com e-mails que fingem ser do seu domínio e dá relatórios de quem está enviando por você. Cadastre no DNS um registro TXT com o nome "${nome}" e o valor de exemplo (seguro, só monitora): ${exemploDeDmarc(rua)}`,
    }
  }
  if (registros.length > 1) {
    return { status: 'ATENCAO', nomeConsultado: nome, valorEncontrado: truncarValor(registros.join('  |  ')), recomendacao: 'Há mais de um registro DMARC, e isso faz o DMARC ser ignorado. Deixe apenas um.' }
  }
  const registro = registros[0] as string
  const politica = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(registro)?.[1]?.toLowerCase()
  if (politica === 'reject' || politica === 'quarantine') {
    return { status: 'OK', nomeConsultado: nome, valorEncontrado: truncarValor(registro), recomendacao: `DMARC encontrado${origem}, com política "${politica}" (protege de verdade).` }
  }
  if (politica === 'none') {
    return {
      status: 'ATENCAO',
      nomeConsultado: nome,
      valorEncontrado: truncarValor(registro),
      recomendacao: `DMARC encontrado${origem}, mas com política "none": ele só monitora e não protege ainda. Está ótimo para começar; depois de alguns dias olhando os relatórios sem problemas, suba para "quarantine".`,
    }
  }
  return { status: 'ATENCAO', nomeConsultado: nome, valorEncontrado: truncarValor(registro), recomendacao: `O DMARC encontrado${origem} não tem uma política (p=) válida. Use p=none para monitorar, p=quarantine ou p=reject para proteger.` }
}

// ---- DKIM ------------------------------------------------------------------------------------------------------------------------------------------

export function dkimSemSeletor(dominio: string): RegistroDns {
  return {
    status: 'ATENCAO',
    nomeConsultado: null,
    valorEncontrado: null,
    recomendacao: `Não conferi o DKIM porque falta o "seletor". O DKIM é uma assinatura digital nos seus e-mails; o seletor é um nome que o provedor do seu servidor de e-mail informa quando você ativa o DKIM (o registro fica em "<seletor>._domainkey.${dominio}"). Peça o seletor ao provedor, informe aqui e consulte de novo.`,
  }
}

export function avaliarDkim(nome: string, seletor: string, txts: readonly string[]): RegistroDns {
  const juntos = txts.join(' ')
  if (txts.length === 0) {
    return {
      status: 'AUSENTE',
      nomeConsultado: nome,
      valorEncontrado: null,
      recomendacao: `Não encontrei um registro DKIM com o seletor "${seletor}". Confira com o provedor do seu servidor de e-mail se o seletor está certo e peça o valor exato do registro (do tipo TXT, ou CNAME, conforme o provedor) para cadastrar no DNS com o nome "${nome}".`,
    }
  }
  const chave = /(?:^|;)\s*p\s*=\s*([^;\s]*)/i.exec(juntos)?.[1]
  if (chave === undefined) {
    return { status: 'ATENCAO', nomeConsultado: nome, valorEncontrado: truncarValor(juntos), recomendacao: 'Encontrei um registro neste nome, mas ele não parece uma chave DKIM (falta o campo "p="). Confira o valor com o provedor.' }
  }
  if (chave === '') {
    return { status: 'ATENCAO', nomeConsultado: nome, valorEncontrado: truncarValor(juntos), recomendacao: 'A chave DKIM está vazia — isso significa que ela foi desativada (revogada). Peça ao provedor uma chave nova.' }
  }
  return { status: 'OK', nomeConsultado: nome, valorEncontrado: truncarValor(juntos), recomendacao: 'DKIM encontrado: a chave pública está publicada no DNS.' }
}

// ---- resultado de uma consulta que falhou ----------------------------------------------------------------------------------------------------------

export function registroComErro(nome: string, motivo: string): RegistroDns {
  return {
    status: 'ERRO',
    nomeConsultado: nome,
    valorEncontrado: null,
    recomendacao: `Não consegui consultar o DNS agora (${motivo}). Isso não quer dizer que o registro esteja errado — tente de novo em alguns minutos.`,
  }
}

/** Códigos de erro do resolvedor que significam "este nome não tem esse registro" (e não "o DNS falhou"). */
export function erroDeDnsEhAusencia(codigo: string | undefined): boolean {
  return codigo === 'ENODATA' || codigo === 'ENOTFOUND'
}

/** Resumo da verificação: ERRO se alguma consulta falhou (não dá para concluir); senão AUSENTE > ATENCAO > OK. */
export function statusGeral(registros: readonly RegistroDns[]): StatusDns {
  if (registros.some((r) => r.status === 'ERRO')) return 'ERRO'
  if (registros.some((r) => r.status === 'AUSENTE')) return 'AUSENTE'
  if (registros.some((r) => r.status === 'ATENCAO')) return 'ATENCAO'
  return 'OK'
}
