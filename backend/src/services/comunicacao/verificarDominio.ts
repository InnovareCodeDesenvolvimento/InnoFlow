import { Resolver } from 'node:dns/promises'
import { DeadlineExceededError, withDeadline } from '../../lib/withDeadline'
import {
  avaliarDkim,
  avaliarDmarc,
  avaliarSpf,
  dkimSemSeletor,
  dominioDoRemetente,
  dominioOrganizacional,
  ehDominioDeEmailGratuito,
  erroDeDnsEhAusencia,
  exemploDeDmarc,
  provedorSmtpConhecido,
  registroComErro,
  statusGeral,
  type RegistroDns,
  type StatusDns,
} from '../../core/comunicacao/dnsRemetente'

/**
 * Verificador de DNS do domínio REMETENTE (SPF / DKIM / DMARC) — `GET /api/admin/communication-settings/domain-check`. Só LÊ registros TXT públicos.
 *
 * SEGURANÇA: o domínio NUNCA vem de input livre — sai do e-mail remetente já configurado (painel > env) e ainda assim só é consultado se for um domínio público válido (nada de IP,
 * `localhost` ou sufixo interno: ver `dominioPublicoValido`). O único dado que vem do cliente é o SELETOR DKIM, validado como UM rótulo DNS. A resposta carrega apenas o TXT público
 * (truncado) e textos fixos nossos. Falha de DNS vira `ERRO` naquele registro, nunca exceção — o diagnóstico não derruba a tela.
 * O resolvedor é injetável (`ResolvedorTxt`) para os testes rodarem sem rede.
 */

/** Consulta TXT: devolve os registros (cada um já com os pedaços de 255 caracteres juntos). Erros do DNS saem como exceção com `code` (`ENODATA`, `ENOTFOUND`, `ETIMEOUT`...). */
export type ResolvedorTxt = (nome: string) => Promise<string[][]>

const PRAZO_POR_CONSULTA_MS = 4_000

/** Resolvedor padrão: o DNS do sistema, com prazo curto e poucas tentativas (um `Resolver` por chamada: sem estado compartilhado). */
export const resolvedorTxtDoSistema: ResolvedorTxt = (nome) => new Resolver({ timeout: 2_000, tries: 2 }).resolveTxt(nome)

type RespostaDeConsulta = { tipo: 'TXT'; registros: string[] } | { tipo: 'AUSENTE' } | { tipo: 'ERRO'; motivo: string }

/** Motivo curto e fixo em PT-BR (nunca a mensagem crua do resolvedor). */
function motivoCurto(err: unknown, codigo: string | undefined): string {
  if (err instanceof DeadlineExceededError || codigo === 'ETIMEOUT' || codigo === 'ETIMEDOUT') return 'o servidor de DNS não respondeu a tempo'
  if (codigo === 'ESERVFAIL') return 'o servidor de DNS devolveu erro'
  if (codigo === 'ECONNREFUSED' || codigo === 'ENOTINITIALIZED') return 'servidor de DNS inacessível'
  return 'falha na consulta'
}

async function consultar(resolver: ResolvedorTxt, nome: string): Promise<RespostaDeConsulta> {
  try {
    const partes = await withDeadline(resolver(nome), PRAZO_POR_CONSULTA_MS, `DNS TXT ${nome}`)
    return { tipo: 'TXT', registros: partes.map((p) => p.join('')) }
  } catch (err) {
    const codigo = (err as { code?: unknown } | null)?.code
    if (erroDeDnsEhAusencia(typeof codigo === 'string' ? codigo : undefined)) return { tipo: 'AUSENTE' }
    return { tipo: 'ERRO', motivo: motivoCurto(err, typeof codigo === 'string' ? codigo : undefined) }
  }
}

