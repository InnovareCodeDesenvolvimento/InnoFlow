import { RPCServer } from 'ocpp-rpc'
import type RpcServerClient from 'ocpp-rpc/lib/server-client'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { registerOcppHandlers } from './handlers'
import { acquireChargePointLock, releaseChargePointLock, registerConnection, unregisterConnection } from './registry'
import { startCommandListener } from './commands'
import type { OcppHandlerCtx } from './context'

/**
 * Servidor OCPP 1.6-J real (substitui o stub da Fase 0). Identidade do
 * charge point vem no path da URL (`wss://host/ocpp/{ocppIdentity}` —
 * `ocpp-rpc` já separa isso em `handshake.identity`/`handshake.endpoint`,
 * não precisamos parsear a URL na mão). Autenticação: Basic Auth (Security
 * Profile 1 do OCPP) comparado via bcrypt contra
 * `ChargePoint.basicAuthSecretHash` — NUNCA comparação direta de string.
 */
export async function startOcppServer(port: number) {
  const server = new RPCServer({
    protocols: ['ocpp1.6'],
    callTimeoutMs: 30_000,
    pingIntervalMs: 30_000,
  })

  server.auth((accept, reject, handshake) => {
    void authenticateChargePoint(handshake.identity, handshake.password)
      .then((ctx) => {
        if (!ctx) {
          reject(401, 'unauthorized')
          return
        }
        accept(ctx, 'ocpp1.6')
      })
      .catch((err) => {
        logger.error({ err, identity: handshake.identity }, '[ocpp] erro inesperado durante autenticação')
        reject(500, 'internal error')
      })
  })

  server.on('client', (client) => {
    void onClientConnected(client)
  })

  server.on('error', (err) => {
    logger.error({ err }, '[ocpp] erro no servidor RPC')
  })

  await server.listen(port)
  logger.info({ port }, '[ocpp] gateway ok')

  // Ativa o lado "recebedor" do barramento de comandos API -> carregador
  // (ver commands.ts) — precisa estar de pé antes do primeiro client
  // conectar, senão um RemoteStart chegando cedo demais não encontraria
  // ninguém escutando.
  startCommandListener()

  return server
}

async function authenticateChargePoint(identity: string, password: Buffer | undefined): Promise<OcppHandlerCtx | null> {
  const chargePoint = await prisma.chargePoint.findUnique({ where: { ocppIdentity: identity } })

  if (!chargePoint || !chargePoint.active) {
    logger.warn({ identity }, '[ocpp] auth: charge point desconhecido ou inativo')
    return null
  }

  const providedPassword = password?.toString('utf8') ?? ''
  const passwordOk = await bcrypt.compare(providedPassword, chargePoint.basicAuthSecretHash)

  if (!passwordOk) {
    logger.warn({ identity }, '[ocpp] auth: senha incorreta')
    return null
  }

  return {
    chargePointId: chargePoint.id,
    operatorId: chargePoint.operatorId,
    ocppIdentity: chargePoint.ocppIdentity,
  }
}

async function onClientConnected(client: RpcServerClient): Promise<void> {
  const ctx = client.session as OcppHandlerCtx
  logger.info({ chargePointId: ctx.chargePointId, ocppIdentity: ctx.ocppIdentity }, '[ocpp] charge point conectado')

  try {
    await acquireChargePointLock(ctx.chargePointId)
    registerConnection(ctx.chargePointId, client)
    registerOcppHandlers(client, ctx)
  } catch (err) {
    // BUG REAL corrigido 17/09/2026: esta função rodava via `void
    // onClientConnected(client)` no `server.on('client', ...)`, sem
    // try/catch. Se `acquireChargePointLock` lançasse (ex.: Redis
    // instável durante um ciclo de reconexão), a exceção era engolida em
    // silêncio e `registerOcppHandlers` nunca rodava — a conexão
    // WebSocket continuava viva (o handshake/auth já tinha sido aceito
    // antes disso), mas SEM NENHUM handler registrado. Todo
    // BootNotification/StatusNotification/etc. subsequente caía no
    // comportamento padrão do próprio `ocpp-rpc` para método sem handler
    // ("Unable to handle 'X' calls"), diferente da nossa mensagem
    // customizada do handler coringa — sintoma real observado em
    // produção: charge point "conectado" (PING respondendo) mas todo
    // comando falhando com NotImplemented. Fechamos a conexão para o
    // carregador reconectar do zero em vez de ficar zumbi para sempre.
    logger.error(
      { err, chargePointId: ctx.chargePointId, ocppIdentity: ctx.ocppIdentity },
      '[ocpp] falha ao inicializar conexão (lock/handlers) — fechando para o charge point reconectar',
    )
    unregisterConnection(ctx.chargePointId)
    await client.close({ code: 1011, reason: 'internal error during connection setup' }).catch(() => {})
    return
  }

  client.on('close', () => {
    void (async () => {
      logger.info({ chargePointId: ctx.chargePointId }, '[ocpp] charge point desconectado')
      unregisterConnection(ctx.chargePointId)
      await releaseChargePointLock(ctx.chargePointId)
    })()
  })
}
