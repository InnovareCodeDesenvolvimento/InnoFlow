/**
 * Origem de uma sessão iniciada pelo APP (IP e User-Agent da requisição `POST /api/me/sessions/start`) — prova para o dossiê de chargeback (L1.8). Núcleo PURO: só normaliza.
 *
 * Os limites são os das colunas (`ChargingSession.startIp VARCHAR(64)`, `startUserAgent VARCHAR(512)`): o INSERT/UPDATE da sessão NUNCA pode falhar por causa de um campo de PROVA
 * (a recarga não começaria), então a aplicação TRUNCA antes de gravar. Caractere de controle sai (o valor vem do cliente e vai para banco, dossiê e relatório).
 */

export const START_IP_MAX = 64
export const START_USER_AGENT_MAX = 512

export interface OrigemDoInicio {
  ip: string | null
  userAgent: string | null
}

function limpar(valor: unknown, max: number): string | null {
  if (typeof valor !== 'string') return null
  const semControle = [...valor].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim()
  return semControle === '' ? null : semControle.slice(0, max)
}

/** `null` quando não há nada para guardar (nem IP nem User-Agent utilizáveis). */
export function normalizarOrigemDoInicio(bruta: { ip?: unknown; userAgent?: unknown }): OrigemDoInicio | null {
  const ip = limpar(bruta.ip, START_IP_MAX)
  const userAgent = limpar(bruta.userAgent, START_USER_AGENT_MAX)
  return ip === null && userAgent === null ? null : { ip, userAgent }
}
