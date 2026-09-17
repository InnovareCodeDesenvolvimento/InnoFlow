import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { createQueue, LIQUIDAR_SESSAO_QUEUE_NAME, type LiquidarSessaoJobData } from '../../worker/queues'
import { debitarSessao } from './walletLedger'
import { emitWalletUpdated } from '../../realtime/emit'

export interface LiquidarSessaoResultado {
  userId: string
  /** `true` só quando um `WalletEntry` novo foi de fato criado nesta chamada — idempotência/sessão gratuita/já liquidada não contam. */
  debited: boolean
  balanceAfterCents: number
}

/**
 * Liquida financeiramente uma `ChargingSession` já finalizada (STOPPED, com
 * `totalCostCents` persistido) — debita a carteira, cria `Debt` para o que
 * faltar. Chamada tanto INLINE (dentro da MESMA `$transaction` do
 * `StopTransaction`, passando `tx`) quanto pelo JOB de retry do BullMQ (sem
 * `tx` — abre a própria).
 *
 * Idempotente por construção: `debitarSessao` checa `WalletEntry`/`Debt` já
 * existentes para esta sessão antes de escrever qualquer coisa (ver
 * `walletLedger.ts`) — chamar duas vezes não duplica a cobrança.
 *
 * LIMITAÇÃO DOCUMENTADA (não escondida — mesmo espírito do gap de
 * `tariffSnapshot` sem `windows` que a F3a deixou registrado): se a
 * `$transaction` do `StopTransaction` falhar ANTES de persistir
 * `status='STOPPED'`/`totalCostCents` (ver `stopTransaction.ts`), esta
 * função não tem como recalcular o custo sozinha a partir de só o
 * `sessionId` — os dados brutos do payload OCPP (`meterStop`/`timestamp`/
 * `reason`) não estão em nenhuma coluna ainda nesse cenário (só no log bruto
 * `OcppMessage`, que esta função não lê). Nesse caso o job loga um aviso e
 * não faz nada — a convergência normal vem do próprio protocolo OCPP: um
 * carregador que não recebeu ack de `StopTransaction` reenvia a mensagem, e
 * nosso handler idempotente reprocessa do zero. Falha de infraestrutura
 * (conexão/deadlock) na escrita local simples de `status`/custo é considerada
 * baixo risco o suficiente para não justificar replicar o payload OCPP no
 * job agora — reavaliar se isso acontecer na prática.
 */
export async function liquidarSessao(sessionId: string, tx?: Prisma.TransactionClient): Promise<LiquidarSessaoResultado | null> {
  if (tx) {
    // Chamador (`finalizarSessao.ts`) é dono desta transação — NÃO publica
    // aqui (o commit ainda não aconteceu do ponto de vista de quem chamou).
    // Quem tem `tx` é responsável por publicar `wallet.updated` depois do
    // PRÓPRIO `$transaction` resolver, usando o resultado retornado aqui.
    return liquidarSessaoComTx(tx, sessionId)
  }

  // Sem `tx` (job de retry do BullMQ, worker) — este É o dono da transação:
  // publica logo depois do commit, ponto de convergência real entre API/
  // gateway (via finalizarSessao) e worker (aqui) que a Nova pediu (ver
  // decisoes-tempo-real-sse.md, item 5).
  const resultado = await prisma.$transaction((freshTx) => liquidarSessaoComTx(freshTx, sessionId))
  if (resultado?.debited) {
    await emitWalletUpdated(resultado.userId, resultado.balanceAfterCents).catch((err) =>
      logger.error({ err, sessionId }, '[realtime] falha ao publicar wallet.updated após retry de liquidação (não bloqueante)'),
    )
  }
  return resultado
}

async function liquidarSessaoComTx(tx: Prisma.TransactionClient, sessionId: string): Promise<LiquidarSessaoResultado | null> {
  const session = await tx.chargingSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, ocppTransactionId: true, operatorId: true, status: true, totalCostCents: true, site: { select: { name: true } } },
  })

  if (!session) {
    logger.error({ sessionId }, '[liquidarSessao] sessão não encontrada — nada a liquidar')
    return null
  }
  if (session.status !== 'STOPPED' || session.totalCostCents === null) {
    // Ver limitação documentada no cabeçalho — a sessão ainda não foi
    // tecnicamente finalizada (custo não persistido), não há o que debitar
    // ainda.
    logger.warn({ sessionId, status: session.status, totalCostCents: session.totalCostCents }, '[liquidarSessao] sessão ainda sem custo persistido — pulando esta tentativa')
    return null
  }

  const resultado = await debitarSessao({
    tx,
    session: { id: session.id, userId: session.userId, ocppTransactionId: session.ocppTransactionId, operatorId: session.operatorId },
    siteName: session.site.name,
    custoTotalCents: session.totalCostCents,
  })

  logger.info({ sessionId, ...resultado }, '[liquidarSessao] sessão liquidada')

  return { userId: session.userId, debited: resultado.walletEntryId !== null, balanceAfterCents: resultado.balanceAfterCents }
}

/**
 * Enfileira o retry de liquidação — chamado pelo handler `StopTransaction`
 * quando a `$transaction` inline falha. Nunca lança: falha ao enfileirar não
 * pode derrubar a resposta `Accepted` já decidida para o carregador (o
 * `catch` de quem chama já loga o suficiente).
 */
export async function enqueueLiquidarSessaoRetry(sessionId: string): Promise<void> {
  const queue = createQueue(LIQUIDAR_SESSAO_QUEUE_NAME)
  try {
    const jobData: LiquidarSessaoJobData = { sessionId }
    await queue.add('liquidar', jobData, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    })
  } finally {
    await queue.close()
  }
}
