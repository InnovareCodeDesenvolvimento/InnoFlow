/**
 * N-7 — dedupe/teto COMPARTILHADOS entre processos (Redis real) e degradação para memória quando o Redis cai.
 * Usa o Redis do ambiente de teste (REDIS_URL); chaves com sufixo aleatório (o Redis é compartilhado entre as suítes e entre execuções).
 */
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoriaDedupeStore } from '../../src/core/alertas/dedupe'
import type { CanalDeAlerta } from '../../src/lib/alertas/canais'
import { lerConfigAlertas } from '../../src/lib/alertas/config'
import { Notificador } from '../../src/lib/alertas/notificador'
import { DedupeStoreComFallback, RedisDedupeStore, type RedisMinimo } from '../../src/lib/alertas/storeRedis'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
let a: Redis
let b: Redis

beforeAll(() => {
  // Mesma configuração do notificador real: sem fila offline.
  a = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  b = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  a.on('error', () => {})
  b.on('error', () => {})
})
afterAll(async () => {
  a.disconnect()
  b.disconnect()
})

async function pronto(r: Redis): Promise<void> {
  for (let i = 0; i < 100 && r.status !== 'ready'; i++) await new Promise((res) => setTimeout(res, 20))
  expect(r.status).toBe('ready')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('RedisDedupeStore (dois "processos" no mesmo Redis)', () => {
  it('só UM dos dois avisa; as repetições entram no contador e voltam no próximo aviso', async () => {
    await Promise.all([pronto(a), pronto(b)])
    const sa = new RedisDedupeStore(a)
    const sb = new RedisDedupeStore(b)
    const chave = `teste_${randomUUID()}:abc`

    const rs = await Promise.all([sa.registrarOcorrencia(chave, 1), sb.registrarOcorrencia(chave, 1), sa.registrarOcorrencia(chave, 1), sb.registrarOcorrencia(chave, 1)])
    expect(rs.filter((r) => r.avisar)).toHaveLength(1)
    expect(rs.filter((r) => !r.avisar)).toHaveLength(3)

    await sleep(1_200) // a janela de 1 s expira; o contador (24 h) sobrevive
    const depois = await sb.registrarOcorrencia(chave, 1)
    expect(depois).toEqual({ avisar: true, suprimidas: 3 })
    await sleep(1_200)
    expect(await sa.registrarOcorrencia(chave, 1)).toEqual({ avisar: true, suprimidas: 0 }) // o contador foi consumido
  })

  it('teto por hora: exatamente UMA estourou_agora entre processos concorrentes; o resto silencia', async () => {
    await Promise.all([pronto(a), pronto(b)])
    const sa = new RedisDedupeStore(a)
    const sb = new RedisDedupeStore(b)
    const hora = `teste-${randomUUID()}`
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? sa : sb).reservarVagaPorHora('IMPORTANTE', hora, 5)))
    expect(rs.filter((r) => r === 'livre')).toHaveLength(5)
    expect(rs.filter((r) => r === 'estourou_agora')).toHaveLength(1)
    expect(rs.filter((r) => r === 'silenciado')).toHaveLength(14)
    // IMPORTANTE e CRITICO têm contadores independentes
    expect(await sa.reservarVagaPorHora('CRITICO', hora, 5)).toBe('livre')
  })

  it('dois Notificadores (api + worker) no mesmo Redis mandam UM e-mail para o mesmo alerta', async () => {
    await Promise.all([pronto(a), pronto(b)])
    const enviados: string[] = []
    const canal: CanalDeAlerta = { nome: 'email', minSeveridade: 'INFO', enviar: async (e) => { enviados.push(`${e.servico}:${e.alerta}`) } }
    // Hora FICTÍCIA e única desta execução: o teto por hora vive no Redis compartilhado (suítes paralelas e execuções anteriores já gastaram o da hora real).
    const horaFalsa = Date.UTC(3000 + Math.floor(Math.random() * 5000), 0, 1, Math.floor(Math.random() * 24))
    const mk = (servico: string, redis: Redis) =>
      new Notificador({
        agora: () => horaFalsa,
        config: lerConfigAlertas({ ALERT_SERVICE_NAME: servico }, undefined),
        canais: [canal],
        store: new DedupeStoreComFallback(new RedisDedupeStore(redis)),
        log: () => {},
      })
    const api = mk('api', a)
    const worker = mk('worker', b)
    const id = `pi_${randomUUID()}`
    const alerta = 'payment_void_manual_review'
    api.notificar({ alerta, nivelPino: 50, dados: { paymentIntentId: id } })
    worker.notificar({ alerta, nivelPino: 50, dados: { paymentIntentId: id } })
    api.notificar({ alerta, nivelPino: 50, dados: { paymentIntentId: id } })
    await Promise.all([api.aguardarOcioso(), worker.aguardarOcioso()])
    expect(enviados).toHaveLength(1)
  })
})

describe('Redis fora do ar: degrada para memória, nunca lança', () => {
  it('Redis inalcançável (porta fechada): o dedupe segue valendo em memória e o aviso ainda sai', async () => {
    const morto = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true })
    morto.on('error', () => {})
    const degradacoes: string[] = []
    const store = new DedupeStoreComFallback(new RedisDedupeStore(morto), new MemoriaDedupeStore(), Date.now, (m) => degradacoes.push(m))
    const chave = `teste_${randomUUID()}:x`
    expect((await store.registrarOcorrencia(chave, 60)).avisar).toBe(true)
    expect((await store.registrarOcorrencia(chave, 60)).avisar).toBe(false) // dedupe em memória
    expect(await store.reservarVagaPorHora('CRITICO', 'h', 1)).toBe('livre')
    expect(await store.reservarVagaPorHora('CRITICO', 'h', 1)).toBe('estourou_agora')
    expect(degradacoes).toHaveLength(1) // disjuntor: avisa a degradação 1x, não a cada chamada
    morto.disconnect()
  })

  it('Redis que NUNCA responde: o prazo (1,5 s) estoura e cai na memória; as chamadas seguintes nem tentam o Redis', async () => {
    let chamadas = 0
    const pendurado: RedisMinimo = { eval: () => { chamadas++; return new Promise<unknown>(() => {}) } }
    const store = new DedupeStoreComFallback(new RedisDedupeStore(pendurado))
    const t0 = Date.now()
    const r = await store.registrarOcorrencia('teste:pendurado', 60)
    expect(r.avisar).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400)
    expect(Date.now() - t0).toBeLessThan(4_000)
    const t1 = Date.now()
    expect((await store.registrarOcorrencia('teste:pendurado', 60)).avisar).toBe(false)
    expect(Date.now() - t1).toBeLessThan(200)
    expect(chamadas).toBe(1)
  })

  it('resposta inesperada do Redis conta como falha (não vira "avisar" por engano)', async () => {
    const lixo: RedisMinimo = { eval: async () => 'lixo' }
    const store = new DedupeStoreComFallback(new RedisDedupeStore(lixo))
    expect((await store.registrarOcorrencia('teste:lixo', 60)).avisar).toBe(true) // 1ª vez, na memória
    expect((await store.registrarOcorrencia('teste:lixo', 60)).avisar).toBe(false) // já em memória (disjuntor aberto)
  })
})
