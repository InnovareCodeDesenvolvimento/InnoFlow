/**
 * Link direto para o detalhe de uma sessão no Admin. O detalhe é um DIÁLOGO da tela de Sessões (não há rota `/admin/sessoes/:id`): o endereço leva o id na querystring
 * (`/admin/sessoes?sessao=<id>`) e a tela abre o diálogo ao ler. Puro, sem DOM - usado pelo "Ver sessão" da recarga remota e pela tela de Sessões.
 */

export const SESSION_QUERY_PARAM = "sessao"
export const ADMIN_SESSIONS_PATH = "/admin/sessoes"

/** Formato de id que aceitamos da URL (cuid/uuid/ids do mock): letras, dígitos, `_` e `-`, de 1 a 64. Qualquer outra coisa é ignorada (não vira chamada de API). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** O id da sessão lido da querystring, ou `null` se ausente/fora do formato. */
export function readSessionParam(value: string | null): string | null {
  return value !== null && SESSION_ID_PATTERN.test(value) ? value : null
}

/** `/admin/sessoes?sessao=<id>` (o id é codificado). */
export function adminSessionPath(sessionId: string): string {
  return `${ADMIN_SESSIONS_PATH}?${SESSION_QUERY_PARAM}=${encodeURIComponent(sessionId)}`
}
