import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { bootNotificationReqSchema } from '../schemas/bootNotification'
import { reconciliarSessaoOrfa } from '../../services/carteira/reconciliarSessaoOrfa'
import { defineOcppHandler } from './defineHandler'
import type { OcppHandlerCtx } from '../context'

export const handleBootNotification = defineOcppHandler('BootNotification', bootNotificationReqSchema, async (data, ctx) => {
  const now = new Date()

  await prisma.chargePoint.update({
    where: { id: ctx.chargePointId },
    data: {
      vendor: data.chargePointVendor,
      model: data.chargePointModel,
      serialNumber: data.chargePointSerialNumber ?? data.chargeBoxSerialNumber,
      firmwareVersion: data.firmwareVersion,
      lastBootAt: now,
      lastSeenAt: now,
    },
  })

  logger.info({ chargePointId: ctx.chargePointId, vendor: data.chargePointVendor, model: data.chargePointModel }, '[ocpp] BootNotification aceito')

  // Reconciliação de sessão órfã (F5, 2026-09-17) — fire-and-forget, DEPOIS
  // de já ter decidido a resposta abaixo: NUNCA atrasa o ack ao carregador.
  // Um carregador que reconecta (queda de energia, mau contato, reinício de
  // firmware) sem completar o `StopTransaction` deixa a `ChargingSession`
  // travada em STARTED/CHARGING/FINISHING pra sempre — nenhum outro ponto do
  // sistema hoje detecta isso. Ao reconectar (= um BootNotification novo
  // chega), é o sinal mais forte que temos de "essa sessão não vai receber
  // mais nada deste carregador" — fechamos com a última leitura de medidor
  // conhecida.
  void reconciliarSessoesOrfas(ctx).catch((err) =>
    logger.error({ err, chargePointId: ctx.chargePointId }, '[ocpp] reconciliação de sessão órfã no boot falhou (não bloqueante)'),
  )

  return {
    status: 'Accepted',
    interval: 300, // segundos entre Heartbeats — fixo no MVP, sem config por charge point ainda
    currentTime: now.toISOString(),
  }
})

const OPEN_SESSION_STATUSES = ['STARTED', 'CHARGING', 'FINISHING'] as const

/**
 * Busca sessões que ficaram abertas para este charge point e fecha cada uma
 * via `finalizarSessao` — MESMO núcleo de cálculo/débito do `StopTransaction`
 * real (ver `finalizarSessao.ts`). Na prática deveria achar 0 ou 1 sessão
 * (um conector só tem uma transação aberta por vez), mas trata como lista por
 * segurança.
 *
 * `stopReason: 'OTHER'` — não existe um valor de `StopReason` mais
 * específico tipo "conexão perdida" hoje (gap documentado, ver handoff da
 * F5); `OTHER` é o que já existe no enum.
 *
 * Cada sessão é isolada em seu próprio try/catch: uma falha ao reconciliar
 * uma sessão não pode impedir a reconciliação das demais.
 *
 * Exportada (não só chamada internamente) para o teste de integração poder
 * `await` o efeito determinístico — dentro do handler ela roda fire-and-
 * forget (`void ...catch(...)`) de propósito, então esperar a promise dela
 * resolver ali dentro do handler derrotaria o propósito de não atrasar o ack.
 */
export async function reconciliarSessoesOrfas(ctx: OcppHandlerCtx): Promise<void> {
  const openSessions = await prisma.chargingSession.findMany({
    where: { chargePointId: ctx.chargePointId, status: { in: [...OPEN_SESSION_STATUSES] } },
    select: { id: true },
  })

  for (const session of openSessions) {
    try {
      await reconciliarSessaoOrfa(session.id)
    } catch (err) {
      logger.error({ err, chargePointId: ctx.chargePointId, sessionId: session.id }, '[ocpp] falha ao reconciliar sessão órfã específica — seguindo para as demais')
    }
  }
}
