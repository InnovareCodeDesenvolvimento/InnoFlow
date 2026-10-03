import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import type { PagamentoPort } from '../../src/core/pagamentos/porta'
import { getPagamentoPort } from '../../src/services/pagamentos/pagamentoPortInstance'
import { capturarSessaoCartao } from '../../src/services/pagamentos/capturarSessaoCartao'
import type { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { uniqueSuffix } from './helpers/fixtures'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'

/**
 * Íris (02/10/2026) — dois executores da captura do MESMO intent ao mesmo tempo (o Vega admitiu: só o `jobId` do BullMQ protege,
 * `capturarSessaoCartao` não tem lock). Como dois executores acontecem na prática: job "stalled" (o BullMQ devolve à fila um job cujo
 * lock não foi renovado — event loop travado, blip do Redis — enquanto o 1º executor ainda espera a Cielo), ou duas instâncias do worker.
 *
 * POR QUE NÃO BASTA O `FakeAdapter` PURO: o `capturar()` dele é síncrono (sem `await` dentro): o 1º executor termina a captura inteira antes de o
 * 2º entrar, o 2º vê `CAPTURED` e lança — e `contagemCapturar` só incrementa DEPOIS dessa checagem, então ficaria em 1 e esconderia a
 * corrida. A Cielo real é uma chamada de REDE (centenas de ms) em que os dois PUT `/capture` saem antes de qualquer resposta. Este
 * envelope faz o mesmo: conta as ENTRADAS em `capturar()` e segura o 1º PUT por um instante antes de delegar ao Fake.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function gatewayComLatencia(base: FakeAdapter, latenciaMs: number) {
  const estado = { entradasCapturar: 0, entradasConsultar: 0 }
  const porta = new Proxy(base as unknown as PagamentoPort, {
    get(alvo, prop) {
      const valor = Reflect.get(alvo, prop, alvo) as unknown
      if (typeof valor !== 'function') return valor
      return async (...args: unknown[]) => {
        if (prop === 'capturar') estado.entradasCapturar++
        if (prop === 'consultar') estado.entradasConsultar++
        if (prop === 'capturar' || prop === 'consultar') await sleep(latenciaMs) // rede
        return (valor as (...a: unknown[]) => unknown).apply(alvo, args)
      }
    },
  })
  return { porta, estado }
}

describe('captura de cartão — dois executores simultâneos do MESMO intent', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let fake: FakeAdapter
  let fx: FixtureCartao

  beforeAll(async () => {
    fake = (await getPagamentoPort()) as unknown as FakeAdapter
    fx = await criarFixtureCartao(app, suffix, 'conc-captura')
  })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('o resultado FINAL é consistente: 1 captura efetiva, valor certo, sem dívida, conciliação fecha em 0 (o FOR UPDATE da transação protege o dinheiro)', async () => {
    const { intent } = await fx.sessaoParada('final')
    const { porta } = gatewayComLatencia(fake, 120)

    const resultados = await Promise.allSettled([capturarSessaoCartao(intent.id, porta), capturarSessaoCartao(intent.id, porta)])

    // pelo menos um chegou ao fim; o outro pode ter falhado (a Cielo recusa o 2º PUT) — e uma reexecução (o retry do job) só espelha.
    expect(resultados.some((r) => r.status === 'fulfilled' && r.value?.status === 'CAPTURED')).toBe(true)
    expect(await capturarSessaoCartao(intent.id, porta)).toBeNull() // já CAPTURED: idempotente

    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 300 })
    expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)
    expect(fake.contagemCapturar(intent.cieloPaymentId!)).toBe(1)
    expect(await fx.conciliacao()).toMatchObject({ differenceCents: 0, cardCapturePendingCents: 0 })
  })

  // ACHADO (baixo/médio, a confirmar contra a Cielo real): nada impede os DOIS executores de passar pela reconsulta (ambos veem AUTHORIZED) e
  // chamar `capturar()` — a checagem "reconsulta antes de capturar" não é atômica com a captura. Hoje o dano é contido (o 2º PUT é recusado pela
  // Cielo/Fake, o job retenta, reconsulta e só espelha), mas o código documenta que NÃO se sabe se um 2º PUT `/capture` é seguro/idempotente
  // (`capturarSessaoCartao.ts`, "A CONFIRMAR"): se a Cielo aceitar uma 2ª captura (ex.: parcial), o motorista paga em dobro.
  // CAUSA RAIZ: reconsultar -> capturar -> gravar não é serializado por intent; o `jobId` só impede dois JOBS vivos, não dois executores do mesmo job.
  // CORREÇÃO sugerida: "reservar" a captura antes do PUT (UPDATE condicional CAPTURE_PENDING -> CAPTURING com updatedAt, ou lock Redis/advisory
  // por intent com TTL > timeout do PUT) e só o dono do lock chama `capturar()`.
  // `it.fails`: quando corrigido isto passa a FALHAR -> trocar por `it`.
  it.fails('(BUG) `capturar()` é chamado NO MÁXIMO uma vez no gateway mesmo com dois executores simultâneos do mesmo intent', async () => {
    const { intent } = await fx.sessaoParada('uma-vez')
    const { porta, estado } = gatewayComLatencia(fake, 120)

    await Promise.allSettled([capturarSessaoCartao(intent.id, porta), capturarSessaoCartao(intent.id, porta)])

    expect(estado.entradasCapturar).toBe(1)
  })
})
