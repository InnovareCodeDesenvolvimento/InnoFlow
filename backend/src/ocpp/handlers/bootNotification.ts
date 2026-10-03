import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { bootNotificationReqSchema } from '../schemas/bootNotification'
import { listarEstadosSessaoAberta } from '../../core/sessao/estadosSessao'
import { marcarSessaoNaoConfirmada } from '../../services/sessao/marcarSessaoNaoConfirmada'
import { OCPP_HEARTBEAT_INTERVAL_SECONDS } from '../../core/estacoes/disponibilidade'
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

  // F5.9 (2026-10-03): sessão aberta + BootNotification NÃO é mais "órfã para fechar com dinheiro". Pelo OCPP 1.6, depois de uma queda
  // de energia o carregador manda o Boot e SÓ ENTÃO o StopTransaction que guardou, com o meterStop verdadeiro — encerrar aqui cobrava a
  // menos no incidente mais comum (defeito D-A). Agora só marcamos STOP_UNCONFIRMED(CHARGER_REBOOTED): o Stop que chegar fecha
  // normalmente (stopTransaction.ts); se não chegar, o watchdog encerra pelo servidor depois da janela. Fire-and-forget, DEPOIS de
  // decidida a resposta abaixo: NUNCA atrasa o ack ao carregador.
  void marcarSessoesAbertasAposBoot(ctx).catch((err) =>
    logger.error({ err, chargePointId: ctx.chargePointId }, '[ocpp] marcação de sessões abertas após o boot falhou (não bloqueante)'),
  )

  return {
    status: 'Accepted',
    // Segundos entre Heartbeats — fixo no MVP, sem config por charge point ainda.
    // Constante ÚNICA (core/estacoes/disponibilidade.ts) porque tem que caber
    // várias vezes no limiar de "online": com 300s (== limiar) um carregador
    // saudável e ocioso piscava offline a cada ciclo.
    interval: OCPP_HEARTBEAT_INTERVAL_SECONDS,
    currentTime: now.toISOString(),
  }
})

/**
 * Marca como `STOP_UNCONFIRMED(CHARGER_REBOOTED)` toda sessão ABERTA deste charge point (constante única de estado aberto — inclui
 * FAULTED). Na prática 0 ou 1 sessão (um conector só tem uma transação aberta), mas trata como lista por segurança. NENHUM dinheiro
 * anda aqui (ver `marcarSessaoNaoConfirmada`).
 *
 * Cada sessão é isolada em seu próprio try/catch: uma falha numa não impede as demais.
 *
 * Exportada (não só chamada internamente) para o teste de integração poder `await` o efeito determinístico — dentro do handler ela roda
 * fire-and-forget de propósito.
 */
export async function marcarSessoesAbertasAposBoot(ctx: OcppHandlerCtx): Promise<void> {
  const sessoesAbertas = await prisma.chargingSession.findMany({
    where: { chargePointId: ctx.chargePointId, status: { in: listarEstadosSessaoAberta() } },
    select: { id: true },
  })

  for (const sessao of sessoesAbertas) {
    try {
      await marcarSessaoNaoConfirmada({ sessionId: sessao.id, motivo: 'CHARGER_REBOOTED' })
    } catch (err) {
      logger.error({ err, chargePointId: ctx.chargePointId, sessionId: sessao.id }, '[ocpp] falha ao marcar sessão após o boot — seguindo para as demais (o watchdog reavalia)')
    }
  }
}
