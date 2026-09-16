import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'

/**
 * Idempotência por `(chargePointId, ocppMessageId)` — regra da Nova (ver
 * `.claude/agent-memory/nova/decisoes-arquitetura-ocpp.md`): um charge point
 * que ficou offline pode reenfileirar e reenviar a MESMA mensagem (mesmo
 * envelope OCPP-J, mesmo messageId) ao reconectar antes de receber o ack.
 * Reprocessar geraria efeito duplicado (ex.: duas ChargingSession para o
 * mesmo StartTransaction).
 *
 * Estratégia: toda mensagem INBOUND é logada em `OcppMessage` antes de
 * processar (auditoria bruta, obrigatória neste domínio para disputa de
 * kWh). Antes de rodar a lógica de negócio, checamos se já existe uma
 * resposta OUTBOUND logada para o mesmo `(chargePointId, ocppMessageId)` —
 * se sim, devolvemos a resposta já dada, sem reexecutar `run()`.
 *
 * LIMITAÇÃO CONHECIDA (documentada, não escondida): esta checagem é uma
 * leitura antes da escrita, não uma constraint de banco — sob concorrência
 * real (duas cópias da mesma mensagem processadas em paralelo, o que só
 * aconteceria com >1 réplica no mesmo charge point, cenário que o lock de
 * `registry.ts` já deveria impedir) existe uma janela de corrida teórica.
 * Fortalecer isso com um índice único `(chargePointId, ocppMessageId,
 * direction)` em `OcppMessage` é trabalho de schema (Cronos) — sinalizado no
 * handoff desta fase, não implementado aqui para não mexer em migration já
 * entregue sem necessidade comprovada.
 */

interface WithIdempotencyOptions<T> {
  chargePointId: string
  operatorId: string
  ocppMessageId: string
  action: string
  rawPayload: unknown
  run: () => Promise<T>
}

/**
 * Tenta extrair um timestamp de evento do próprio payload OCPP (regra: tempo
 * do evento sempre do payload, nunca `Date.now()`). Usado só para a coluna
 * `occurredAt` do LOG bruto — handlers que precisam do timestamp validado
 * para escrita de negócio (ex. `ChargingSession.startedAt`) usam o valor já
 * parseado pelo schema Zod, não este helper.
 */
function extractEventTimestamp(rawPayload: unknown): Date {
  if (rawPayload && typeof rawPayload === 'object' && 'timestamp' in rawPayload) {
    const raw = (rawPayload as Record<string, unknown>).timestamp
    if (typeof raw === 'string') {
      const parsed = new Date(raw)
      if (!Number.isNaN(parsed.getTime())) return parsed
    }
  }
  return new Date()
}

async function safeLogMessage(entry: {
  chargePointId: string
  operatorId: string
  direction: 'INBOUND' | 'OUTBOUND'
  messageType: 'CALL' | 'CALL_RESULT' | 'CALL_ERROR'
  ocppMessageId: string
  action: string
  payload: unknown
  occurredAt: Date
}): Promise<void> {
  try {
    await prisma.ocppMessage.create({
      data: {
        chargePointId: entry.chargePointId,
        operatorId: entry.operatorId,
        direction: entry.direction,
        messageType: entry.messageType,
        ocppMessageId: entry.ocppMessageId,
        action: entry.action,
        payload: entry.payload as Prisma.InputJsonValue,
        occurredAt: entry.occurredAt,
      },
    })
  } catch (err) {
    // Log de auditoria NUNCA pode derrubar o handshake OCPP — se falhar,
    // registramos e seguimos (a mensagem em si já foi/será processada).
    logger.error({ err, chargePointId: entry.chargePointId, ocppMessageId: entry.ocppMessageId }, '[ocpp] falha ao gravar OcppMessage (não bloqueante)')
  }
}

export async function withIdempotency<T extends Record<string, unknown>>(opts: WithIdempotencyOptions<T>): Promise<T> {
  const { chargePointId, operatorId, ocppMessageId, action, rawPayload, run } = opts
  const occurredAt = extractEventTimestamp(rawPayload)

  await safeLogMessage({ chargePointId, operatorId, direction: 'INBOUND', messageType: 'CALL', ocppMessageId, action, payload: rawPayload, occurredAt })

  const cached = await prisma.ocppMessage.findFirst({
    where: { chargePointId, ocppMessageId, direction: 'OUTBOUND' },
    orderBy: { receivedAt: 'desc' },
  })

  if (cached) {
    logger.info({ chargePointId, ocppMessageId, action }, '[ocpp] mensagem duplicada — devolvendo resposta já processada, sem reexecutar')
    if (cached.messageType === 'CALL_ERROR') {
      const errPayload = cached.payload as { message?: string }
      throw new Error(errPayload.message ?? `${action} já havia falhado anteriormente`)
    }
    return cached.payload as T
  }

  try {
    const result = await run()
    await safeLogMessage({ chargePointId, operatorId, direction: 'OUTBOUND', messageType: 'CALL_RESULT', ocppMessageId, action, payload: result, occurredAt: new Date() })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await safeLogMessage({ chargePointId, operatorId, direction: 'OUTBOUND', messageType: 'CALL_ERROR', ocppMessageId, action, payload: { message }, occurredAt: new Date() })
    throw err
  }
}
