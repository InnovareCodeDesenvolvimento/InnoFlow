import { afterAll, describe, expect, it, vi } from 'vitest'
import Redis from 'ioredis'

// Mesmo recurso de `redisOutageBusinessFlow.test.ts`: a API fala com o Redis por um proxy TCP desta suíte, então "Redis fora do
// ar/travado" é mexer no proxy — o Redis compartilhado nunca é tocado. Hoisted: tem que valer antes de `lib/env` ser importado.
const { proxy, realRedisUrl } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})

import { redis } from '../../src/lib/redis'
import { MAX_PUBLISHES_IN_FLIGHT, publishToUser, publisherStatus, userChannel } from '../../src/realtime/bus'
import { waitFor } from './helpers/fixtures'

/**
 * O que o publish de eventos de UI (`realtime/bus.ts`) deixa na fila do ioredis durante uma queda do Redis, e o que
 * acontece DEPOIS (Íris, 02/10/2026 — revisão do `c64afc2`, que trocou a pré-condição de `redisOutageBusinessFlow` de
 * `!== 'ready'` para `['reconnecting','close','end']` porque 'connect'/'connecting' ENFILEIRAM em vez de descartar).
 *
 * Medido (Windows, PG18 + Redis 5, proxy TCP; ioredis 5.11):
 *  - Redis TRAVADO com a conexão de pé (status 'ready', comando enviado e sem resposta): ao voltar, o ioredis REENVIA o que
 *    estava pendente — exatamente `MAX_PUBLISHES_IN_FLIGHT` (100) eventos velhos chegam em lote, na ordem. É o pior caso
 *    LIMITADO pelo teto, e aceitável: no frontend (`realtimeEventHandlers.ts`) `wallet.updated`/`session.*` só INVALIDAM
 *    queries (um refetch a mais), então um evento atrasado não mostra dado velho. Primeiro teste, como documentação.
 *  - Redis que ACEITA a conexão e nunca responde (status 'connect', antes de 'ready') e é derrubado: BUG — ver o 2º teste.
 *
 * ORDEM IMPORTA: o 2º teste deixa o contador de pendentes do `bus.ts` vazado (é o defeito que ele descreve), então vem por último.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const evento = (userId: string, n: number) => ({ type: n % 2 === 0 ? ('wallet.updated' as const) : ('session.stopped' as const), occurredAt: new Date().toISOString(), userId, balanceCents: n, n }) as never

afterAll(async () => {
  await proxy.up()
  redis.disconnect()
  await proxy.stop()
})

async function assinar(userId: string) {
  const assinante = new Redis(realRedisUrl) // FORA do proxy: vê o que o Redis real recebe
  const recebidos: number[] = []
  assinante.on('message', (_canal, msg) => recebidos.push(JSON.parse(msg).n))
  await assinante.subscribe(userChannel(userId))
  return { recebidos, fechar: () => assinante.quit().catch(() => {}) }
}

/** Espera o publisher estar `ready` DE VERDADE (a conexão do processo é preguiçosa: o 1º publish a abre). */
async function publisherPronto() {
  await publishToUser('aquecer', evento('aquecer', 0))
  await waitFor(async () => publisherStatus() === 'ready', { timeoutMs: 20_000, what: 'o publisher ficar ready' })
}

async function esperarEstabilizar(recebidos: number[], quietoMs = 2_000, limiteMs = 25_000) {
  const fim = Date.now() + limiteMs
  let ultimo = -1
  let desde = Date.now()
  while (Date.now() < fim) {
    await sleep(100)
    if (recebidos.length !== ultimo) {
      ultimo = recebidos.length
      desde = Date.now()
    } else if (Date.now() - desde >= quietoMs) return
  }
}

