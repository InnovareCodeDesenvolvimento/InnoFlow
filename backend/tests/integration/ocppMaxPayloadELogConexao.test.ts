import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import bcrypt from 'bcryptjs'
import WebSocket from 'ws'
import { RPCClient } from 'ocpp-rpc'

// Com 1 salto o IP do handshake sai do X-Forwarded-For (o que um proxy wss faria). Precisa valer ANTES de `lib/env` ser importado.
vi.hoisted(() => {
  process.env.OCPP_TRUST_PROXY_HOPS = '1'
})

import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { env } from '../../src/lib/env'
import { startOcppServer } from '../../src/ocpp/server'
import { OCPP_MAX_PAYLOAD_BYTES } from '../../src/core/ocpp/configGateway'
import { createTenant, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Gateway OCPP real (handshake WebSocket de verdade, Postgres e Redis reais), três coisas do hardening pós-decisão do wss://:
 *  1. o log de SUCESSO traz `clientIp` e `xForwardedFor` (para medir OCPP_TRUST_PROXY_HOPS com uma conexão boa) e nunca a senha;
 *  2. teto de 256 KiB por mensagem: acima disso a conexão fecha (1009) sem derrubar o processo; mensagem normal e MeterValues
 *     grande e realista passam;
 *  3. aviso de boot (sem derrubar) quando NODE_ENV=production com OCPP_TRUST_PROXY_HOPS=0.
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
const extraServers: Array<Awaited<ReturnType<typeof startOcppServer>>> = []
const erros: unknown[] = []
const onUncaught = (e: unknown) => erros.push(e)

async function novoCarregador(label: string): Promise<{ id: string; identity: string }> {
  const identity = `cp-pl-${label}-${suffix}`
  const cp = await prisma.chargePoint.create({
    data: { operatorId: tenant.operatorId, siteId: tenant.siteId, ocppIdentity: identity, basicAuthSecretHash: await bcrypt.hash(SEGREDO, 4) },
  })
  return { id: cp.id, identity }
}

/** Cliente OCPP de verdade (ocpp-rpc), conectado e com o servidor já tendo registrado os handlers. */
async function conectar(identity: string, forwardedFor?: string): Promise<RPCClient> {
  const client = new RPCClient({
    endpoint: `ws://127.0.0.1:${port}/ocpp`,
    identity,
    password: SEGREDO,
    protocols: ['ocpp1.6'],
    reconnect: false,
    wsOpts: forwardedFor ? { headers: { 'X-Forwarded-For': forwardedFor } } : undefined,
  } as unknown as ConstructorParameters<typeof RPCClient>[0])
  await client.connect()
  return client
}

/** Frame OCPP 1.6-J cru (Authorize com um idTag do tamanho pedido) por um WebSocket nosso — para mandar o que o ocpp-rpc não deixaria. */
function abrirWsCru(identity: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${identity}`, ['ocpp1.6'], {
      headers: { Authorization: `Basic ${Buffer.from(`${identity}:${SEGREDO}`).toString('base64')}` },
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

beforeAll(async () => {
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUncaught)
  tenant = await createTenant({ suffix, label: 'pl', withCharger: false })
  port = await freePort()
  server = await startOcppServer(port)
}, 30_000)

afterAll(async () => {
  process.off('uncaughtException', onUncaught)
  process.off('unhandledRejection', onUncaught)
  await server?.close({ awaitPending: false }).catch(() => {})
  await Promise.all(extraServers.map((s) => s.close({ awaitPending: false }).catch(() => {})))
  redis.disconnect()
})

describe('log de SUCESSO da autenticação traz o IP (medição de OCPP_TRUST_PROXY_HOPS)', () => {
  it('"[ocpp] charge point conectado" tem clientIp (resolvido pelos saltos) e xForwardedFor (header cru) — e nada de senha/Authorization', async () => {
    const cp = await novoCarregador('log')
    const info = vi.spyOn(logger, 'info')
    const warn = vi.spyOn(logger, 'warn')
    const error = vi.spyOn(logger, 'error')
    const debug = vi.spyOn(logger, 'debug')
    let client: RPCClient | undefined
    try {
      client = await conectar(cp.identity, '203.0.113.77')
      const chamada = await waitFor(async () => info.mock.calls.find((c) => c[1] === '[ocpp] charge point conectado' && (c[0] as { ocppIdentity?: string }).ocppIdentity === cp.identity))

      const campos = chamada[0] as Record<string, unknown>
      // hops=1: cadeia [socket 127.0.0.1, 203.0.113.77] -> índice 1 = o IP que o "proxy" viu.
      expect(campos.clientIp).toBe('203.0.113.77')
      expect(campos.xForwardedFor).toBe('203.0.113.77')
      expect(campos.chargePointId).toBe(cp.id)

      // Nenhuma chamada de log (de nenhum nível) carrega a senha, o Basic base64 ou um campo authorization/password.
      const basic = Buffer.from(`${cp.identity}:${SEGREDO}`).toString('base64')
      const tudo = JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls, ...debug.mock.calls].filter((c) => JSON.stringify(c).includes(cp.identity)))
      expect(tudo).not.toContain(SEGREDO)
      expect(tudo).not.toContain(basic)
      expect(tudo.toLowerCase()).not.toContain('authorization')
      expect(tudo.toLowerCase()).not.toContain('"password"')
    } finally {
      await client?.close().catch(() => {})
      info.mockRestore()
      warn.mockRestore()
      error.mockRestore()
      debug.mockRestore()
    }
  })

  it('sem X-Forwarded-For o campo vem vazio (e clientIp cai no socket)', async () => {
    const cp = await novoCarregador('log-sem-xff')
    const info = vi.spyOn(logger, 'info')
    let client: RPCClient | undefined
    try {
      client = await conectar(cp.identity)
      const chamada = await waitFor(async () => info.mock.calls.find((c) => c[1] === '[ocpp] charge point conectado' && (c[0] as { ocppIdentity?: string }).ocppIdentity === cp.identity))
      const campos = chamada[0] as Record<string, unknown>
      expect(campos.xForwardedFor).toBe('')
      expect(campos.clientIp).toBe('127.0.0.1')
    } finally {
      await client?.close().catch(() => {})
      info.mockRestore()
    }
  })
})

describe('teto de 256 KiB por mensagem (wssOptions.maxPayload)', () => {
  it('mensagem NORMAL passa: BootNotification responde Accepted', async () => {
    const cp = await novoCarregador('normal')
    const client = await conectar(cp.identity)
    try {
      const r = (await client.call('BootNotification', { chargePointVendor: 'Teste', chargePointModel: 'T-1' })) as { status: string }
      expect(r.status).toBe('Accepted')
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('MeterValues em lote offline REALISTA (centenas de amostras, dezenas de KiB) passa e é respondido', async () => {
    const cp = await novoCarregador('lote')
    const client = await conectar(cp.identity)
    try {
      const base = Date.parse('2026-10-01T10:00:00.000Z')
      const meterValue = Array.from({ length: 600 }, (_, i) => ({
        timestamp: new Date(base + i * 1000).toISOString(),
        sampledValue: [
          { value: String(1000 + i * 3), context: 'Sample.Periodic', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
          { value: String(7000 + (i % 50)), context: 'Sample.Periodic', measurand: 'Power.Active.Import', unit: 'W' },
          { value: String(30 + (i % 40)), context: 'Sample.Periodic', measurand: 'SoC', unit: 'Percent' },
        ],
      }))
      const bytes = Buffer.byteLength(JSON.stringify([2, 'x', 'MeterValues', { connectorId: 1, meterValue }]))
      expect(bytes).toBeGreaterThan(100 * 1024) // é grande de verdade...
      expect(bytes).toBeLessThan(OCPP_MAX_PAYLOAD_BYTES) // ...e cabe folgado no teto

      const resposta = await client.call('MeterValues', { connectorId: 1, meterValue })
      expect(resposta).toEqual({}) // chegou ao handler (sem transação: ele só alerta) e respondeu
    } finally {
      await client.close().catch(() => {})
    }
  })

  it('mensagem ACIMA do limite fecha SÓ aquela conexão (1009), sem derrubar o processo — as outras conexões e novas continuam funcionando', async () => {
    const vitima = await novoCarregador('estouro')
    const vizinho = await novoCarregador('vizinho')
    const clienteVizinho = await conectar(vizinho.identity)
    try {
      const ws = await abrirWsCru(vitima.identity)
      const fechou = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
      ws.on('error', () => {}) // o fechamento forçado pode vir como erro no nosso lado; o que se prova é o do servidor
      const grande = JSON.stringify([2, 'estouro-1', 'Authorize', { idTag: 'x'.repeat(OCPP_MAX_PAYLOAD_BYTES + 1024) }])
      expect(Buffer.byteLength(grande)).toBeGreaterThan(OCPP_MAX_PAYLOAD_BYTES)
      ws.send(grande)

      expect(await fechou).toBe(1009) // "message too big"

      // O vizinho, já conectado, segue vivo...
      expect(((await clienteVizinho.call('Heartbeat', {})) as { currentTime: string }).currentTime).toBeTruthy()
      // ...o carregador que estourou reconecta normalmente...
      const volta = await conectar(vitima.identity)
      try {
        expect(((await volta.call('BootNotification', { chargePointVendor: 'Teste', chargePointModel: 'T-1' })) as { status: string }).status).toBe('Accepted')
      } finally {
        await volta.close().catch(() => {})
      }
      // ...e o processo não viu exceção/rejeição não tratada.
      await new Promise((r) => setTimeout(r, 200))
      expect(erros).toEqual([])
    } finally {
      await clienteVizinho.close().catch(() => {})
    }
  })

  it('o limite é por mensagem, no byte: uma mensagem de exatamente o teto passa, uma de teto+1 fecha', async () => {
    const cp = await novoCarregador('borda')
    const esqueleto = (n: number) => JSON.stringify([2, 'b-1', 'Authorize', { idTag: 'y'.repeat(n) }])
    const sobra = OCPP_MAX_PAYLOAD_BYTES - Buffer.byteLength(esqueleto(0))

    const ws1 = await abrirWsCru(cp.identity)
    ws1.on('error', () => {})
    const resposta = new Promise<string>((resolve) => ws1.once('message', (d) => resolve(d.toString())))
    ws1.send(esqueleto(sobra)) // exatamente 262144 bytes
    const texto = await resposta // chegou ao ocpp-rpc: veio resposta (CALLRESULT ou CALLERROR por idTag longo demais), não um fechamento
    expect(JSON.parse(texto)[0]).toBeGreaterThanOrEqual(3)
    ws1.close()

    const ws2 = await abrirWsCru(cp.identity)
    ws2.on('error', () => {})
    const fechou = new Promise<number>((resolve) => ws2.once('close', (code) => resolve(code)))
    ws2.send(esqueleto(sobra + 1))
    expect(await fechou).toBe(1009)
  })
})

describe('aviso de boot — OCPP_TRUST_PROXY_HOPS=0 em produção (não derruba o boot)', () => {
  async function subirCom(nodeEnv: 'production' | 'test', hops: number): Promise<{ avisos: unknown[][] }> {
    const nodeEnvAntes = env.NODE_ENV
    const hopsAntes = env.OCPP_TRUST_PROXY_HOPS
    const warn = vi.spyOn(logger, 'warn')
    try {
      ;(env as { NODE_ENV: string }).NODE_ENV = nodeEnv
      ;(env as { OCPP_TRUST_PROXY_HOPS: number }).OCPP_TRUST_PROXY_HOPS = hops
      const s = await startOcppServer(await freePort()) // não lança: o boot completa
      extraServers.push(s)
      return { avisos: warn.mock.calls.filter((c) => (c[0] as { alert?: string }).alert === 'ocpp_trust_proxy_hops_zero_in_production') }
    } finally {
      ;(env as { NODE_ENV: string }).NODE_ENV = nodeEnvAntes
      ;(env as { OCPP_TRUST_PROXY_HOPS: number }).OCPP_TRUST_PROXY_HOPS = hopsAntes
      warn.mockRestore()
    }
  }

  it('production + hops=0: um logger.warn com alert estruturado e o boot completa', async () => {
    const { avisos } = await subirCom('production', 0)
    expect(avisos).toHaveLength(1)
    expect(String(avisos[0][1])).toMatch(/cota de rate limit/)
    expect(avisos[0][0]).toMatchObject({ alert: 'ocpp_trust_proxy_hops_zero_in_production', ocppTrustProxyHops: 0 })
  })

  it('production + hops=1, ou hops=0 fora de produção: nenhum aviso', async () => {
    expect((await subirCom('production', 1)).avisos).toHaveLength(0)
    expect((await subirCom('test', 0)).avisos).toHaveLength(0)
  })
})
