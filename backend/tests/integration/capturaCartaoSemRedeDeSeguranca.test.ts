import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Queue, Worker } from 'bullmq'

// Mesmo recurso de `redisOutageFilaDePublish.test.ts`: o processo fala com o Redis por um proxy TCP DESTA suíte, então "Redis fora do
// ar" é mexer no proxy — o Redis compartilhado nunca é tocado. Hoisted: tem que valer antes de `lib/env` ser importado.
const { proxy } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy }
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { GatewayPagamentoNaoConfiguradoError } from '../../src/core/pagamentos/erros'
import type { PagamentoPort } from '../../src/core/pagamentos/porta'
import { getPagamentoPort } from '../../src/services/pagamentos/pagamentoPortInstance'
import { capturarSessaoCartao, capturaJobId } from '../../src/services/pagamentos/capturarSessaoCartao'
import { reenfileirarCapturasPendentes, chaveCooldownCaptura, chaveTentativasCaptura } from '../../src/services/pagamentos/reenfileirarCapturasPendentes'
import type { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { startCapturarSessaoCartaoWorker } from '../../src/worker/jobs/capturarSessaoCartaoJob'
import { createQueue } from '../../src/worker/queues'
import { waitFor, uniqueSuffix } from './helpers/fixtures'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'

/**
 * F5.7 (Vega, 02/10/2026) — ALTO-1 do portão final do Órion, contra Postgres + Redis REAIS: captura de cartão sem rede de
 * segurança. Antes, se o Redis estivesse fora no Stop (o `enqueue` falhava e só era logado) ou a Cielo/config falhasse além do
 * backoff do job (~75 s), o intent ficava `CAPTURE_PENDING` PARA SEMPRE: energia entregue, nada cobrado. Agora o varredor
 * periódico reenfileira. (O M1 — status transitório da captura — está em `capturaCartaoStatusTransitorio.test.ts`.)
 *
 * Fila PRÓPRIA (nome único) para o worker e o varredor: a fila padrão é compartilhada com a suíte inteira.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Gateway que FALHA (ECONNRESET) enquanto `falhando`, e delega ao FakeAdapter real quando volta — "Cielo fora do ar". */
function gatewayInstavel(base: PagamentoPort) {
  const estado = { falhando: true, chamadas: 0 }
  const porta = new Proxy(base, {
    get(alvo, prop) {
      const valor = Reflect.get(alvo, prop, alvo) as unknown
      if (typeof valor !== 'function') return valor
      return (...args: unknown[]) => {
        if (['consultar', 'capturar', 'cancelar', 'consultarPorPedido'].includes(String(prop))) {
          estado.chamadas++
          if (estado.falhando) throw new Error('simulado: Cielo fora do ar (ECONNRESET)')
        }
        return (valor as (...a: unknown[]) => unknown).apply(alvo, args)
      }
    },
  })
  return { porta, estado }
}

describe('ALTO-1 — captura de cartão com rede de segurança do varredor (F5.7)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const nomeFila = `capturar-sessao-cartao-teste-${suffix}`
  let fake: FakeAdapter
  let fx: FixtureCartao
  let queue: Queue
  const workers: Worker[] = []
  const intentsCriados: string[] = []

  /** Sessão parada (intent `CAPTURE_PENDING`) registrada para a limpeza do `beforeEach`. */
  const sessaoParada = async (label: string, antesDoStop?: () => Promise<void>) => {
    const r = await fx.sessaoParada(label, antesDoStop)
    intentsCriados.push(r.intent.id)
    return r
  }
  const envelhecer = (intentId: string, minutos: number) => fx.envelhecer(intentId, minutos)
  const reportFor = () => fx.conciliacao()
  const iniciarWorker = (getPort: () => Promise<PagamentoPort>, adiarMs = 300) => {
    const w = startCapturarSessaoCartaoWorker({ queueName: nomeFila, getPort, adiarMs })
    w.on('error', () => {}) // erro de conexão do worker durante o teste não pode virar "Unhandled error"
    workers.push(w)
    return w
  }

  beforeAll(async () => {
    fake = (await getPagamentoPort()) as unknown as FakeAdapter
    queue = createQueue(nomeFila)
    fx = await criarFixtureCartao(app, suffix, 'alto1-captura')
  })

  // Hermético: o varredor olha TODO CAPTURE_PENDING velho do banco. Cada teste começa sem pendências dos anteriores (captura de verdade, pela porta saudável).
  beforeEach(async () => {
    for (const id of intentsCriados.splice(0)) {
      if ((await prisma.paymentIntent.findUniqueOrThrow({ where: { id } })).status === 'CAPTURE_PENDING') await capturarSessaoCartao(id, fake).catch(() => {})
    }
  })
  // Um worker por teste (todos consomem a MESMA fila de teste — um worker do teste anterior roubaria o job do seguinte).
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true).catch(() => {})))
  })

  afterAll(async () => {
    await proxy.up()
    await Promise.all(workers.map((w) => w.close(true).catch(() => {})))
    await queue.obliterate({ force: true }).catch(() => {})
    await queue.close().catch(() => {})
    await prisma.$disconnect()
    redis.disconnect()
    await proxy.stop()
  })

  // ---------------------------------------------------------------------------
  describe('ALTO-1 — Redis fora E Cielo fora no momento do Stop: o intent é capturado depois, UMA vez', () => {
    it('Stop com o Redis derrubado não pendura; o intent fica CAPTURE_PENDING sem job; o varredor reenfileira; Cielo ainda fora esgota o job SEM criar dívida; Cielo volta e captura 1x com conciliação 0', async () => {
      const { intent, stop, stopMs } = await sessaoParada('outage', async () => {
        await proxy.down() // Redis FORA no instante do Stop (ECONNRESET e depois ECONNREFUSED, como o processo morto)
        await sleep(100)
      })
      try {
        // (1) O StopTransaction responde e NÃO fica pendurado esperando o `enqueue` (o prazo de 5 s do finalizarSessao protege).
        expect(stop.idTagInfo.status).toBe('Accepted')
        expect(stopMs).toBeLessThan(15_000)
      } finally {
        await proxy.up()
      }

      // (2) Estado do dinheiro: energia entregue, captura pendente, NENHUM job (o enqueue falhou), nenhuma dívida.
      const pendente = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(pendente).toMatchObject({ status: 'CAPTURE_PENDING', captureAmountCents: 300 })
      expect(await queue.getJob(capturaJobId(intent.id))).toBeUndefined()
      expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)

      // (3) Recém-criado: o varredor NÃO mexe (dá tempo do job normal).
      await reenfileirarCapturasPendentes({ queue })
      expect(await queue.getJob(capturaJobId(intent.id))).toBeUndefined()
      expect(await redis.get(chaveTentativasCaptura(intent.id))).toBeNull()

      // (4) Passam 10 min sem captura. Cielo continua FORA. O varredor reenfileira (política do job reduzida só para o teste não esperar minutos).
      await envelhecer(intent.id, 10)
      const { porta, estado } = gatewayInstavel(fake)
      iniciarWorker(async () => porta)
      const r1 = await reenfileirarCapturasPendentes({ queue, opcoesJob: { attempts: 2, backoffMs: 150 } })
      expect(r1.reenfileiradas).toBeGreaterThanOrEqual(1)
      expect(await redis.get(chaveTentativasCaptura(intent.id))).toBe('1')

      // (5) O job esgota as tentativas com a Cielo fora — e o intent CONTINUA CAPTURE_PENDING, SEM dívida (antes do M1 virava FAILED+dívida só com status "pendente"; aqui é erro de rede puro).
      await waitFor(async () => (await queue.getJob(capturaJobId(intent.id)))?.finishedOn !== undefined, { timeoutMs: 20_000, what: 'job de captura esgotar as tentativas' })
      expect(estado.chamadas).toBeGreaterThanOrEqual(2)
      expect(fake.contagemCapturar(pendente.cieloPaymentId!)).toBe(0) // a Cielo nunca chegou a ser acionada para capturar
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'CAPTURE_PENDING' })
      expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)

      // (6) A Cielo volta. Passa o intervalo mínimo entre reenfileiramentos (apago o cooldown em vez de esperar 5 min). O varredor remove o job FALHO e recria.
      estado.falhando = false
      await redis.del(chaveCooldownCaptura(intent.id))
      const r2 = await reenfileirarCapturasPendentes({ queue, opcoesJob: { attempts: 2, backoffMs: 150 } })
      expect(r2.reenfileiradas).toBeGreaterThanOrEqual(1)
      await waitFor(async () => (await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status === 'CAPTURED', { timeoutMs: 20_000, what: 'captura concluir depois da Cielo voltar' })

      // (7) Capturado UMA única vez, valor certo, sem dívida, e a conciliação fecha em 0.
      expect(fake.contagemCapturar(pendente.cieloPaymentId!)).toBe(1)
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 300 })
      expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)
      expect(await redis.get(chaveTentativasCaptura(intent.id))).toBe('2')
      const conciliacao = await reportFor()
      expect(conciliacao).toMatchObject({ differenceCents: 0, cardCapturePendingCents: 0 })

      // (8) Rodada seguinte: nada mais a fazer para este intent (já não é CAPTURE_PENDING) — não recaptura.
      const r3 = await reenfileirarCapturasPendentes({ queue })
      expect(r3.reenfileiradas).toBe(0)
      expect(fake.contagemCapturar(pendente.cieloPaymentId!)).toBe(1)
    }, 120_000)
  })

  // ---------------------------------------------------------------------------
  describe('ALTO-1 — gateway indisponível POR CONFIGURAÇÃO não gasta tentativas do job', () => {
    it('o job é ADIADO (várias voltas, attempts=2) e, quando a config volta, captura — nunca virou "falhou"', async () => {
      const { intent } = await sessaoParada('cfg')
      const base = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(base.status).toBe('CAPTURE_PENDING')

      let configOk = false
      let voltas = 0
      iniciarWorker(async () => {
        voltas++
        if (!configOk) throw new GatewayPagamentoNaoConfiguradoError()
        return fake
      }, 200)

      const { enqueueCapturarSessaoCartao } = await import('../../src/services/pagamentos/capturarSessaoCartao')
      await enqueueCapturarSessaoCartao(intent.id, queue, { attempts: 2, backoffMs: 100 })

      await waitFor(async () => voltas >= 4, { timeoutMs: 15_000, what: 'o job voltar várias vezes com o gateway indisponível' })
      const job = await queue.getJob(capturaJobId(intent.id))
      // 4+ voltas com attempts=2: se cada uma consumisse tentativa o job já teria ido a "failed".
      expect(await job!.getState()).toBe('delayed')
      expect(job!.attemptsMade).toBe(0)
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'CAPTURE_PENDING' })

      configOk = true
      await waitFor(async () => (await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status === 'CAPTURED', { timeoutMs: 15_000, what: 'captura depois da config voltar' })
      expect(fake.contagemCapturar(base.cieloPaymentId!)).toBe(1)
    }, 60_000)

    it('o varredor com o gateway indisponível só ALERTA — não reenfileira nem gasta o teto', async () => {
      const { intent } = await sessaoParada('semgw')
      await envelhecer(intent.id, 90) // > 1 h: alerta de severidade ALTA (erro)
      const erro = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
      try {
        const r = await reenfileirarCapturasPendentes({ queue, gatewayDisponivel: false })
        expect(r.semGateway).toBeGreaterThanOrEqual(1)
        expect(await queue.getJob(capturaJobId(intent.id))).toBeUndefined()
        expect(await redis.get(chaveTentativasCaptura(intent.id))).toBeNull()
        expect(erro).toHaveBeenCalledWith(expect.objectContaining({ alert: 'payment_capture_pending_stale', paymentIntentId: intent.id, severity: 'alta', gatewayAvailable: false }), expect.any(String))
      } finally {
        erro.mockRestore()
      }
    })
  })

  // ---------------------------------------------------------------------------
  describe('ALTO-1 — teto de tentativas e alerta escalonado por idade', () => {
    it('com o teto atingido o varredor PARA de reenfileirar e alerta (1x/h) com payment_capture_retry_exhausted', async () => {
      const { intent } = await sessaoParada('teto')
      await envelhecer(intent.id, 30)
      await redis.set(chaveTentativasCaptura(intent.id), '100') // = CARD_CAPTURE_MAX_SWEEP_RETRIES default
      const erro = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
      try {
        const r1 = await reenfileirarCapturasPendentes({ queue })
        expect(r1.tetoAtingido).toBeGreaterThanOrEqual(1)
        expect(await queue.getJob(capturaJobId(intent.id))).toBeUndefined()
        const chamadas = () => erro.mock.calls.filter(([c]) => (c as { alert?: string }).alert === 'payment_capture_retry_exhausted' && (c as { paymentIntentId?: string }).paymentIntentId === intent.id)
        expect(chamadas()).toHaveLength(1)
        await reenfileirarCapturasPendentes({ queue }) // 2ª rodada na mesma hora: não repete o alerta
        expect(chamadas()).toHaveLength(1)
      } finally {
        erro.mockRestore()
      }
    })

    it('alerta escalonado: <1 h é warn; >=1 h é error; >=24 h é error crítico', async () => {
      const a = await sessaoParada('idade-a')
      const b = await sessaoParada('idade-b')
      const c = await sessaoParada('idade-c')
      await envelhecer(a.intent.id, 10)
      await envelhecer(b.intent.id, 120)
      await envelhecer(c.intent.id, 25 * 60)
      const erro = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
      const aviso = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
      try {
        await reenfileirarCapturasPendentes({ queue, gatewayDisponivel: false })
        const campos = (spy: typeof erro, id: string) => spy.mock.calls.map(([x]) => x as { alert?: string; paymentIntentId?: string; severity?: string }).find((x) => x.alert === 'payment_capture_pending_stale' && x.paymentIntentId === id)
        expect(campos(aviso, a.intent.id)).toMatchObject({ severity: 'normal' })
        expect(campos(erro, a.intent.id)).toBeUndefined()
        expect(campos(erro, b.intent.id)).toMatchObject({ severity: 'alta' })
        expect(campos(erro, c.intent.id)).toMatchObject({ severity: 'critica' })
      } finally {
        erro.mockRestore()
        aviso.mockRestore()
      }
    })

    it('job já vivo para o intent: o varredor não duplica (JA_EM_ANDAMENTO) e não gasta o teto', async () => {
      const { intent } = await sessaoParada('vivo')
      await envelhecer(intent.id, 10)
      await queue.add('capturar', { paymentIntentId: intent.id }, { jobId: capturaJobId(intent.id), delay: 60_000 }) // job atrasado = vivo
      const r = await reenfileirarCapturasPendentes({ queue })
      expect(r.jaEmAndamento).toBeGreaterThanOrEqual(1)
      expect(await redis.get(chaveTentativasCaptura(intent.id))).toBeNull()
      await (await queue.getJob(capturaJobId(intent.id)))!.remove()
    })
  })
})
