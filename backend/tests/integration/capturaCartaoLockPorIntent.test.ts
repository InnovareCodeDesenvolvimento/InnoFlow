import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { adquirirLock, liberarLock } from '../../src/lib/redisLock'
import type { PagamentoPort } from '../../src/core/pagamentos/porta'
import { getPagamentoPort } from '../../src/services/pagamentos/pagamentoPortInstance'
import { CapturaCartaoEmAndamentoError, capturarSessaoCartao, chaveLockCaptura } from '../../src/services/pagamentos/capturarSessaoCartao'
import type { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { uniqueSuffix } from './helpers/fixtures'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'

/**
 * F5.8 (Vega-3) — o lock Redis por intent da captura (achado da Íris: dois executores do mesmo intent chamavam `capturar()` 2x).
 * O teste de concorrência da Íris (`capturaCartaoConcorrenciaMesmoIntent`) prova o "no máximo uma chamada"; aqui ficam as propriedades
 * que fazem o lock SEGURO: o dono que morre não prende o intent (TTL), a falha libera o lock, e liberar nunca apaga o lock de outro.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('captura de cartão — lock por intent (segurança do próprio lock)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let fake: FakeAdapter
  let fx: FixtureCartao

  beforeAll(async () => {
    fake = (await getPagamentoPort()) as unknown as FakeAdapter
    fx = await criarFixtureCartao(app, suffix, 'lock-captura')
  })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('lock segurado por OUTRO executor: não chama a Cielo (nem consulta), lança CapturaCartaoEmAndamentoError; quando o lock some, a captura segue normal', async () => {
    const { intent } = await fx.sessaoParada('seguro-por-outro')
    expect(await adquirirLock(redis, chaveLockCaptura(intent.id), 60_000)).not.toBeNull()
    const antes = fake.contagemCapturar(intent.cieloPaymentId!)

    await expect(capturarSessaoCartao(intent.id, fake)).rejects.toBeInstanceOf(CapturaCartaoEmAndamentoError)

    expect(fake.contagemCapturar(intent.cieloPaymentId!)).toBe(antes)
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURE_PENDING')

    await redis.del(chaveLockCaptura(intent.id))
    expect(await capturarSessaoCartao(intent.id, fake)).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 300 })
  })

  it('dono MORTO não prende o intent para sempre: o lock expira pelo TTL e a próxima tentativa captura', async () => {
    const { intent } = await fx.sessaoParada('dono-morto')
    await redis.set(chaveLockCaptura(intent.id), 'token-de-um-worker-que-morreu', 'PX', 300) // o worker morreu no meio do PUT

    await expect(capturarSessaoCartao(intent.id, fake)).rejects.toBeInstanceOf(CapturaCartaoEmAndamentoError)
    await sleep(450)

    expect(await capturarSessaoCartao(intent.id, fake)).toMatchObject({ status: 'CAPTURED' })
  })

  it('o lock é LIBERADO ao fim, inclusive quando a captura FALHA (Cielo fora): a volta seguinte do job não fica barrada', async () => {
    const { intent } = await fx.sessaoParada('libera-na-falha')
    const gatewayFora = new Proxy(fake as unknown as PagamentoPort, {
      get(alvo, prop) {
        const valor = Reflect.get(alvo, prop, alvo) as unknown
        if (prop === 'consultar') return () => Promise.reject(new Error('simulado: Cielo fora do ar'))
        return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor
      },
    })

    await expect(capturarSessaoCartao(intent.id, gatewayFora)).rejects.toThrow('Cielo fora do ar')
    expect(await redis.exists(chaveLockCaptura(intent.id))).toBe(0)

    expect(await capturarSessaoCartao(intent.id, fake)).toMatchObject({ status: 'CAPTURED' })
    expect(await redis.exists(chaveLockCaptura(intent.id))).toBe(0)
  })

  it('liberarLock só apaga o lock do PRÓPRIO token: um dono lento (TTL já vencido) não libera o lock do novo dono', async () => {
    const chave = `card-capture:lock:teste-${randomUUID()}`
    const tokenA = await adquirirLock(redis, chave, 150)
    expect(tokenA).not.toBeNull()
    expect(await adquirirLock(redis, chave, 150)).toBeNull() // exclusivo
    await sleep(250) // TTL do A venceu
    const tokenB = await adquirirLock(redis, chave, 5_000)
    expect(tokenB).not.toBeNull()

    expect(await liberarLock(redis, chave, tokenA!)).toBe(false) // A, atrasado, NÃO apaga o lock do B
    expect(await redis.exists(chave)).toBe(1)
    expect(await liberarLock(redis, chave, tokenB!)).toBe(true)
    expect(await redis.exists(chave)).toBe(0)
  })
})
