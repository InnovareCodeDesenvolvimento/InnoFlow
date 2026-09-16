import { createRPCError } from 'ocpp-rpc'
import type RpcServerClient from 'ocpp-rpc/lib/server-client'
import { logger } from '../../lib/logger'
import type { OcppHandlerCtx } from '../context'
import { handleBootNotification } from './bootNotification'
import { handleHeartbeat } from './heartbeat'
import { handleStatusNotification } from './statusNotification'
import { handleAuthorize } from './authorize'
import { handleStartTransaction } from './startTransaction'
import { handleMeterValues } from './meterValues'
import { handleStopTransaction } from './stopTransaction'

/**
 * Registra todos os handlers OCPP 1.6-J do MVP numa conexão de charge point
 * já aceita. Mensagens fora desta lista (DiagnosticsStatusNotification,
 * FirmwareStatusNotification, etc.) caem no handler coringa — respondemos
 * `NotImplemented` em vez de deixar a chamada pendurada, mas ainda assim
 * registramos o que chegou (visibilidade sobre o que os charge points reais
 * mandam além do MVP).
 */
export function registerOcppHandlers(client: RpcServerClient, ctx: OcppHandlerCtx): void {
  client.handle('BootNotification', (args) => handleBootNotification(args, ctx))
  client.handle('Heartbeat', (args) => handleHeartbeat(args, ctx))
  client.handle('StatusNotification', (args) => handleStatusNotification(args, ctx))
  client.handle('Authorize', (args) => handleAuthorize(args, ctx))
  client.handle('StartTransaction', (args) => handleStartTransaction(args, ctx))
  client.handle('MeterValues', (args) => handleMeterValues(args, ctx))
  client.handle('StopTransaction', (args) => handleStopTransaction(args, ctx))

  client.handle(({ method, params }) => {
    logger.warn({ method, params, chargePointId: ctx.chargePointId }, '[ocpp] método recebido sem handler nesta fase')
    throw createRPCError('NotImplemented', `Método ${String(method)} não é suportado nesta fase do InnoElektron.`)
  })
}
