import type { Prisma } from '@prisma/client'
import { createRPCError } from 'ocpp-rpc'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { startTransactionReqSchema } from '../schemas/startTransaction'
import { resolveActiveTariff } from '../tariffResolution'
import { checkAuthorization } from '../authorizationCheck'
import { serializeTariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { defineOcppHandler } from './defineHandler'
import { reconferirInicioWalletSobLock } from '../../services/carteira/saldoComprometido'
import { emitSessionStarted } from '../../realtime/emit'

/**
 * F4 (2026-09-17): repete a MESMA checagem do `Authorize` (o Authorize é
 * opcional no protocolo — o carregador pode ir direto pro Start) via
 * `checkAuthorization` — saldo/Debt/status do token, tudo centralizado em
 * `avaliarInicioSessao`. `tariffSnapshot` agora inclui `TariffWindow[]`
 * (fecha o gap documentado desde a F3a). NÃO escreve mais
 * `Connector.status` aqui — a fonte de verdade do conector passa a ser só o
 * `StatusNotification` real (o write forçado aqui mentia quando o
 * carregador demorava a confirmar `Charging`).
 *
 * F5.4 (2026-09-30): quando o idTag é de um `AuthToken` VIRTUAL vinculado a
 * uma pré-autorização de cartão AUTHORIZED (`checkAuthorization` devolve
 * `cardPaymentIntent`), a MESMA escrita que cria a sessão liga
 * `PaymentIntent.chargingSessionId` e grava `paymentMode: 'CARD'` — sem
 * nenhuma chamada à Cielo aqui (decisão §2 da Nova: Authorize/StartTransaction
 * nunca chamam o gateway, só leem o que a API já deixou gravado).
 */
export const handleStartTransaction = defineOcppHandler('StartTransaction', startTransactionReqSchema, async (data, ctx) => {
  const chargePoint = await prisma.chargePoint.findUniqueOrThrow({ where: { id: ctx.chargePointId } })

  const connector = await prisma.connector.findUnique({
    where: { chargePointId_connectorId: { chargePointId: ctx.chargePointId, connectorId: data.connectorId } },
  })
  if (!connector) {
    throw createRPCError('PropertyConstraintViolation', `Conector ${data.connectorId} não está cadastrado neste charge point.`)
  }

  const { resultado, token, cardPaymentIntent } = await checkAuthorization(data.idTag, data.timestamp)
  if (resultado.decision !== 'Accepted' || !token?.userId) {
    logger.warn(
      { chargePointId: ctx.chargePointId, idTag: data.idTag, decision: resultado.decision, reason: 'reason' in resultado ? resultado.reason : undefined },
      '[ocpp] StartTransaction recusado',
    )
    // transactionId 0 é o valor convencional do spec para "não vou abrir
    // transação nenhuma" — o carregador não deve liberar a tomada.
    return { transactionId: 0, idTagInfo: { status: resultado.decision } }
  }

  const tariff = await resolveActiveTariff(connector, chargePoint)
  // Capturado numa const FORA do callback da transação: narrowing de
  // `token.userId` (via `!token?.userId` acima) não atravessa o limite de
  // uma função aninhada (`prisma.$transaction(async (tx) => ...)`) — TS
  // trata a closure como podendo ver outro valor, mesmo sendo `const`.
  const userId = token.userId

  const session = await prisma.$transaction(async (tx) => {
    // M3 (Órion): WALLET reconfere saldo + comprometido SOB O LOCK da carteira, aqui dentro, antes de a sessão existir (ver `reconferirInicioWalletSobLock`).
    if (!cardPaymentIntent) {
      const recusa = await reconferirInicioWalletSobLock(tx, userId)
      if (recusa) return recusa
    }
    const created = await tx.chargingSession.create({
      data: {
        // operatorId é reescrito por trigger a partir de connector.operatorId
        // de qualquer forma (ver schema-innoelektron.md do Cronos) — mandamos
        // ctx.operatorId (o mesmo valor, já resolvido no handshake) só para
        // satisfazer o tipo obrigatório do Prisma, não por precisar acertar.
        operatorId: ctx.operatorId,
        siteId: chargePoint.siteId,
        chargePointId: chargePoint.id,
        connectorId: connector.id,
        authTokenId: token.id,
        userId,
        status: 'STARTED',
        // F5.9: âncora de atividade do watchdog = relógio do SERVIDOR (`startedAt` abaixo é o do carregador e não serve para isso).
        lastActivityAt: new Date(),
        meterStartWh: data.meterStart,
        startedAt: data.timestamp,
        tariffId: tariff.id,
        // Congela a tarifa vigente (com as janelas ponta/fora-ponta) — sessão
        // antiga nunca recalcula com a tarifa de hoje.
        tariffSnapshot: serializeTariffSnapshot(tariff, tariff.windows) as unknown as Prisma.InputJsonValue,
        paymentMode: cardPaymentIntent ? 'CARD' : 'WALLET',
      },
    })

    if (cardPaymentIntent) {
      // Vínculo reverso: o trigger `set_payment_intent_operator_id` dispara
      // nesta mesma UPDATE (BEFORE UPDATE OF "chargingSessionId") e deriva o
      // operatorId do intent a partir desta sessão — nada a fazer aqui além
      // do UPDATE. CHECK `payment_intent_purpose_consistency` permite
      // chargingSessionId null enquanto status=AUTHORIZED, então não há
      // corrida possível aqui (o intent já está AUTHORIZED desde antes do
      // RemoteStart).
      await tx.paymentIntent.update({ where: { id: cardPaymentIntent.id }, data: { chargingSessionId: created.id } })
    }

    return created
  })

  if (typeof session === 'string') {
    logger.warn({ chargePointId: ctx.chargePointId, connectorId: data.connectorId, decision: 'Blocked', reason: session }, '[ocpp] StartTransaction recusado na reconferência sob o lock da carteira (inicialização simultânea / saldo comprometido)')
    return { transactionId: 0, idTagInfo: { status: 'Blocked' } }
  }

  logger.info(
    { chargePointId: ctx.chargePointId, connectorId: data.connectorId, transactionId: session.ocppTransactionId, userId },
    '[ocpp] StartTransaction aceito',
  )

  // Publicado DEPOIS do `create()` já ter resolvido (commit implícito de um
  // único INSERT) — nunca antes de a linha existir de verdade.
  void emitSessionStarted({ operatorId: ctx.operatorId, userId, sessionId: session.id, chargePointId: chargePoint.id }).catch((err) =>
    logger.error({ err, sessionId: session.id }, '[realtime] falha ao publicar session.started (não bloqueante)'),
  )

  return { transactionId: session.ocppTransactionId, idTagInfo: { status: 'Accepted' } }
})
