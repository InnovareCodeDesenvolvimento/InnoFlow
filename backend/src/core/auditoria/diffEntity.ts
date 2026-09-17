/**
 * Núcleo puro do log de auditoria — calcula o DIFF entre o estado "antes" e
 * "depois" de uma entidade, restrito a uma ALLOWLIST de campos (nunca
 * denylist: um campo secreto novo que ninguém lembrou de proibir some por
 * padrão, em vez de vazar por padrão). Ver decisão da Nova
 * (`.claude/agent-memory/nova/decisoes-audit-log.md`, item 3).
 *
 * Sem Prisma/Express de propósito (`core/` é domínio puro, ver
 * `eslint.config.mjs`) — testável sem banco, e reaproveitável de qualquer
 * rota/handler que precise descrever uma mudança.
 */

/** Campos que NUNCA aparecem com valor, mesmo que alguém inclua por engano numa allowlist de entidade — rede de segurança, não a defesa primária (a allowlist é). */
const ALWAYS_REDACTED_PATTERN = /(password|secret|token)/i
const ALWAYS_REDACTED_SUFFIX = /hash$/i
/** `idTag` não é totalmente proibido — mascarado, só os 4 últimos caracteres ficam visíveis (o bastante para reconhecer QUAL cartão, não o suficiente para clonar). */
const MASKED_FIELD_NAMES = new Set(['idTag'])

export type EntitySnapshot = Record<string, unknown>
export type EntityDiff = Record<string, unknown>

function isAlwaysRedacted(field: string): boolean {
  return ALWAYS_REDACTED_PATTERN.test(field) || ALWAYS_REDACTED_SUFFIX.test(field)
}

function maskValue(value: unknown): string {
  const str = String(value ?? '')
  if (str.length <= 4) return '*'.repeat(str.length)
  return `${'*'.repeat(str.length - 4)}${str.slice(-4)}`
}

function sanitizeValue(field: string, value: unknown): unknown {
  if (isAlwaysRedacted(field)) return undefined // marcador `{changed:true}` é aplicado por quem chama, sem valor algum
  if (MASKED_FIELD_NAMES.has(field)) return maskValue(value)
  return value
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return a === b
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Compara `before`/`after` restrito aos campos em `allowlist`. `before=null`
 * é CREATE (diff só com `to`); `after=null` é DELETE (diff só com `from`);
 * os dois presentes é UPDATE (diff só dos campos que mudaram). Retorna
 * `null` quando não há nada a reportar (nenhum campo permitido mudou/existe)
 * — o chamador decide se isso vira `changes: null` ou omite a chamada de
 * `.describe()` inteira.
 */
export function diffEntity(before: EntitySnapshot | null, after: EntitySnapshot | null, allowlist: readonly string[]): EntityDiff | null {
  const diff: EntityDiff = {}

  for (const field of allowlist) {
    const hasBefore = before !== null && Object.prototype.hasOwnProperty.call(before, field) && before[field] !== undefined
    const hasAfter = after !== null && Object.prototype.hasOwnProperty.call(after, field) && after[field] !== undefined

    if (isAlwaysRedacted(field)) {
      if (hasBefore || hasAfter) {
        if (before === null) {
          diff[field] = { changed: true } // create — só sabemos que um valor foi definido
        } else if (after === null) {
          diff[field] = { changed: true } // delete — não interessa o valor que sumiu
        } else if (!valuesEqual(before[field], after[field])) {
          diff[field] = { changed: true }
        }
      }
      continue
    }

    if (before === null) {
      if (hasAfter) diff[field] = { to: sanitizeValue(field, after![field]) }
      continue
    }
    if (after === null) {
      if (hasBefore) diff[field] = { from: sanitizeValue(field, before[field]) }
      continue
    }
    if (!hasBefore && !hasAfter) continue
    if (!valuesEqual(before[field], after[field])) {
      diff[field] = { from: sanitizeValue(field, before[field]), to: sanitizeValue(field, after[field]) }
    }
  }

  return Object.keys(diff).length > 0 ? diff : null
}

/** Teto de tamanho do diff gravado (`AuditLog.changes`) — acima disso, grava só o marcador, nunca trunca o JSON no meio (JSON cortado no meio de uma string quebraria o parse de quem lê depois). */
export function clampDiffSize(diff: EntityDiff | null, maxBytes: number): EntityDiff | null {
  if (diff === null) return null
  const size = Buffer.byteLength(JSON.stringify(diff), 'utf8')
  if (size <= maxBytes) return diff
  return { truncated: true }
}
