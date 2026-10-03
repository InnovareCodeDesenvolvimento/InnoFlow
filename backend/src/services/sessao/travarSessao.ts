import { Prisma, type ChargingSessionStatus, type SessionStopRequester } from '@prisma/client'

/**
 * Lock pessimista + conferência otimista de UMA ChargingSession (F5.9, 9b1). Todo serviço que MUDA o estado da sessão por decisão do
 * servidor (marcar não confirmada, reanimar, encerrar, pedir parada) entra aqui: trava a linha (`FOR UPDATE`), relê, e RECONFERE se a
 * foto em que a decisão se baseou ainda vale. O StopTransaction do carregador pode chegar entre o snapshot do watchdog e o lock;
 * sem esta conferência o watchdog agiria sobre uma realidade que já mudou (cobrança dupla / dois fechamentos).
 */

/** Os campos que as decisões do watchdog leem. Se QUALQUER um mudou entre o snapshot e o lock, a decisão está velha e é abortada. */
export interface FotoDaSessao {
  status: ChargingSessionStatus
  lastActivityAt: Date | null
  lastMeterValuesAt: Date | null
  stopRequestedAt: Date | null
  stopAttempts: number
  unconfirmedAt: Date | null
}

export interface SessaoTravada extends FotoDaSessao {
  id: string
  /** Preenchido SÓ no fechamento: quem vê `stoppedAt != null` numa sessão que não está STOPPED achou uma sessão RESSUSCITADA (M1). */
  stoppedAt: Date | null
  chargePointId: string
  operatorId: string
  connectorId: string
  paymentMode: 'WALLET' | 'CARD'
  stopRequestedBy: SessionStopRequester | null
  ocppTransactionId: number
  meterStartWh: number
  startedAt: Date
  createdAt: Date
}

/** Trava a linha e devolve o estado ATUAL. Só vale dentro de `prisma.$transaction`. */
export async function travarSessao(tx: Prisma.TransactionClient, sessionId: string): Promise<SessaoTravada> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "ChargingSession" WHERE id = ${sessionId} FOR UPDATE`)
  return tx.chargingSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      id: true,
      chargePointId: true,
      operatorId: true,
      connectorId: true,
      paymentMode: true,
      status: true,
      lastActivityAt: true,
      lastMeterValuesAt: true,
      stopRequestedAt: true,
      stopRequestedBy: true,
      stoppedAt: true,
      stopAttempts: true,
      unconfirmedAt: true,
      ocppTransactionId: true,
      meterStartWh: true,
      startedAt: true,
      createdAt: true,
    },
  })
}

function mesmoInstante(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b
  return a.getTime() === b.getTime()
}

/** `true` quando a linha travada ainda é exatamente a foto em que a decisão foi tomada. */
export function fotoAindaVale(atual: FotoDaSessao, esperada: FotoDaSessao): boolean {
  return (
    atual.status === esperada.status &&
    atual.stopAttempts === esperada.stopAttempts &&
    mesmoInstante(atual.lastActivityAt, esperada.lastActivityAt) &&
    mesmoInstante(atual.lastMeterValuesAt, esperada.lastMeterValuesAt) &&
    mesmoInstante(atual.stopRequestedAt, esperada.stopRequestedAt) &&
    mesmoInstante(atual.unconfirmedAt, esperada.unconfirmedAt)
  )
}
