import { stdSerializers } from 'pino'
import { REDACT_PATHS } from './logRedactPaths'

/**
 * Serializer do `err` dos logs (F5.7, B5/B6 do portão do Órion) — módulo puro (sem `env`/transport), reutilizável pelo
 * `logger.ts`, pelo `pino-http` e pelos testes.
 *
 * POR QUE NÃO BASTA O `redact`: o `fast-redact` do pino só casa UM nível (`*.Campo`) e é case-sensitive. O `err` serializado
 * tem as propriedades próprias ENUMERÁVEIS do erro — ex.: `CieloHttpError.body` (o corpo de erro da Cielo, que pode ECOAR o
 * `CardNumber` enviado) — e o campo sensível fica a 2+ níveis (`err.body.Payment.CreditCard.CardNumber`): o redact não o vê.
 * Aqui o objeto do erro é varrido em PROFUNDIDADE por NOME de campo (insensível a maiúsculas), a partir da MESMA lista
 * `REDACT_PATHS` — uma única fonte de verdade para "o que é sensível". O texto (`message`/`stack`) também é limpo.
 *
 * A defesa primária continua sendo não colocar dado sensível onde ele possa vazar (`CieloHttpError.body` é não enumerável, o cliente
 * HTTP nunca loga corpo); isto é a rede de segurança para o dia em que alguém loga `{ err }` de um erro que carrega o corpo.
 */

const CENSOR = '[redacted]'
const MAX_DEPTH = 8
/** Troca o `DETAIL` inteiro (sem repetir a frase do Postgres: quem procura por ela no log não pode mais achá-la). */
export const LINHA_REJEITADA_OMITIDA = '[linha rejeitada pelo banco omitida do log]'

/** Nome do campo = último segmento do path (`*.CardNumber` -> `cardnumber`, `req.headers["set-cookie"]` -> `set-cookie`), minúsculo. */
function nomeDoCampo(path: string): string {
  // Path com colchetes (`res.headers["set-cookie"]`): o nome é o que está DENTRO deles. Olhar o colchete ANTES de partir no último `.`
  // é o que evita `headers["set-cookie` (só tirava os colchetes quando o segmento COMEÇAVA com `["`, e aqui começa com `headers`),
  // nome que nunca casava com a chave real — `set-cookie` e o header do segredo do webhook saíam em claro dentro de um `err`.
  const entreColchetes = /\["?([^"\]]+)"?\]$/.exec(path)
  const nome = entreColchetes ? entreColchetes[1]! : (path.split('.').pop() ?? path)
  return nome.toLowerCase()
}

export const CAMPOS_SENSIVEIS: ReadonlySet<string> = new Set(REDACT_PATHS.map(nomeDoCampo))

/**
 * Trechos de TEXTO sensíveis.
 *  1. O `DETAIL` do Postgres numa violação de constraint (SQLSTATE 23xxx): despeja a linha rejeitada — com os `*Ciphertext` das credenciais do
 *     gateway (truncados em 64 caracteres) — ou a chave duplicada (e-mail, idTag...) dentro da `message` do erro do Prisma (B3 da Íris). O
 *     TEXTO do detalhe é localizado pelo `lc_messages` do servidor ("Failing row contains" / "Registro que falhou contém" / ...), então casar
 *     pela frase deixava vazar em qualquer Postgres que não fosse inglês (achado da F5.9b1, PG pt-BR). Por isso a limpeza é por ESTRUTURA — os
 *     dois formatos em que o Prisma embrulha o `DbError`, ambos com rótulos que são do PRÓPRIO Prisma (não do servidor):
 *       a) `DETAIL: <texto da linha>` (erros brutos P2010 e `meta.message`) — a linha inteira depois do rótulo;
 *       b) `detail: Some("<texto>")` (erros do client como `update()`/`create()`, `PrismaClientUnknownRequestError`) — o valor entre aspas.
 *     A frase em inglês continua casada também (defesa extra para a mensagem avulsa do driver). O resto (qual constraint/tabela) continua útil.
 *  2. `campoSensivel: "valor"` (F5.8): o erro de VALIDAÇÃO do Prisma monta a `message` (e o `stack`) com a "invocação" e os VALORES dos
 *     argumentos — `merchantKeyCiphertext: "v1:..."` saía inteiro. Troca só o valor entre aspas; o nome do campo e o resto da mensagem ficam
 *     (o erro continua diagnosticável). Usa os MESMOS nomes de `CAMPOS_SENSIVEIS` (fonte única).
 */
const NOMES_SENSIVEIS_REGEX = [...CAMPOS_SENSIVEIS].map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')
const PADRAO_CAMPO_SENSIVEL_NO_TEXTO = new RegExp(String.raw`(?<![\w-])(${NOMES_SENSIVEIS_REGEX})(\s*:\s*)"(?:[^"\\\n]|\\.)*"`, 'gi')

