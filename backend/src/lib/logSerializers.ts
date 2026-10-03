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
 *  1. `Failing row contains (...)`: o `DETAIL` do Postgres numa violação de constraint despeja a linha rejeitada — com os `*Ciphertext`
 *     das credenciais do gateway (truncados em 64 caracteres) — dentro da `message` do erro do Prisma (B3 da Íris). Sai tudo da linha a
 *     partir daí (o conteúdo da linha pode ter parênteses); o resto da mensagem (qual constraint/tabela) continua útil.
 *  2. `campoSensivel: "valor"` (F5.8): o erro de VALIDAÇÃO do Prisma monta a `message` (e o `stack`) com a "invocação" e os VALORES dos
 *     argumentos — `merchantKeyCiphertext: "v1:..."` saía inteiro. Troca só o valor entre aspas; o nome do campo e o resto da mensagem ficam
 *     (o erro continua diagnosticável). Usa os MESMOS nomes de `CAMPOS_SENSIVEIS` (fonte única).
 */
const NOMES_SENSIVEIS_REGEX = [...CAMPOS_SENSIVEIS].map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')
const PADRAO_CAMPO_SENSIVEL_NO_TEXTO = new RegExp(String.raw`(?<![\w-])(${NOMES_SENSIVEIS_REGEX})(\s*:\s*)"(?:[^"\\\n]|\\.)*"`, 'gi')

export function limparTextoSensivel(texto: string): string {
  return texto.replace(/Failing row contains \([^\n]*/g, LINHA_REJEITADA_OMITIDA).replace(PADRAO_CAMPO_SENSIVEL_NO_TEXTO, `$1$2"${CENSOR}"`)
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

export function mascararUrlComSegredo(url: string): string {
  const i = url.toLowerCase().indexOf(PREFIXO_WEBHOOK_CIELO)
  return i === -1 ? url : `${url.slice(0, i + PREFIXO_WEBHOOK_CIELO.length)}***`
}

/** Recebe o `req` JÁ serializado (o `pino-http` embrulha o serializer customizado com `wrapRequestSerializer`). */
export function serializarReq(req: unknown): unknown {
  if (req === null || typeof req !== 'object') return req
  const { url } = req as { url?: unknown }
  return typeof url === 'string' ? { ...req, url: mascararUrlComSegredo(url) } : req
}

export const LOG_SERIALIZERS = { err: serializarErro, req: serializarReq }
