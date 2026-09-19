import { randomUUID } from 'node:crypto'
import type RpcServerClient from 'ocpp-rpc/lib/server-client'
import { createRedisConnection } from '../lib/redis'
import { logger } from '../lib/logger'
import { env } from '../lib/env'

/**
 * Registro `chargePointId -> conexão ativa` (só as conexões vivas NESTE
 * processo) + lock anti-split-brain em Redis (`ocpp:conn:{chargePointId}`).
 *
 * Entra no MVP já com 1 réplica só (decisão da Nova): o custo é baixo e é
 * exatamente o que evita reescrever RemoteStart/Stop/Reset/Unlock quando o
 * gateway escalar para N réplicas. Com N=1, o lock nunca deveria ser
 * disputado de verdade — mas o código não assume isso: se dois nós (ou duas
 * conexões concorrentes do MESMO charge point, ex. reconexão rápida antes do
 * close anterior propagar) disputarem o mesmo `chargePointId`, o dono
 * anterior é EVICTADO (perde a conexão) e o novo dono assume.
 */

const NODE_ID = env.OCPP_NODE_ID || randomUUID()
const LOCK_TTL_MS = 30_000
const LOCK_RENEW_INTERVAL_MS = 10_000
const EVICT_CHANNEL = 'ocpp:evict'

const lockKey = (chargePointId: string): string => `ocpp:conn:${chargePointId}`

// Conexões dedicadas: `redisCmd` para comandos (SET/GET/EVAL/PUBLISH),
// `redisSub` só para subscribe — ioredis exige conexão própria por papel
// quando uma delas entra em modo subscriber (ver lib/redis.ts).
const redisCmd = createRedisConnection()
const redisSub = createRedisConnection()

const localConnections = new Map<string, RpcServerClient>()
const renewIntervals = new Map<string, NodeJS.Timeout>()

let evictionListenerReady = false

function ensureEvictionListener(): void {
  if (evictionListenerReady) return
  evictionListenerReady = true

  redisSub.subscribe(EVICT_CHANNEL).catch((err) => {
    logger.error({ err }, '[ocpp][registry] falha ao assinar canal de evicção — anti-split-brain comprometido')
  })

  redisSub.on('message', (channel, message) => {
    if (channel !== EVICT_CHANNEL) return
    try {
      const { chargePointId, byNode } = JSON.parse(message) as { chargePointId: string; byNode: string }
      if (byNode === NODE_ID) return // fomos nós que publicamos — ignora o próprio eco

      const existing = localConnections.get(chargePointId)
      if (existing) {
        logger.warn(
          { chargePointId, byNode, nodeId: NODE_ID },
          '[ocpp][registry] evicção recebida — outro nó tomou este charge point, fechando conexão local',
        )
        existing.close({ code: 4000, reason: 'evicted: reconnected on another node' }).catch((err) => {
          logger.error({ err, chargePointId }, '[ocpp][registry] falha ao fechar conexão evictada')
        })
      }
    } catch (err) {
      logger.error({ err, message }, '[ocpp][registry] mensagem de evicção malformada')
    }
  })
}

function clearRenewal(chargePointId: string): void {
  const existing = renewIntervals.get(chargePointId)
  if (existing) {
    clearInterval(existing)
    renewIntervals.delete(chargePointId)
  }
}

function scheduleRenewal(chargePointId: string): void {
  clearRenewal(chargePointId)
  const interval = setInterval(() => {
    void renewLock(chargePointId)
  }, LOCK_RENEW_INTERVAL_MS)
  interval.unref?.()
  renewIntervals.set(chargePointId, interval)
}

async function renewLock(chargePointId: string): Promise<void> {
  try {
    // Só renova se ainda formos os donos — evita renovar um lock que já foi
    // tomado por outro nó sem esta instância ter percebido ainda (ela só
    // saberia via o evento de evicção, que é best-effort).
    const script = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end'
    const renewed = await redisCmd.eval(script, 1, lockKey(chargePointId), NODE_ID, String(LOCK_TTL_MS))
    if (renewed === 0) {
      logger.warn({ chargePointId, nodeId: NODE_ID }, '[ocpp][registry] perdemos a posse do lock durante renovação')
    }
  } catch (err) {
    logger.error({ err, chargePointId }, '[ocpp][registry] falha ao renovar lock')
  }
}

/**
 * Toma o lock do charge point para este nó. Se já pertencer a outro dono
 * (outro nó, ou este mesmo nó com uma conexão anterior ainda não limpa),
 * publica evicção e assume à força — nunca bloqueia a conexão nova
 * indefinidamente esperando o lock, porque o carregador está na linha
 * agorinha.
 */
export async function acquireChargePointLock(chargePointId: string): Promise<void> {
  ensureEvictionListener()

  const key = lockKey(chargePointId)
  const acquired = await redisCmd.set(key, NODE_ID, 'PX', LOCK_TTL_MS, 'NX')

  if (acquired === 'OK') {
    scheduleRenewal(chargePointId)
    return
  }

  const currentOwner = await redisCmd.get(key)
  logger.warn({ chargePointId, currentOwner, nodeId: NODE_ID }, '[ocpp][registry] lock já tomado — evictando dono anterior e assumindo')

  await redisCmd.publish(EVICT_CHANNEL, JSON.stringify({ chargePointId, byNode: NODE_ID }))
  await redisCmd.set(key, NODE_ID, 'PX', LOCK_TTL_MS)
  scheduleRenewal(chargePointId)
}

export async function releaseChargePointLock(chargePointId: string): Promise<void> {
  clearRenewal(chargePointId)
  try {
    const script = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'
    await redisCmd.eval(script, 1, lockKey(chargePointId), NODE_ID)
  } catch (err) {
    logger.error({ err, chargePointId }, '[ocpp][registry] falha ao liberar lock')
  }
}

export function registerConnection(chargePointId: string, client: RpcServerClient): void {
  localConnections.set(chargePointId, client)
}

/**
 * Remove a conexão do registro local. Com `client`, só remove se ELE ainda for
 * a conexão registrada — o `close` de uma conexão VELHA (o carregador já
 * reconectou e a nova já se registrou) não pode apagar a entrada da nova, senão
 * comandos remotos deixam de achar o carregador (conexão "zumbi"). Devolve se
 * removeu.
 */
export function unregisterConnection(chargePointId: string, client?: RpcServerClient): boolean {
  if (client && localConnections.get(chargePointId) !== client) return false
  return localConnections.delete(chargePointId)
}

/** `true` se `client` é a conexão atualmente registrada neste processo para o charge point. */
export function isRegisteredConnection(chargePointId: string, client: RpcServerClient): boolean {
  return localConnections.get(chargePointId) === client
}

/** Dono atual do lock de conexão (id do nó) ou `null` se ninguém segura — usado no `close` para saber se OUTRO nó já assumiu o carregador. */
export async function getChargePointLockOwner(chargePointId: string): Promise<string | null> {
  return redisCmd.get(lockKey(chargePointId))
}

export function getConnection(chargePointId: string): RpcServerClient | undefined {
  return localConnections.get(chargePointId)
}

export function getNodeId(): string {
  return NODE_ID
}