const PADRAO_DETAIL_ROTULO = /(\bDETAIL:[ \t]*)[^\n]*/g
const PADRAO_DETAIL_DEBUG_DO_PRISMA = /(\bdetail:\s*Some\(")(?:[^"\\]|\\.)*("\))/g

export function limparTextoSensivel(texto: string): string {
  return texto
    .replace(/Failing row contains \([^\n]*/g, LINHA_REJEITADA_OMITIDA)
    .replace(PADRAO_DETAIL_ROTULO, `$1${LINHA_REJEITADA_OMITIDA}`)
    .replace(PADRAO_DETAIL_DEBUG_DO_PRISMA, `$1${LINHA_REJEITADA_OMITIDA}$2`)
    .replace(PADRAO_CAMPO_SENSIVEL_NO_TEXTO, `$1$2"${CENSOR}"`)
}

export function varrerSensivel(valor: unknown, profundidade = 0, visto: WeakSet<object> = new WeakSet()): unknown {
  if (typeof valor === 'string') return limparTextoSensivel(valor)
  if (valor === null || typeof valor !== 'object') return valor
  if (profundidade >= MAX_DEPTH) return '[truncated]'
  if (visto.has(valor)) return '[circular]'
  visto.add(valor)
  if (Array.isArray(valor)) return valor.map((item) => varrerSensivel(item, profundidade + 1, visto))
  const saida: Record<string, unknown> = {}
  for (const [chave, v] of Object.entries(valor)) {
    saida[chave] = CAMPOS_SENSIVEIS.has(chave.toLowerCase()) ? CENSOR : varrerSensivel(v, profundidade + 1, visto)
  }
  return saida
}

/** `err` do pino (`pino.stdSerializers.err`) + varredura profunda por campo sensível + limpeza do texto. Nunca lança (um serializer que lança derruba o log). */
export function serializarErro(err: unknown): unknown {
  try {
    return varrerSensivel(stdSerializers.err(err as Error))
  } catch {
    return { type: 'Error', message: '[erro não serializável]' }
  }
}

/**
 * O `pathToken` do webhook da Cielo (`/api/webhooks/cielo/<token>`) é um SEGREDO que viaja no CAMINHO: o `pino-http` loga `req.url` de TODA
 * requisição, então ele ia em claro para o stdout da API (o nginx já o mascara no access log dele, mas o log do Node é outro). `redact` não
 * serve (é por NOME de chave, aqui o segredo está no VALOR de `url`). Mascara tudo depois do prefixo, inclusive query. Defensivo: nunca lança.
 */
const PREFIXO_WEBHOOK_CIELO = '/api/webhooks/cielo/'

/**
 * O callback do "Conectar com Google" do backup (`/api/backup/google/callback?state=...&code=...`) carrega o `code` do OAuth e o `state` na QUERY: o `pino-http` logaria os dois em claro.
 * São de uso único (e o `code` só troca com o client secret), mas log não é lugar de credencial: a query some, o caminho fica.
 */
const PREFIXO_CALLBACK_GOOGLE_BACKUP = '/api/backup/google/callback'

export function mascararUrlComSegredo(url: string): string {
  const j = url.toLowerCase().indexOf(PREFIXO_CALLBACK_GOOGLE_BACKUP)
  if (j !== -1) {
    const fim = j + PREFIXO_CALLBACK_GOOGLE_BACKUP.length
    return url.length > fim ? `${url.slice(0, fim)}?***` : url
  }
  const i = url.toLowerCase().indexOf(PREFIXO_WEBHOOK_CIELO)
  return i === -1 ? url : `${url.slice(0, i + PREFIXO_WEBHOOK_CIELO.length)}***`
}

/**
 * ALLOWLIST de headers que podem ir ao log do pino-http; TODO o resto sai com o valor mascarado (o NOME fica, para saber que o header existiu). Antes era uma heurística por NOME
 * (`secret|token|key|auth...`, em inglês): um header com nome em português/neutro (`Segredo`, `Chave`, `Codigo`, `Notificacao`, `Webhook`) carregando o segredo do webhook da Cielo saía em claro. Allowlist
 * é a defesa de verdade: o que nunca foi previsto nunca vaza. Só entra aqui header que é diagnóstico de rede/requisição e jamais carrega segredo.
 */
const HEADERS_PERMITIDOS_NO_LOG: ReadonlySet<string> = new Set([
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'content-encoding',
  'accept',
  'accept-encoding',
  'accept-language',
  'connection',
  'cache-control',
  'origin',
  'referer',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
  'x-request-id',
  'cf-connecting-ip',
  'via',
])

/** `true` = o header NÃO está na allowlist (valor mascarado no log). */
export function nomeDeHeaderEhSensivel(nome: string): boolean {
  return !HEADERS_PERMITIDOS_NO_LOG.has(nome.toLowerCase())
}

export function mascararHeadersSensiveis(headers: unknown): unknown {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return headers
  const saida: Record<string, unknown> = {}
  for (const [nome, valor] of Object.entries(headers)) saida[nome] = nomeDeHeaderEhSensivel(nome) ? CENSOR : valor
  return saida
}

/** Recebe o `req` JÁ serializado (o `pino-http` embrulha o serializer customizado com `wrapRequestSerializer`). */
export function serializarReq(req: unknown): unknown {
  if (req === null || typeof req !== 'object') return req
  const { url, headers } = req as { url?: unknown; headers?: unknown }
  const saida: Record<string, unknown> = { ...(req as Record<string, unknown>) }
  if (typeof url === 'string') saida.url = mascararUrlComSegredo(url)
  if (headers !== undefined) saida.headers = mascararHeadersSensiveis(headers)
  return saida
}

export const LOG_SERIALIZERS = { err: serializarErro, req: serializarReq }
