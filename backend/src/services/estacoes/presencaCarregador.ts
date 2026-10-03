import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { createLastWinsThrottle } from '../../core/estacoes/lastWinsThrottle'
import { emitChargePointStatus } from '../../realtime/emit'
import type { OcppHandlerCtx } from '../../ocpp/context'

/**
 * Presença do carregador — o que o gateway OCPP registra quando o WebSocket
 * ABRE/FECHA e a cada mensagem recebida, para a regra ÚNICA de "online"
 * (`core/estacoes/disponibilidade.ts`) refletir a realidade em vez de só a
 * passagem do tempo (Nova, decisoes-mapa-eletropostos.md — "gap real": carregador
 * que cai ficava "Disponível" no mapa por até 5 min, em silêncio).
 *
 * Princípios:
 *  - `lastSeenAt` continua sendo o fato histórico "última mensagem" — só anda
 *    PARA FRENTE (nunca é zerado/rebobinado para "simular" offline);
 *  - a queda é registrada em `disconnectedAt` (coluna própria), e a regra de
 *    online trata `disconnectedAt >= lastSeenAt` como offline;
 *  - `Connector.status` NUNCA é tocado (OCPP: desconexão não implica status de
 *    conector — o último status persistido segue valendo até o próximo
 *    `StatusNotification`);
 *  - tudo aqui é best-effort: presença jamais derruba o gateway nem atrasa o
 *    ack de mensagem (nenhuma função lança).
 */

/**
 * Avisa os canais de tempo real que o estado deste carregador mudou. Reusa o
 * evento que JÁ existe (`chargepoint.status`, payload chargePointId/
 * connectorId/status — todo público) com o status persistido de cada conector:
 * o cliente só precisa saber que "ficou velho" e refaz o fetch (o REST é a fonte
 * única, e ele já devolve `online` recalculado). Nenhum tipo de evento novo,
 * nenhuma mudança de contrato.
 */
async function notificarConectores(ctx: OcppHandlerCtx): Promise<void> {
  const connectors = await prisma.connector.findMany({ where: { chargePointId: ctx.chargePointId }, select: { connectorId: true, status: true } })
  await Promise.all(connectors.map((c) => emitChargePointStatus(ctx.operatorId, ctx.chargePointId, c.connectorId, c.status)))
}

/** Handshake autenticado + handlers registrados = prova de presença: marca "visto agora" e avisa o mapa para o carregador voltar a verde na hora. */
export async function registrarConexao(ctx: OcppHandlerCtx): Promise<void> {
  try {
    const agora = new Date()
    await touchLastSeen(ctx.chargePointId, agora)
    // M2 (Órion): RELÓGIO DO SERVIDOR da (re)conexão — o watchdog conta a janela de confirmação a partir daqui (`ChargePoint.connectedAt`).
    await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { connectedAt: agora } })
    await notificarConectores(ctx)
  } catch (err) {
    logger.error({ err, chargePointId: ctx.chargePointId }, '[ocpp][presenca] falha ao registrar conexão (não bloqueante)')
  }
}

/** `close` do WebSocket (e ninguém mais assumiu o carregador): grava a queda e avisa o mapa para o vermelho aparecer na hora. */
export async function registrarDesconexao(ctx: OcppHandlerCtx): Promise<void> {
  try {
    await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { disconnectedAt: new Date() } })
    await notificarConectores(ctx)
  } catch (err) {
    logger.error({ err, chargePointId: ctx.chargePointId }, '[ocpp][presenca] falha ao registrar desconexão (não bloqueante)')
  }
}

/**
 * `lastSeenAt` MONOTÔNICO: só avança. `updateMany` com a guarda `lastSeenAt <
 * at` evita que uma escrita atrasada (o envio adiado do throttle abaixo, ou
 * uma conexão lenta) rebobine um `lastSeenAt` que o Heartbeat/Boot já
 * avançou.
 */
async function touchLastSeen(chargePointId: string, at: Date): Promise<void> {
  await prisma.chargePoint.updateMany({
    where: { id: chargePointId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: at } }] },
    data: { lastSeenAt: at },
  })
}

/**
 * Qualquer mensagem OCPP recebida prova que o carregador está vivo — não só
 * BootNotification/Heartbeat/StatusNotification (os únicos que atualizavam
 * `lastSeenAt` antes). Sem isto, um carregador em plena sessão mandando só
 * MeterValues aparecia offline por passar do limiar sem heartbeat. Throttle
 * de 20s por carregador (bem abaixo do limiar e do heartbeat de 60s) para não
 * virar um UPDATE por MeterValues; o último instante da janela nunca se perde.
 */
const TOUCH_COALESCE_MS = 20_000
const touchThrottle = createLastWinsThrottle<Date>(TOUCH_COALESCE_MS, (chargePointId, at) => touchLastSeen(chargePointId, at), {
  onError: (err, chargePointId) => logger.error({ err, chargePointId }, '[ocpp][presenca] falha ao atualizar lastSeenAt (não bloqueante)'),
})

export function registrarMensagemRecebida(chargePointId: string): void {
  touchThrottle.push(chargePointId, new Date())
}
