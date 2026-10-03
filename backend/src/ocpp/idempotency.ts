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

/** Janela em que uma resposta OUTBOUND ainda vale como "replay" (ALTO-3): messageId reaproveitado depois disto é mensagem NOVA. */
export const JANELA_REPLAY_MS = 24 * 3_600_000

/**
 * Códigos de erro OCPP que são resposta DETERMINÍSTICA do nosso lado (payload inválido, propriedade fora da regra, não implementado...): repetir a mesma
 * mensagem daria o mesmo erro, então o CALL_ERROR pode ser cacheado. `GenericError`/`InternalError` e qualquer exceção que não seja RPCError (banco
 * fora, enum desconhecido, deploy rolante...) são TRANSITÓRIOS: cacheá-los fazia o carregador receber a MESMA falha para sempre, mesmo depois de o
 * problema passar (ALTO-3 do Órion — o Stop enfileirado nunca seria processado).
 */
const CODIGOS_RPC_DETERMINISTICOS = new Set([
  'FormatViolation',
  'FormationViolation',
  'PropertyConstraintViolation',
  'OccurenceConstraintViolation',
  'OccurrenceConstraintViolation',
  'TypeConstraintViolation',
  'ProtocolError',
  'NotImplemented',
  'NotSupported',
  'SecurityError',
])

export function isErroDeterministico(err: unknown): boolean {
  const codigo = err && typeof err === 'object' ? (err as { rpcErrorCode?: unknown }).rpcErrorCode : undefined
  return typeof codigo === 'string' && CODIGOS_RPC_DETERMINISTICOS.has(codigo)
}

/** JSON canônico (chaves ordenadas): o payload volta do JSONB com outra ordem de chaves, e a comparação não pode depender disso. */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor) ?? 'undefined'
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`
  const o = valor as Record<string, unknown>
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`).join(',')}}`
}

/**
 * Replay só quando é, de fato, a MESMA mensagem repetida. O `messageId` do OCPP-J só é único por conexão/tempo: firmware com contador que zera no reboot
 * (exatamente o incidente do D-A) reaproveita ids, e a versão anterior devolvia a resposta de OUTRA mensagem — o Stop enfileirado nunca executava
 * (`run()` pulado) e o carregador achava que fora confirmado. Agora o replay exige: mesmo `action`, dentro da janela de 24 h e MESMO payload INBOUND que
 * o da primeira vez. Qualquer diferença => é mensagem nova: executa.
 */
export async function withIdempotency<T extends Record<string, unknown>>(opts: WithIdempotencyOptions<T>): Promise<T> {
  const { chargePointId, operatorId, ocppMessageId, action, rawPayload, run } = opts
  const occurredAt = extractEventTimestamp(rawPayload)
  const desde = new Date(Date.now() - JANELA_REPLAY_MS)

  // O INBOUND anterior (se houver) é lido ANTES de gravar o desta chamada — senão o comparador acharia a si mesmo.
  const inboundAnterior = await prisma.ocppMessage
    .findFirst({
      where: { chargePointId, ocppMessageId, direction: 'INBOUND', action, receivedAt: { gte: desde } },
      orderBy: { receivedAt: 'desc' },
      select: { payload: true },
    })
    .catch(() => null)

  await safeLogMessage({ chargePointId, operatorId, direction: 'INBOUND', messageType: 'CALL', ocppMessageId, action, payload: rawPayload, occurredAt })

  const cached = await prisma.ocppMessage.findFirst({
    where: { chargePointId, ocppMessageId, direction: 'OUTBOUND', action, receivedAt: { gte: desde } },
    orderBy: { receivedAt: 'desc' },
  })

  // Sem INBOUND anterior para comparar (log que falhou) mantém o comportamento antigo: confia no OUTBOUND achado.
  const mesmaMensagem = cached !== null && (inboundAnterior === null || jsonCanonico(inboundAnterior.payload) === jsonCanonico(rawPayload))
  if (cached && !mesmaMensagem) {
    logger.warn({ chargePointId, ocppMessageId, action }, '[ocpp] messageId reaproveitado com payload DIFERENTE — tratado como mensagem nova (executando)')
  }

  if (cached && mesmaMensagem) {
    logger.info({ chargePointId, ocppMessageId, action }, '[ocpp] mensagem duplicada — devolvendo resposta já processada, sem reexecutar')
    if (cached.messageType === 'CALL_ERROR') {
      const errPayload = cached.payload as { message?: string; rpcErrorCode?: string }
      throw Object.assign(new Error(errPayload.message ?? `${action} já havia falhado anteriormente`), errPayload.rpcErrorCode ? { rpcErrorCode: errPayload.rpcErrorCode } : {})
    }
    return cached.payload as T
  }

  try {
    const result = await run()
    await safeLogMessage({ chargePointId, operatorId, direction: 'OUTBOUND', messageType: 'CALL_RESULT', ocppMessageId, action, payload: result, occurredAt: new Date() })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Só erro DETERMINÍSTICO é cacheado. Transitório (banco, deploy, bug) NÃO deixa rastro OUTBOUND: o próximo envio do mesmo messageId executa de novo.
    if (isErroDeterministico(err)) {
      const rpcErrorCode = (err as { rpcErrorCode: string }).rpcErrorCode
      await safeLogMessage({ chargePointId, operatorId, direction: 'OUTBOUND', messageType: 'CALL_ERROR', ocppMessageId, action, payload: { message, rpcErrorCode }, occurredAt: new Date() })
    }
    throw err
  }
}