export interface EntradaDoVerificador {
  /** E-mail remetente já configurado (painel > env); `null` = não há. */
  remetente: string | null
  /** Host SMTP configurado (só para reconhecer o provedor). */
  smtpHost: string | null
  /** E-mail de suporte da empresa (sugestão para receber os relatórios do DMARC, se for do mesmo domínio). */
  suporteEmail: string | null
  /** Seletor DKIM (já validado pela rota); `null` = não informado. */
  seletor: string | null
  resolverTxt: ResolvedorTxt
  agora?: () => Date
}

export interface InstrucaoDeDns {
  /** Nome (host) do registro a cadastrar no DNS. */
  nome: string
  tipo: 'TXT' | 'TXT ou CNAME'
  /** Valor pronto para colar — SÓ existe para o DMARC; SPF e DKIM dependem do provedor e ficam `null` de propósito. */
  valorSugerido: string | null
  texto: string
}

export interface ResultadoDoVerificador {
  /** `false` = não há e-mail remetente (ou o domínio dele não é público): nada foi consultado. */
  senderConfigured: boolean
  domain: string | null
  smtpProvider: string | null
  /** Pior resultado entre SPF, DMARC e (se houve seletor) DKIM: ERRO > AUSENTE > ATENCAO > OK. `null` quando nada foi consultado. */
  overallStatus: StatusDns | null
  spf: RegistroDns | null
  dkim: RegistroDns | null
  dmarc: RegistroDns | null
  warnings: string[]
  instructions: { spf: InstrucaoDeDns; dkim: InstrucaoDeDns; dmarc: InstrucaoDeDns } | null
  note: string
  checkedAt: string
}

const NOTA =
  'SPF, DKIM e DMARC são configurados no painel de DNS do domínio (onde ele foi registrado: Registro.br, Cloudflare, GoDaddy etc.), não no InnoFlow. Depois de alterar, a mudança leva de alguns minutos a algumas horas para valer; consulte de novo mais tarde.'

function ruaSugerida(dominio: string, suporteEmail: string | null): string {
  const doSuporte = suporteEmail && suporteEmail.toLowerCase().endsWith(`@${dominio}`) ? suporteEmail : null
  return doSuporte ?? `dmarc@${dominio}`
}