describe('Redis fora do ar — o que fica na fila do publish e o que acontece depois', () => {
  it('DOCUMENTA: com o Redis TRAVADO e a conexão "de pé" (ready), ao voltar são entregues NO MÁXIMO MAX_PUBLISHES_IN_FLIGHT eventos velhos, em lote, na ordem (o excedente foi descartado)', async () => {
    await publisherPronto()
    const userId = `fila-ready-${Math.random().toString(36).slice(2, 8)}`
    const { recebidos, fechar } = await assinar(userId)
    try {
      await proxy.blackhole()
      for (let n = 0; n < MAX_PUBLISHES_IN_FLIGHT + 50; n++) {
        await publishToUser(userId, evento(userId, n))
        await sleep(5)
      }
      expect(recebidos).toEqual([]) // nada passou enquanto o Redis estava mudo
      await proxy.up() // derruba o socket mudo; o cliente reconecta e REENVIA o que estava pendente
      await esperarEstabilizar(recebidos)

      expect(recebidos).toHaveLength(MAX_PUBLISHES_IN_FLIGHT) // exatamente o teto: os 150 publicados menos os 50 descartados
      expect(recebidos).toEqual(Array.from({ length: MAX_PUBLISHES_IN_FLIGHT }, (_, i) => i)) // os PRIMEIROS, na ordem de envio
    } finally {
      await proxy.up()
      await fechar()
    }
  }, 60_000)

  // ACHADO (Íris, 02/10/2026 — severidade MÉDIA, para o Vega): o contador `publishesInFlight` de `bus.ts` VAZA para sempre.
  // Causa raiz (lida em `ioredis/built/redis/event_handler.js`, `closeHandler`): só quando o status ANTERIOR era 'ready' o ioredis
  // guarda a fila de comandos já enviados (`prevCommandQueue`, reenviada ao reconectar). Um PUBLISH escrito no socket com a conexão em
  // 'connect' (TCP aberto, ainda sem 'ready' — o Redis aceita e não responde: BGSAVE/fork, host sobrecarregado, partição) e cujo socket
  // morre antes do 'ready' fica ÓRFÃO: não é reenviado, não é rejeitado (com `maxRetriesPerRequest: null` o ioredis nunca faz flush) e a
  // promessa NUNCA liquida — então `pending.then(() => publishesInFlight--)` nunca roda. Depois de 100 órfãos (MAX_PUBLISHES_IN_FLIGHT)
  // o `publish()` DESCARTA TODO evento, para sempre, com o Redis já saudável (só a reinicialização do processo conserta) — SSE, wallet.updated,
  // session.*, chargepoint.status param em silêncio e o log diz "Redis indisponível" com a conexão `ready`. `connectionIsDown` não ajuda:
  // 'connect' não conta como queda (de propósito: pode ser o 1º uso da conexão preguiçosa).
  // `it.fails`: quando o Vega corrigir (ex.: prazo de vida para a vaga de pendente, ou liberar as vagas no 'close'/'ready'), isto passa a
  // FALHAR e vira `it`. Confirmado numa cópia como `it` que ele falha pelo motivo certo (nenhum dos eventos NOVOS chega com o Redis saudável).
  it.fails('(BUG) depois de um Redis que aceitou a conexão e nunca respondeu (status "connect") e voltou, o publish VOLTA a entregar — o contador de pendentes não pode vazar', async () => {
    const userId = `fila-connect-${Math.random().toString(36).slice(2, 8)}`
    const { recebidos, fechar } = await assinar(userId)
    try {
      await proxy.down()
      await sleep(50)
      await proxy.blackhole() // o cliente reconecta, o TCP abre, e ele fica em 'connect' esperando o ready-check que nunca vem
      await waitFor(async () => publisherStatus() === 'connect', { timeoutMs: 15_000, what: 'publisher preso em connect' })
      for (let n = 0; n < MAX_PUBLISHES_IN_FLIGHT + 50; n++) {
        await publishToUser(userId, evento(userId, n))
        await sleep(5)
      }
      await proxy.up() // derruba o socket mudo: os comandos enviados em 'connect' ficam órfãos
      await waitFor(async () => publisherStatus() === 'ready', { timeoutMs: 20_000, what: 'o publisher reconectar' })
      await esperarEstabilizar(recebidos, 1_000, 5_000) // o que (eventualmente) a fila antiga entregar não conta
      recebidos.length = 0

      // Redis SAUDÁVEL agora: eventos NOVOS têm que chegar.
      for (let n = 1_000; n < 1_050; n++) await publishToUser(userId, evento(userId, n))
      await esperarEstabilizar(recebidos, 1_000, 8_000)
      expect(recebidos.length).toBeGreaterThan(0)
    } finally {
      await proxy.up()
      await fechar()
    }
  }, 90_000)
})
