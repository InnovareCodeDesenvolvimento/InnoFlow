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
  const ultimo = path.split('.').pop() ?? path
  return ultimo.replace(/^\["?/, '').replace(/"?\]$/, '').toLowerCase()
}

export const CAMPOS_SENSIVEIS: ReadonlySet<string> = new Set(REDACT_PATHS.map(nomeDoCampo))

/**
 * Trechos de TEXTO sensíveis. `Failing row contains (...)`: o `DETAIL` do Postgres numa violação de constraint despeja a linha
 * rejeitada — com os `*Ciphertext` das credenciais do gateway (truncados em 64 caracteres) — dentro da `message` do erro do Prisma
 * (B3 da Íris). Sai tudo da linha a partir daí (o conteúdo da linha pode ter parênteses); o resto da mensagem (qual constraint/tabela) continua útil.
 */
export function limparTextoSensivel(texto: string): string {
  return texto.replace(/Failing row contains \([^\n]*/g, LINHA_REJEITADA_OMITIDA)
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

export const LOG_SERIALIZERS = { err: serializarErro }
