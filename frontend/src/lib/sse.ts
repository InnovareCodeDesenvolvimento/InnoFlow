/**
 * Parsing puro de SSE (Server-Sent Events) — separado do transporte
 * (`hooks/useRealtimeStream.ts`) para poder testar sem `fetch`/`ReadableStream`
 * de verdade. Formato: blocos separados por linha em branco, linhas `data:`
 * concatenadas viram o payload, linhas `:...` são comentário/heartbeat (o
 * protocolo SSE usa isso para manter a conexão viva sem mandar evento real).
 */

export interface SplitSseResult {
  /** Blocos de evento completos (terminados em linha em branco). */
  events: string[]
  /** Sobra no fim do buffer — evento ainda incompleto, aguarda o próximo chunk. */
  rest: string
}

/** Quebra o buffer acumulado em blocos de evento completos + o resto (evento parcial ainda chegando). */
export function splitSseEvents(buffer: string): SplitSseResult {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n\n")
  const rest = parts.pop() ?? ""
  return { events: parts.filter((p) => p.length > 0), rest }
}

/**
 * Extrai o payload de `data:` de um bloco de evento. `null` quando o bloco é
 * só comentário/heartbeat (`:ping`) — a conexão está viva, mas não há evento
 * de negócio para despachar.
 */
export function extractSseData(rawEvent: string): string | null {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
  if (dataLines.length === 0) return null
  return dataLines.join("\n")
}
