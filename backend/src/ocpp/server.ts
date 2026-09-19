import { RPCServer } from 'ocpp-rpc'
import type RpcServerClient from 'ocpp-rpc/lib/server-client'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { registerOcppHandlers } from './handlers'
import {
  acquireChargePointLock,
  getChargePointLockOwner,
  getConnection,
  getNodeId,
  releaseChargePointLock,
  registerConnection,
  unregisterConnection,
} from './registry'
import { startCommandListener } from './commands'
import { ipKeyGenerator } from 'express-rate-limit'
import { ocppAuthRateLimiter } from './authRateLimit'
import { resolveHandshakeIp } from '../core/ocpp/clientIp'
import { env } from '../lib/env'
import { registrarConexao, registrarDesconexao } from '../services/estacoes/presencaCarregador'
import type { OcppHandlerCtx } from './context'

type AuthResult = { ok: true; ctx: OcppHandlerCtx } | { ok: false; reason: 'rate_limited' | 'invalid' }

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
    // IP do cliente com a mesma semântica de "hops" do `trust proxy` (env própria do gateway,
    // default 0 = só o socket — ver `core/ocpp/clientIp.ts`). IPv6 vira a chave de sub-rede (/56)
    // da própria lib de rate limit: um cliente IPv6 não foge do limite trocando o sufixo.
    const rawIp = resolveHandshakeIp(handshake.remoteAddress, handshake.headers['x-forwarded-for'], env.OCPP_TRUST_PROXY_HOPS)
    const clientIp = rawIp === 'unknown' ? rawIp : ipKeyGenerator(rawIp)

    void authenticateChargePoint(handshake.identity, handshake.password, { clientIp, forwardedFor: String(handshake.headers['x-forwarded-for'] ?? '').slice(0, 200) })
      .then((result) => {
        if (!result.ok) {
          if (result.reason === 'rate_limited') {
            reject(429, 'too many authentication attempts')
            return
          }
          reject(401, 'unauthorized')
          return
        }
        accept(result.ctx, 'ocpp1.6')
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

interface HandshakeInfo {
  clientIp: string
  /** Header cru, só para diagnóstico de log (conferir `OCPP_TRUST_PROXY_HOPS`) — nunca usado como decisão. */
  forwardedFor: string
}

async function authenticateChargePoint(identity: string, password: Buffer | undefined, handshake: HandshakeInfo): Promise<AuthResult> {
  const attempt = { identity, ip: handshake.clientIp }
  const logCtx = { identity, clientIp: handshake.clientIp, xForwardedFor: handshake.forwardedFor }

  // Checa ANTES de tocar o banco/bcrypt (Órion A1, 2026-09-19). Dois contadores de FALHAS:
  // (identidade + IP) — o atacante só trava o SEU par, nunca o carregador legítimo, porque a
  // identidade é pública (`GET /api/sites`) — e global por IP — o flood de identidades
  // inexistentes deixa de virar consulta ao banco + bcrypt sem freio.
  const gate = await ocppAuthRateLimiter.check(attempt)
  if (!gate.allowed) {
    if (gate.scope === 'identity_ip') {
      logger.warn({ ...logCtx, scope: gate.scope }, '[ocpp] auth: bloqueado por rate limit (identidade+IP) — tentativas demais nesta janela')
    } else {
      logger.debug({ ...logCtx, scope: gate.scope }, '[ocpp] auth: bloqueado por rate limit global do IP')
    }
    return { ok: false, reason: 'rate_limited' }
  }

  const chargePoint = await prisma.chargePoint.findUnique({ where: { ocppIdentity: identity } })

  if (!chargePoint || !chargePoint.active) {
    logger.warn(logCtx, '[ocpp] auth: charge point desconhecido ou inativo')
    await registrarFalha(attempt, logCtx, false)
    return { ok: false, reason: 'invalid' }
  }

  const providedPassword = password?.toString('utf8') ?? ''
  const passwordOk = await bcrypt.compare(providedPassword, chargePoint.basicAuthSecretHash)

  if (!passwordOk) {
    logger.warn(logCtx, '[ocpp] auth: senha incorreta')
    await registrarFalha(attempt, logCtx, true)
    return { ok: false, reason: 'invalid' }
  }

  // Sucesso: o par (identidade+IP) volta a zero — falhas antigas do carregador real não o
  // acumulam até um bloqueio. (O contador global do IP NÃO é zerado, ver authRateLimiter.ts.)
  await ocppAuthRateLimiter.clearFailures(attempt)

  return {
    ok: true,
    ctx: {
      chargePointId: chargePoint.id,
      operatorId: chargePoint.operatorId,
      ocppIdentity: chargePoint.ocppIdentity,
    },
  }
}

/**
 * Registra a falha e ALERTA (uma vez, no momento em que o bloqueio ativa): bloqueio de uma
 * identidade CONHECIDA é o sinal que interessa — ou é tentativa de adivinhar a senha de um
 * carregador real, ou é o próprio carregador com credencial errada/desatualizada (e aí o
 * operador precisa saber, antes de a frota inteira parar).
 */
async function registrarFalha(attempt: { identity: string; ip: string }, logCtx: Record<string, unknown>, identityKnown: boolean): Promise<void> {
  const outcome = await ocppAuthRateLimiter.registerFailure(attempt)
  if (outcome.identityIpBlockedNow) {
    logger.warn(
      { ...logCtx, identityKnown, failures: outcome.identityIpCount, alert: 'ocpp_auth_lockout' },
      identityKnown
        ? '[ocpp] ALERTA: identidade CONHECIDA bloqueada por falhas repetidas de autenticação (adivinhação de senha ou carregador com credencial errada)'
        : '[ocpp] auth: par identidade inexistente+IP bloqueado por falhas repetidas',
    )
  }
  if (outcome.ipBlockedNow) {
    logger.warn({ ...logCtx, failures: outcome.ipCount, alert: 'ocpp_auth_ip_flood' }, '[ocpp] ALERTA: IP bloqueado por excesso de falhas de autenticação (possível flood/varredura)')
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
    unregisterConnection(ctx.chargePointId, client) // só remove se ESTA conexão for a registrada (não apaga a de uma conexão anterior)
    await client.close({ code: 1011, reason: 'internal error during connection setup' }).catch(() => {})
    return
  }

  client.on('close', () => {
    void onClientClosed(client, ctx).catch((err) => logger.error({ err, chargePointId: ctx.chargePointId }, '[ocpp] falha ao tratar desconexão (não bloqueante)'))
  })

  // Conexão autenticada e com handlers no ar = prova de presença: marca
  // "visto agora" e avisa o mapa (canal público de estações) para o carregador
  // voltar a verde NA HORA — sem depender do BootNotification, que um carregador
  // que só reconectou o socket (sem reiniciar) não é obrigado a mandar.
  void registrarConexao(ctx)
}

/**
 * `close` do WebSocket. Três coisas, nesta ordem, cada uma protegida contra a
 * corrida de reconexão (o carregador reconecta ANTES de o `close` da conexão
 * velha chegar — timeout de TCP/ping pode levar dezenas de segundos):
 *  1. se esta conexão já NÃO é a registrada neste processo, outra mais nova
 *     assumiu — não mexe em registro, lock nem presença (antes, o `close` da
 *     velha apagava a entrada e o lock da NOVA: conexão viva e invisível para
 *     comandos remotos);
 *  2. senão, libera o registro e o lock (compare-and-delete, só se for nosso);
 *  3. registra a queda (`disconnectedAt`) e avisa o mapa — exceto se OUTRO nó
 *     já tomou o lock (multi-réplica: o carregador reconectou em outro nó e a
 *     evicção fechou esta conexão; marcar offline aí seria mentira).
 * `Connector.status` nunca é tocado: desconexão não implica status de conector.
 */
async function onClientClosed(client: RpcServerClient, ctx: OcppHandlerCtx): Promise<void> {
  logger.info({ chargePointId: ctx.chargePointId }, '[ocpp] charge point desconectado')

  if (getConnection(ctx.chargePointId) !== client) {
    logger.info({ chargePointId: ctx.chargePointId }, '[ocpp] close de conexão substituída por uma mais nova — registro, lock e presença ficam como estão')
    return
  }

  unregisterConnection(ctx.chargePointId, client)

  const lockOwner = await getChargePointLockOwner(ctx.chargePointId).catch(() => null)
  await releaseChargePointLock(ctx.chargePointId)

  if (lockOwner !== null && lockOwner !== getNodeId()) {
    logger.info({ chargePointId: ctx.chargePointId, lockOwner }, '[ocpp] carregador já foi assumido por outro nó — não registra queda')
    return
  }

  await registrarDesconexao(ctx)
}