export async function verificarDominioRemetente(entrada: EntradaDoVerificador): Promise<ResultadoDoVerificador> {
  const checkedAt = (entrada.agora?.() ?? new Date()).toISOString()
  const dominio = dominioDoRemetente(entrada.remetente)
  if (dominio === null) {
    return {
      senderConfigured: false,
      domain: null,
      smtpProvider: null,
      overallStatus: null,
      spf: null,
      dkim: null,
      dmarc: null,
      warnings: ['Cadastre primeiro o e-mail remetente (o "de") com um domínio de verdade, como aviso@suaempresa.com.br. A verificação usa o domínio dele.'],
      instructions: null,
      note: NOTA,
      checkedAt,
    }
  }

  const provedor = provedorSmtpConhecido(entrada.smtpHost)
  const principal = dominioOrganizacional(dominio)
  const nomeDmarc = `_dmarc.${dominio}`
  const nomeDkim = entrada.seletor ? `${entrada.seletor}._domainkey.${dominio}` : null
  const rua = ruaSugerida(dominio, entrada.suporteEmail)

  // As consultas são independentes: em paralelo, cada uma com prazo próprio.
  const [respSpf, respDmarc, respDmarcPrincipal, respDkim] = await Promise.all([
    consultar(entrada.resolverTxt, dominio),
    consultar(entrada.resolverTxt, nomeDmarc),
    principal !== dominio ? consultar(entrada.resolverTxt, `_dmarc.${principal}`) : Promise.resolve<RespostaDeConsulta>({ tipo: 'AUSENTE' }),
    nomeDkim ? consultar(entrada.resolverTxt, nomeDkim) : Promise.resolve<RespostaDeConsulta | null>(null),
  ])

  const spf: RegistroDns = respSpf.tipo === 'ERRO' ? registroComErro(dominio, respSpf.motivo) : avaliarSpf(dominio, respSpf.tipo === 'TXT' ? respSpf.registros : [], provedor)

  let dmarc: RegistroDns
  if (respDmarc.tipo === 'ERRO') {
    dmarc = registroComErro(nomeDmarc, respDmarc.motivo)
  } else {
    const propriosTxt = respDmarc.tipo === 'TXT' ? respDmarc.registros : []
    const temProprio = propriosTxt.some((t) => t.trim().toLowerCase().startsWith('v=dmarc1'))
    if (!temProprio && respDmarcPrincipal.tipo === 'TXT' && respDmarcPrincipal.registros.some((t) => t.trim().toLowerCase().startsWith('v=dmarc1'))) {
      dmarc = { ...avaliarDmarc(`_dmarc.${principal}`, respDmarcPrincipal.registros, principal, rua) }
    } else if (!temProprio && respDmarcPrincipal.tipo === 'ERRO') {
      dmarc = registroComErro(`_dmarc.${principal}`, respDmarcPrincipal.motivo)
    } else {
      dmarc = avaliarDmarc(nomeDmarc, propriosTxt, null, rua)
    }
  }

  let dkim: RegistroDns
  if (entrada.seletor === null || nomeDkim === null || respDkim === null) dkim = dkimSemSeletor(dominio)
  else dkim = respDkim.tipo === 'ERRO' ? registroComErro(nomeDkim, respDkim.motivo) : avaliarDkim(nomeDkim, entrada.seletor, respDkim.tipo === 'TXT' ? respDkim.registros : [])

  const considerados = entrada.seletor === null ? [spf, dmarc] : [spf, dmarc, dkim]
  const warnings: string[] = []
  if (ehDominioDeEmailGratuito(dominio)) {
    warnings.push(
      `O remetente usa um endereço de e-mail gratuito (${dominio}). SPF, DKIM e DMARC desse domínio pertencem ao provedor e você não consegue alterá-los aqui. Para e-mails de cobrança e avisos mais confiáveis, use um e-mail do domínio da sua empresa.`,
    )
  }
  if (provedor === null && entrada.smtpHost) warnings.push('Não reconheci o provedor do seu servidor de e-mail. Para saber o valor exato do SPF e do DKIM, consulte a documentação ou o suporte dele.')

  return {
    senderConfigured: true,
    domain: dominio,
    smtpProvider: provedor?.nome ?? null,
    overallStatus: statusGeral(considerados),
    spf,
    dkim,
    dmarc,
    warnings,
    instructions: {
      spf: {
        nome: dominio,
        tipo: 'TXT',
        valorSugerido: null,
        texto: 'O valor exato do SPF depende do provedor do seu servidor de e-mail (SMTP): peça a ele o registro SPF correto e cadastre-o como um registro TXT no nome do domínio. Se já existir um registro SPF, não crie um segundo: acrescente o do provedor ao que existe.',
      },
      dkim: {
        nome: entrada.seletor ? `${entrada.seletor}._domainkey.${dominio}` : `<seletor>._domainkey.${dominio}`,
        tipo: 'TXT ou CNAME',
        valorSugerido: null,
        texto: 'O DKIM é gerado pelo provedor do seu servidor de e-mail: ative-o no painel dele, copie o seletor e o valor que ele mostrar e cadastre no DNS exatamente como informado (alguns provedores pedem um registro TXT, outros um CNAME).',
      },
      dmarc: {
        nome: nomeDmarc,
        tipo: 'TXT',
        valorSugerido: exemploDeDmarc(rua),
        texto: `Exemplo seguro para começar: ele só monitora e não bloqueia nenhum e-mail. O endereço depois de "rua=mailto:" recebe os relatórios; use uma caixa do próprio domínio (${dominio}).`,
      },
    },
    note: NOTA,
    checkedAt,
  }
}
