import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import bcrypt from 'bcryptjs'
import WebSocket from 'ws'
import { RPCClient } from 'ocpp-rpc'

import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { env } from '../../src/lib/env'
import { startOcppServer } from '../../src/ocpp/server'
import { createTenant, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * N-10 (Órion, 05/10/2026) — gateway OCPP REAL (handshake WebSocket de verdade, Postgres e Redis reais):
 *  1. flood de mensagens válidas na mesma conexão -> fechada com 1008 + log `alert: ocpp_message_flood`; o vizinho segue vivo;
 *  2. mensagens malformadas SEGUIDAS (> maxBadMessages) -> fechada com 1002; poucas e intercaladas com boas, NÃO;
 *  3. o fluxo normal de um carregador (Boot, Heartbeat, StatusNotification, MeterValues em ritmo de teste e um replay serial
 *     de centenas de mensagens) NÃO é tocado pelos limites DEFAULT;
 *  4. o handler coringa loga ação + tamanho, nunca os `params`.
 */

const SEGREDO = 'segredo-super-secreto-do-carregador-01'
const suffix = uniqueSuffix()

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

let port = 0
let server: Awaited<ReturnType<typeof startOcppServer>>
let tenant: Awaited<ReturnType<typeof createTenant>>
const erros: unknown[] = []
const onUncaught = (e: unknown) => erros.push(e)
const envMut = env as unknown as { OCPP_MESSAGE_RATE_MAX: number; OCPP_MESSAGE_RATE_WINDOW_SECONDS: number }
const limitesPadrao = { max: env.OCPP_MESSAGE_RATE_MAX, janela: env.OCPP_MESSAGE_RATE_WINDOW_SECONDS }

function usarLimites(max: number, janelaSegundos: number) {
  envMut.OCPP_MESSAGE_RATE_MAX = max
  envMut.OCPP_MESSAGE_RATE_WINDOW_SECONDS = janelaSegundos
}
function restaurarLimites() {
  usarLimites(limitesPadrao.max, limitesPadrao.janela)
}

async function novoCarregador(label: string): Promise<{ id: string; identity: string }> {
  const identity = `cp-fl-${label}-${suffix}`
  const cp = await prisma.chargePoint.create({
    data: { operatorId: tenant.operatorId, siteId: tenant.siteId, ocppIdentity: identity, basicAuthSecretHash: await bcrypt.hash(SEGREDO, 4) },
  })
  return { id: cp.id, identity }
}

async function conectar(identity: string): Promise<RPCClient> {
  const client = new RPCClient({
    endpoint: `ws://127.0.0.1:${port}/ocpp`,
    identity,
    password: SEGREDO,
    protocols: ['ocpp1.6'],
    reconnect: false,
  } as unknown as ConstructorParameters<typeof RPCClient>[0])
  await client.connect()
  return client
}

/** WebSocket cru: manda frames que o RPCClient não deixaria (sem esperar resposta, JSON inválido...). */
function abrirWsCru(identity: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${identity}`, ['ocpp1.6'], {
      headers: { Authorization: `Basic ${Buffer.from(`${identity}:${SEGREDO}`).toString('base64')}` },
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function aguardarFechamento(ws: WebSocket): Promise<number> {
  ws.on('error', () => {})
  return new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
}

const heartbeat = (i: number) => JSON.stringify([2, `hb-${i}`, 'Heartbeat', {}])

beforeAll(async () => {
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUncaught)
  tenant = await createTenant({ suffix, label: 'fl', withCharger: false })
  port = await freePort()
  server = await startOcppServer(port)
}, 30_000)

afterAll(async () => {
  restaurarLimites()
  process.off('uncaughtException', onUncaught)
  process.off('unhandledRejection', onUncaught)
  await server?.close({ awaitPending: false }).catch(() => {})
  redis.disconnect()
})

describe('flood de mensagens por conexão', () => {
  it('rajada além do limite fecha SÓ aquela conexão (1008), com log alert estruturado — o vizinho e uma reconexão seguem normais', async () => {
    const vitima = await novoCarregador('flood')
    const vizinho = await novoCarregador('vizinho')
    const clienteVizinho = await conectar(vizinho.identity)
    const warn = vi.spyOn(logger, 'warn')
    usarLimites(30, 10)
    try {
      const ws = await abrirWsCru(vitima.identity)
      const fechou = aguardarFechamento(ws)
      for (let i = 0; i < 300; i++) ws.send(heartbeat(i)) // 300 CALLs sem esperar nenhuma resposta

      expect(await fechou).toBe(1008)

      const alerta = await waitFor(async () => warn.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'ocpp_message_flood' && (c[0] as { ocppIdentity?: string }).ocppIdentity === vitima.identity))
      expect(alerta[0]).toMatchObject({ alert: 'ocpp_message_flood', chargePointId: vitima.id, maxMessages: 30, windowSeconds: 10 })
      // Uma vez só: excedente depois de fechar não vira enxurrada de log.
      expect(warn.mock.calls.filter((c) => (c[0] as { alert?: string }).alert === 'ocpp_message_flood' && (c[0] as { ocppIdentity?: string }).ocppIdentity === vitima.identity)).toHaveLength(1)

      restaurarLimites()
      expect(((await clienteVizinho.call('Heartbeat', {})) as { currentTime: string }).currentTime).toBeTruthy()
      const volta = await conectar(vitima.identity)
      try {
        expect(((await volta.call('BootNotification', { chargePointVendor: 'Teste', chargePointModel: 'T-1' })) as { status: string }).status).toBe('Accepted')
      } finally {
        await volta.close().catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 200))
      expect(erros).toEqual([])
    } finally {
      restaurarLimites()
      warn.mockRestore()
      await clienteVizinho.close().catch(() => {})
    }
  })
})

describe('o fluxo NORMAL de um carregador não é tocado pelos limites default', () => {
  it('Boot + StatusNotification + Heartbeat + MeterValues no ritmo de um carregador, e um replay serial de 300 mensagens, passam sem fechar', async () => {
    restaurarLimites()
    const cp = await novoCarregador('normal')
    const client = await conectar(cp.identity)
    let fechou = false
    client.on('close', () => (fechou = true))
    try {
      expect(((await client.call('BootNotification', { chargePointVendor: 'Teste', chargePointModel: 'T-1' })) as { status: string }).status).toBe('Accepted')
      await client.call('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Available' })
      await client.call('Heartbeat', {})
      for (let i = 0; i < 5; i++) {
        const meterValue = [{ timestamp: new Date().toISOString(), sampledValue: [{ value: String(1000 + i), context: 'Sample.Periodic', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }]
        await client.call('MeterValues', { connectorId: 1, meterValue })
      }
      // Replay serial (cada CALL espera a resposta, como o OCPP exige) bem acima do que um carregador acumula offline.
      for (let i = 0; i < 300; i++) await client.call('Heartbeat', {})
      expect(fechou).toBe(false)
      expect(((await client.call('Heartbeat', {})) as { currentTime: string }).currentTime).toBeTruthy()
    } finally {
      await client.close().catch(() => {})
    }
  }, 30_000)
})

describe('mensagens malformadas (maxBadMessages)', () => {
  it('mais de 10 malformadas SEGUIDAS fecham a conexão (1002)', async () => {
    const cp = await novoCarregador('ruins')
    const ws = await abrirWsCru(cp.identity)
    const fechou = aguardarFechamento(ws)
    for (let i = 0; i < 30; i++) ws.send('isto nao e json')
    expect(await fechou).toBe(1002)
  })

  it('malformadas ESPORÁDICAS, intercaladas com mensagens boas, NÃO fecham (a lib zera o contador a cada boa)', async () => {
    const cp = await novoCarregador('esporadicas')
    const ws = await abrirWsCru(cp.identity)
    let fechouCodigo: number | undefined
    ws.on('error', () => {})
    ws.once('close', (c) => (fechouCodigo = c))
    const respostas: string[] = []
    ws.on('message', (d) => respostas.push(d.toString()))
    for (let i = 0; i < 25; i++) {
      ws.send('lixo')
      ws.send(heartbeat(i)) // boa: zera o contador de ruins
    }
    await waitFor(async () => (respostas.filter((r) => r.startsWith('[3,')).length >= 25 ? true : undefined))
    expect(fechouCodigo).toBeUndefined()
    ws.close()
  })

  it('o log de mensagem inválida leva só tamanho e código — nunca o conteúdo cru', async () => {
    const cp = await novoCarregador('log-ruim')
    const warn = vi.spyOn(logger, 'warn')
    try {
      const ws = await abrirWsCru(cp.identity)
      ws.on('error', () => {})
      ws.send('CONTEUDO-CRU-SENSIVEL-123 nao e json')
      await waitFor(async () => warn.mock.calls.find((c) => c[1] === '[ocpp] mensagem inválida recebida' && (c[0] as { chargePointId?: string }).chargePointId === cp.id))
      const todos = JSON.stringify(warn.mock.calls.filter((c) => (c[0] as { chargePointId?: string }).chargePointId === cp.id))
      expect(todos).not.toContain('CONTEUDO-CRU-SENSIVEL')
      expect(todos).toContain('"errorCode":"RpcFrameworkError"')
      ws.close()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('handler coringa (método sem handler)', () => {
  it('responde NotImplemented e loga ação + tamanho dos params, NUNCA os params', async () => {
    const cp = await novoCarregador('coringa')
    const client = await conectar(cp.identity)
    const warn = vi.spyOn(logger, 'warn')
    try {
      const params = { status: 'Uploaded', idTag: 'IDTAG-SENSIVEL-DO-MOTORISTA', lixo: 'z'.repeat(2000) }
      await expect(client.call('DiagnosticsStatusNotification', params)).rejects.toMatchObject({ rpcErrorCode: 'NotImplemented' })

      const chamada = await waitFor(async () => warn.mock.calls.find((c) => c[1] === '[ocpp] método recebido sem handler nesta fase' && (c[0] as { chargePointId?: string }).chargePointId === cp.id))
      const campos = chamada[0] as Record<string, unknown>
      expect(campos.action).toBe('DiagnosticsStatusNotification')
      expect(campos.paramsBytes).toBe(Buffer.byteLength(JSON.stringify(params)))
      expect(campos).not.toHaveProperty('params')
      expect(campos).not.toHaveProperty('method')
      expect(JSON.stringify(chamada)).not.toContain('IDTAG-SENSIVEL')
    } finally {
      warn.mockRestore()
      await client.close().catch(() => {})
    }
  })
})
