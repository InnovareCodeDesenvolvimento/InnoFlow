/**
 * Stream SSE sintético para `/api/admin/events` e `/api/me/events` — o
 * hook real (`useRealtimeStream.ts`) fala `fetch`+`ReadableStream`, então o
 * mock precisa devolver um `ReadableStream` de verdade (não dá pra simular
 * isso com uma resposta JSON única). Objetivo: provar a integração inteira
 * (parsing + reconexão + invalidação de query) no navegador sem o backend
 * real do Vega — mesmo espírito dos outros mocks deste diretório.
 */
import { mockChargePoints, mockConnectors } from "./data"
import { getMockActiveSession } from "./meData"
import { flipNextConnector } from "./stationsData"

const TICK_MS = 5_000

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function sseFrame(event: Record<string, unknown>): Uint8Array {
  return encode(`data: ${JSON.stringify(event)}\n\n`)
}

/** Comentário SSE (`:`) — heartbeat puro, prova que a conexão está viva sem carregar evento de negócio (ver `lib/sse.ts`). */
function heartbeatFrame(): Uint8Array {
  return encode(": ping\n\n")
}

/**
 * Canal do painel admin — alterna `dashboard.dirty` (aggregate "ficou
 * velho") com `chargepoint.status` de um conector real do dataset (pra
 * exercitar `admin.entity.changed`-like invalidação sem inventar entidade
 * nova), e heartbeat puro no meio pra provar que o watchdog de 35s do
 * cliente nunca precisa disparar em uso normal.
 */
export function createAdminEventStream(): ReadableStream<Uint8Array> {
  let tick = 0
  let timer: ReturnType<typeof setInterval> | undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(heartbeatFrame())
      timer = setInterval(() => {
        tick += 1
        const occurredAt = new Date().toISOString()
        if (tick % 3 === 0) {
          controller.enqueue(sseFrame({ type: "dashboard.dirty", occurredAt }))
          return
        }
        if (tick % 3 === 1) {
          const cp = mockChargePoints[tick % mockChargePoints.length]
          const connector = mockConnectors.find((c) => c.chargePointId === cp.id)
          if (connector) {
            controller.enqueue(
              sseFrame({ type: "chargepoint.status", occurredAt, chargePointId: cp.id, connectorId: connector.connectorId, status: connector.status }),
            )
            return
          }
        }
        controller.enqueue(heartbeatFrame())
      }, TICK_MS)
    },
    cancel() {
      if (timer) clearInterval(timer)
    },
  })
}

/**
 * Canal do motorista — espelha `getMockActiveSession` (o MESMO motor que já
 * faz a sessão "progredir" pro polling de hoje, ver `meData.ts`) como
 * `session.metrics`. Sem sessão ativa, só heartbeat — não inventa energia
 * que a simulação de sessão não gerou (mesma regra do backend real: push
 * não cria dado que o carregador não mandou).
 *
 * De propósito NÃO emite `topup.updated` (F5.1): o backend real também não
 * emite esse evento ainda (ver `TopupUpdatedEvent` em `types/api.ts`), e este
 * mock existe para espelhar o contrato real, não pra inventar um caminho que
 * não existe hoje. A recarga Pix (`getMockTopup`) prova o estado "pago" por
 * POLLING (`useMeTopup`), que é o mecanismo que de fato funciona sem esse
 * evento — o handler de `topup.updated` já está pronto (`realtimeEventHandlers.ts`)
 * para o dia em que o backend passar a emiti-lo.
 */
export function createMeEventStream(userId: string): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setInterval> | undefined
  // Transições de sessão (`session.started`/`session.stopped`) — o backend real
  // as emite; sem elas o mock só provaria `session.metrics`.
  let announced: { sessionId: string; chargePointId: string } | null = null
  let tick = 0

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(heartbeatFrame())
      timer = setInterval(() => {
        tick += 1
        const occurredAt = new Date().toISOString()
        // Canal PÚBLICO de estações (`ui:ev:stations`, todo motorista logado assina): de vez em
        // quando um conector da rede vira livre↔ocupado — a lista/mapa mudam sozinhos, sem F5.
        // Primeira virada no 1º tick (5s), depois a cada 3 ticks (15s).
        if (tick === 1 || tick % 3 === 0) {
          const flipped = flipNextConnector()
          if (flipped) {
            controller.enqueue(sseFrame({ type: "chargepoint.status", occurredAt, ...flipped }))
            return
          }
        }
        const session = getMockActiveSession(userId)
        if (!session) {
          if (announced) {
            controller.enqueue(sseFrame({ type: "session.stopped", occurredAt, ...announced }))
            announced = null
            return
          }
          controller.enqueue(heartbeatFrame())
          return
        }
        if (announced?.sessionId !== session.id) {
          const chargePointId = mockChargePoints.find((cp) => cp.ocppIdentity === session.chargePoint.ocppIdentity)?.id ?? ""
          announced = { sessionId: session.id, chargePointId }
          controller.enqueue(sseFrame({ type: "session.started", occurredAt, ...announced }))
          return
        }
        controller.enqueue(
          sseFrame({
            type: "session.metrics",
            occurredAt: new Date().toISOString(),
            sessionId: session.id,
            energyWh: session.energyDeliveredWh,
            powerW: session.lastPowerW,
            soc: session.lastSoc,
            partialCostCents: session.estimatedCostCents,
          }),
        )
      }, TICK_MS)
    },
    cancel() {
      if (timer) clearInterval(timer)
    },
  })
}

export const SSE_RESPONSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const
