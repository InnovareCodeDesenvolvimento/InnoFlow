import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Queue, Worker } from 'bullmq'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { GatewayPagamentoNaoConfiguradoError } from '../../src/core/pagamentos/erros'
import type { PagamentoPort } from '../../src/core/pagamentos/porta'
import { getPagamentoPort } from '../../src/services/pagamentos/pagamentoPortInstance'
import { capturarSessaoCartao, capturaJobId, enqueueCapturarSessaoCartao } from '../../src/services/pagamentos/capturarSessaoCartao'
import { reenfileirarCapturasPendentes, chaveCooldownCaptura, chaveTentativasCaptura } from '../../src/services/pagamentos/reenfileirarCapturasPendentes'
import type { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { startCapturarSessaoCartaoWorker } from '../../src/worker/jobs/capturarSessaoCartaoJob'
import { createQueue } from '../../src/worker/queues'
import { waitFor, uniqueSuffix } from './helpers/fixtures'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'

/**
 * Íris (02/10/2026) — dois comportamentos da rede de segurança da captura que as suítes do Vega NÃO provavam (a mutação sobreviveu e foi morta aqui):
 *
 *  1. COOLDOWN entre reenfileiramentos do MESMO intent (`SET NX EX CARD_CAPTURE_RETRY_AFTER_MINUTES`). Sem ele, cada rodada do varredor (a cada
 *     `CARD_PREAUTH_SCAN_INTERVAL_MS`) recriava o job FALHO do intent e martelava a Cielo (e gastava o teto de 100 em poucas horas, em vez de ~8 h).
 *  2. O ADIAMENTO por gateway indisponível é LIMPO: `DelayedError` diz ao BullMQ "já movi o job, não o trate como falha". Trocar por um `throw` comum
 *     mantinha o job `delayed` com `attemptsMade: 0` (o teste de comportamento do Vega continua verde, porque o BullMQ tropeça em silêncio ao tentar
 *     mover para `failed` um job que já saiu de `active`), mas cada volta emite `error` no worker e loga "job falhou" — alarme falso permanente.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function gatewayQueFalha(base: PagamentoPort) {
  const estado = { chamadas: 0 }
  const porta = new Proxy(base, {
    get(alvo, prop) {
      const valor = Reflect.get(alvo, prop, alvo) as unknown
      if (typeof valor !== 'function') return valor
      return (...args: unknown[]) => {
        if (['consultar', 'capturar'].includes(String(prop))) {
          estado.chamadas++
          throw new Error('simulado: Cielo fora do ar (ECONNRESET)')
        }
        return (valor as (...a: unknown[]) => unknown).apply(alvo, args)
      }
    },
  })
  return { porta, estado }
}

describe('captura de cartão — cooldown do varredor e adiamento limpo do job', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const nomeFila = `capturar-sessao-cartao-iris-${suffix}`
  let fake: FakeAdapter
  let fx: FixtureCartao
  let queue: Queue
  const workers: Worker[] = []
  const pendentes: string[] = []

  beforeAll(async () => {
    fake = (await getPagamentoPort()) as unknown as FakeAdapter
    queue = createQueue(nomeFila)
    fx = await criarFixtureCartao(app, suffix, 'cooldown-captura')
  })

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true).catch(() => {})))
    // Hermético: o varredor olha TODO CAPTURE_PENDING velho do banco; não deixa intent meu para as outras suítes.
    for (const id of pendentes.splice(0)) {
      if ((await prisma.paymentIntent.findUniqueOrThrow({ where: { id } })).status === 'CAPTURE_PENDING') await capturarSessaoCartao(id, fake).catch(() => {})
    }
  })

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => {})
    await queue.close().catch(() => {})
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('cooldown: duas rodadas do varredor seguidas NÃO recriam o job falho do mesmo intent nem gastam o teto; depois do cooldown, recria', async () => {
    const { intent } = await fx.sessaoParada('cooldown')
    pendentes.push(intent.id)
    // Mais antigo que qualquer outro intent do banco compartilhado: o varredor só olha os 50 mais antigos (ver varredorCapturaPendenteLoteInanicao.test.ts).
    await fx.envelhecer(intent.id, 60 * 24 * 365 * 5)
    const { porta, estado } = gatewayQueFalha(fake)
    const w = startCapturarSessaoCartaoWorker({ queueName: nomeFila, getPort: async () => porta, adiarMs: 200 })
    w.on('error', () => {})
    workers.push(w)

    // Rodada 1: reenfileira; a Cielo está fora e o job (1 tentativa) termina FALHO.
    await reenfileirarCapturasPendentes({ queue, opcoesJob: { attempts: 1, backoffMs: 50 } })
    expect(await redis.get(chaveTentativasCaptura(intent.id))).toBe('1')
    await waitFor(async () => (await queue.getJob(capturaJobId(intent.id)))?.finishedOn !== undefined, { timeoutMs: 15_000, what: 'o 1º job de captura terminar falho' })
    const chamadasAposRodada1 = estado.chamadas
    expect(chamadasAposRodada1).toBeGreaterThanOrEqual(1)
    const ttl = await redis.ttl(chaveCooldownCaptura(intent.id))
    expect(ttl).toBeGreaterThan(240) // CARD_CAPTURE_RETRY_AFTER_MINUTES (5) x 60, menos o que já correu
    expect(ttl).toBeLessThanOrEqual(300)

    // Rodada 2 IMEDIATA: dentro do cooldown. O job falho continua lá, o contador não anda e a Cielo não é chamada de novo.
    await reenfileirarCapturasPendentes({ queue, opcoesJob: { attempts: 1, backoffMs: 50 } })
    await sleep(800)
    expect(await redis.get(chaveTentativasCaptura(intent.id))).toBe('1')
    expect(estado.chamadas).toBe(chamadasAposRodada1)
    expect((await queue.getJob(capturaJobId(intent.id)))?.finishedOn).toBeDefined()

    // Passado o cooldown (apago a chave em vez de esperar 5 min), a rodada seguinte RECRIA o job.
    await redis.del(chaveCooldownCaptura(intent.id))
    await reenfileirarCapturasPendentes({ queue, opcoesJob: { attempts: 1, backoffMs: 50 } })
    expect(await redis.get(chaveTentativasCaptura(intent.id))).toBe('2')
    await waitFor(async () => estado.chamadas > chamadasAposRodada1, { timeoutMs: 15_000, what: 'o job recriado chamar a Cielo de novo' })
  }, 60_000)

  it('adiamento por gateway indisponível é LIMPO: várias voltas sem `error` no worker e sem o log "job falhou" (DelayedError, não throw comum)', async () => {
    const { intent } = await fx.sessaoParada('adiar-limpo')
    pendentes.push(intent.id)
    const logErro = vi.spyOn(logger, 'error')
    let voltas = 0
    const errosDoWorker: string[] = []
    const w = startCapturarSessaoCartaoWorker({
      queueName: nomeFila,
      adiarMs: 150,
      getPort: async () => {
        voltas++
        throw new GatewayPagamentoNaoConfiguradoError()
      },
    })
    w.on('error', (err) => errosDoWorker.push(err.message))
    workers.push(w)
    try {
      await enqueueCapturarSessaoCartao(intent.id, queue, { attempts: 2, backoffMs: 100 })
      await waitFor(async () => voltas >= 4, { timeoutMs: 20_000, what: 'o job voltar várias vezes com o gateway indisponível' })
      const job = await queue.getJob(capturaJobId(intent.id))
      expect(job!.attemptsMade).toBe(0)
      expect(errosDoWorker).toEqual([])
      const falhou = logErro.mock.calls.filter(([, msg]) => typeof msg === 'string' && msg.includes('job falhou'))
      expect(falhou).toHaveLength(0)
    } finally {
      logErro.mockRestore()
      await (await queue.getJob(capturaJobId(intent.id)))?.remove().catch(() => {})
    }
  }, 60_000)
})
