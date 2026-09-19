import { afterAll, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import Redis from 'ioredis'
import type { Prisma } from '@prisma/client'

// A app fala com o Redis pelo proxy desta suíte (latência controlável); o assinante lê o Redis REAL, direto.
const { proxy, realRedisUrl } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})

import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { publishToUser, publisherStatus, MAX_PUBLISHES_IN_FLIGHT, PUBLISH_CIRCUIT_OPEN_MS, PUBLISH_TIMEOUT_MS, userChannel } from '../../src/realtime/bus'
import { finalizarSessao } from '../../src/services/carteira/finalizarSessao'
import { createTenant, createUser, makeIdTag, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * O que o prazo de 500 ms + disjuntor de 1 s do `publish()` (realtime/bus.ts) faz com um Redis que está
 * VIVO mas LENTO, e com o event loop do processo ocupado (Íris, 2026-09-19, revisão das correções do Vega).
 *
 * O prazo NÃO cancela o comando (já foi escrito no socket: o Redis o executa e entrega, atrasado). O que o
 * disjuntor faz é NÃO ENVIAR os publishes seguintes durante 1 s depois de UM estouro — mesmo com a conexão
 * de pé. Com o Redis MORTO isso é o desejado (nada a entregar); com o Redis só LENTO (fork de BGSAVE, disco,
 * CPU disputada) ou o processo engasgado (bcryptjs de custo 12 em rajada: ver o teste do event loop) é PERDA
 * de evento que o Redis entregaria, e ninguém reenvia. Os eventos são "best-effort, o polling cobre" — o
 * polling do frontend é de 60 s com o stream saudável (`useSites`, `useActiveSession`).
 *
 * Isolamento: usuários novos por teste, canais próprios (ui:ev:user:{id}).
 */

const suffix = uniqueSuffix()
const direct = new Redis(realRedisUrl)

afterAll(async () => {
  await proxy.up()
  await direct.quit().catch(() => {})
  redis.disconnect()
  await proxy.stop()
})

const aguardarRedisPronto = () => waitFor(async () => redis.status === 'ready' && publisherStatus() === 'ready', { timeoutMs: 15_000, what: 'conexões com o Redis prontas' })
const evento = (userId: string, n: number) => ({ type: 'wallet.updated' as const, occurredAt: new Date().toISOString(), userId, balanceCents: n })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function assinar(userId: string) {
  const assinante = new Redis(realRedisUrl)
  const recebidos: Array<{ at: number; event: { type: string; balanceCents?: number } }> = []
  assinante.on('message', (_canal, msg) => recebidos.push({ at: Date.now(), event: JSON.parse(msg) }))
  await assinante.subscribe(userChannel(userId))
  return { recebidos, fechar: () => assinante.quit().catch(() => {}) }
}

describe('Redis LENTO (vivo) — pico de latência acima do prazo do publish', () => {
  it('MEDIÇÃO: 700ms de latência por 6s, 1 evento a cada 100ms — o publish nunca passa do prazo e volta ao normal em ~1s depois do pico; registra quantos eventos se perdem', async () => {
    await aguardarRedisPronto()
    const u = await createUser({ role: 'DRIVER', label: 'lento-rajada', suffix })
    const sub = await assinar(u.id)
    try {
      await sleep(PUBLISH_CIRCUIT_OPEN_MS + 100) // testes anteriores podem ter deixado o disjuntor aberto
      const duracoes: number[] = []
      const enviarUm = async (n: number) => {
        const t = Date.now()
        await publishToUser(u.id, evento(u.id, n))
        duracoes.push(Date.now() - t)
      }

      proxy.latency(700)
      const inicioPico = Date.now()
      const pendentes: Promise<void>[] = []
      let n = 0
      for (; Date.now() - inicioPico < 6_000; n++) {
        pendentes.push(enviarUm(n))
        await sleep(100)
      }
      const fimPico = Date.now()
      const enviadosNoPico = n
      proxy.latency(0)

      // Depois do pico: continua publicando 1 a cada 100ms e mede quanto demora até um evento NOVO chegar.
      let primeiroNovo: number | undefined
      const baseNovo = 1_000
      for (let i = 0; i < 40 && primeiroNovo === undefined; i++) {
        pendentes.push(enviarUm(baseNovo + i))
        await sleep(100)
        const novo = sub.recebidos.find((r) => (r.event.balanceCents ?? 0) >= baseNovo)
        if (novo) primeiroNovo = novo.at - fimPico
      }
      await Promise.all(pendentes)
      await sleep(1_500) // entrega dos que ficaram atrasados

      const noPico = sub.recebidos.filter((r) => (r.event.balanceCents ?? 0) < baseNovo).length
      console.log(
        `[medicao] pico de 700ms por 6s: ${enviadosNoPico} eventos publicados, ${noPico} entregues (${enviadosNoPico - noPico} PERDIDOS, ${Math.round(((enviadosNoPico - noPico) / enviadosNoPico) * 100)}%); ` +
          `pior duracao de um publish=${Math.max(...duracoes)}ms; primeiro evento NOVO entregue ${primeiroNovo}ms depois do fim do pico`,
      )
      expect(Math.max(...duracoes)).toBeLessThan(PUBLISH_TIMEOUT_MS + 300) // o publish NUNCA pendura mais que o prazo
      expect(primeiroNovo).toBeDefined()
      expect(primeiroNovo!).toBeLessThan(PUBLISH_CIRCUIT_OPEN_MS + 1_000) // o disjuntor fecha sozinho: normaliza em ~1s
    } finally {
      proxy.latency(0)
      await sub.fechar()
    }
  }, 60_000)

  /**
   * ACHADO (Íris, 2026-09-19 — NÃO corrigido aqui, é código de produção): `finalizarSessao` (StopTransaction)
   * publica `session.stopped` e, DEPOIS de esperá-lo, `wallet.updated`. Com o Redis vivo mas lento (>500ms), o
   * `session.stopped` estoura o prazo e ABRE o disjuntor, e o `wallet.updated` que vem logo em seguida é
   * DESCARTADO sem nem ser enviado — o Redis o teria entregue. O motorista vê a sessão encerrada mas o saldo
   * antigo (o handler de `session.stopped` do frontend não invalida a carteira; só o `wallet.updated` invalida,
   * e a carteira tem staleTime de 60s e nenhum polling). Antes da correção, os dois eram entregues, só
   * atrasados. Causa raiz: o disjuntor pula o ENVIO (não só a ESPERA) enquanto a conexão está de pé.
   * `it.fails` = comportamento DESEJADO (o Redis está vivo: os dois eventos chegam); vire `it` ao corrigir
   * (ex.: com a conexão `ready`, enviar sempre e só não esperar; descartar apenas com a conexão caída ou o
   * teto de pendentes cheio).
   */
  it.fails('Redis lento (700ms, vivo) no StopTransaction: o motorista recebe session.stopped E wallet.updated (ACHADO: o wallet.updated é descartado pelo disjuntor)', async () => {
    await aguardarRedisPronto()
    await sleep(PUBLISH_CIRCUIT_OPEN_MS + 100)
    const t = await createTenant({ suffix, label: 'lento-stop' })
    const driver = await createUser({ role: 'DRIVER', label: 'lento-stop-driver', suffix })
    const token = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driver.id } })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: 10_000, balanceAfterCents: 10_000, referenceType: 'MANUAL', description: 'Saldo inicial de teste' } })
    const snapshot: Prisma.InputJsonValue = { id: 'snap', model: 'PER_KWH', pricePerKwh: '1.00', pricePerMinute: null, sessionFeeCents: null, minChargeCents: null, idleFeePerMinute: 0, idleGracePeriodSeconds: 0, windows: [] }
    const sessao = await prisma.chargingSession.create({
      data: {
        operatorId: t.operatorId, siteId: t.siteId, chargePointId: t.chargePointId, connectorId: t.connectorId, authTokenId: token.id, userId: driver.id,
        status: 'STARTED', meterStartWh: 0, startedAt: new Date(Date.now() - 60 * 60_000), tariffId: t.tariffId, tariffSnapshot: snapshot,
      },
    })

    const sub = await assinar(driver.id)
    try {
      proxy.latency(700)
      const t0 = Date.now()
      await finalizarSessao(sessao.id, { meterStopWh: 10_000, timestamp: new Date(), stopReason: 'LOCAL' })
      console.log(`[medicao] finalizarSessao com Redis a 700ms: respondeu em ${Date.now() - t0}ms`)
      proxy.latency(0)
      await sleep(2_500) // o que o Redis tiver recebido é entregue nesse tempo
      const tipos = sub.recebidos.map((r) => r.event.type)
      console.log(`[medicao] eventos que chegaram ao motorista: ${JSON.stringify(tipos)}`)
      expect(tipos).toContain('session.stopped')
      expect(tipos).toContain('wallet.updated')
    } finally {
      proxy.latency(0)
      await sub.fechar()
    }
    // O dinheiro foi gravado de qualquer forma.
    const debitos = await prisma.walletEntry.findMany({ where: { walletId: wallet.id, type: 'CHARGE_DEBIT' } })
    expect(debitos).toHaveLength(1)
  }, 60_000)
})

describe('conexão CAÍDA (a conexão sabe): descarte imediato, com o disjuntor FECHADO', () => {
  /**
   * `redisOutageBusinessFlow.test.ts` tem um teste parecido, mas ele roda logo depois de um que deixa o disjuntor
   * ABERTO (~1s): os publishes dele são descartados pelo DISJUNTOR e o descarte por `connectionIsDown` não é
   * exercitado (mutação P3 sobreviveu no arquivo inteiro e morreu só rodando o teste isolado). Aqui o disjuntor
   * é esperado fechar antes, então só o estado da conexão explica o descarte: nenhum publish paga o prazo de
   * 500 ms e nenhum entra na fila offline do ioredis.
   */
  it('com a conexão já caída (reconnecting) e o disjuntor fechado: 50 publishes voltam em bem menos que UM prazo (500ms) e nenhum é entregue quando o Redis volta', async () => {
    await aguardarRedisPronto()
    await sleep(PUBLISH_CIRCUIT_OPEN_MS + 200)
    const u = await createUser({ role: 'DRIVER', label: 'conexao-caida', suffix })
    const sub = await assinar(u.id)
    try {
      await proxy.down()
      await waitFor(async () => publisherStatus() !== 'ready', { timeoutMs: 5_000, what: 'cliente de publicação perceber a queda' })
      const t0 = Date.now()
      for (let i = 0; i < 50; i++) await publishToUser(u.id, evento(u.id, i))
      const gasto = Date.now() - t0
      await proxy.up()
      await aguardarRedisPronto()
      await sleep(1_500)
      console.log(`[medicao] conexao caida, disjuntor fechado: 50 publishes em ${gasto}ms; ${sub.recebidos.length} entregues na volta`)
      expect(gasto).toBeLessThan(PUBLISH_TIMEOUT_MS / 2)
      expect(sub.recebidos).toEqual([])
    } finally {
      await proxy.up()
      await sub.fechar()
    }
  }, 60_000)
})

describe('teto de publishes sem resposta (MAX_PUBLISHES_IN_FLIGHT)', () => {
  it('Redis SAUDÁVEL: 250 publishes em sequência (mais que o teto) são TODOS entregues — o contador de pendentes desce quando o comando liquida', async () => {
    await aguardarRedisPronto()
    await sleep(PUBLISH_CIRCUIT_OPEN_MS + 100)
    const u = await createUser({ role: 'DRIVER', label: 'saudavel-250', suffix })
    const sub = await assinar(u.id)
    try {
      for (let i = 0; i < 250; i++) await publishToUser(u.id, evento(u.id, i))
      await waitFor(async () => sub.recebidos.length >= 250, { timeoutMs: 10_000, what: '250 eventos entregues' })
      expect(sub.recebidos.map((r) => r.event.balanceCents)).toEqual(Array.from({ length: 250 }, (_, i) => i)) // todos, na ordem
    } finally {
      await sub.fechar()
    }
  }, 60_000)

  it('Redis MUDO (blackhole) e 300 publishes de uma vez: só o teto (100) fica na fila do ioredis — quando o Redis volta, no máximo 100 eventos velhos são entregues (o resto foi descartado, não empilhado)', async () => {
    await aguardarRedisPronto()
    await sleep(PUBLISH_CIRCUIT_OPEN_MS + 100)
    const u = await createUser({ role: 'DRIVER', label: 'teto', suffix })
    const sub = await assinar(u.id)
    try {
      await proxy.blackhole()
      // As 300 chamadas passam pelo portão no MESMO tick (o disjuntor ainda está fechado): sem o teto, as 300 entrariam na fila.
      await Promise.all(Array.from({ length: 300 }, (_, i) => publishToUser(u.id, evento(u.id, i))))
      await proxy.up() // derruba os sockets enterrados; o ioredis reconecta e reenvia o que ficou sem resposta
      await aguardarRedisPronto()
      await sleep(2_000)
      console.log(`[medicao] blackhole + 300 publishes simultaneos: ${sub.recebidos.length} entregues depois da volta (teto ${MAX_PUBLISHES_IN_FLIGHT})`)
      expect(sub.recebidos.length).toBeGreaterThan(0) // se nada chegasse, o teste não distinguiria "teto" de "nada foi reenviado"
      expect(sub.recebidos.length).toBeLessThanOrEqual(MAX_PUBLISHES_IN_FLIGHT)
    } finally {
      await proxy.up()
      await sub.fechar()
    }
  }, 60_000)
})

describe('event loop engasgado (o que 20 handshakes OCPP com bcryptjs de custo 12 fazem ao gateway) — sem nenhum problema no Redis', () => {
  /**
   * `bcryptjs` roda em JS puro na thread principal: medido em 30 comparações concorrentes de custo 12, o
   * event loop parou até 3 s. Nesse tempo a resposta do Redis (que já chegou ao socket) só é processada
   * DEPOIS de os timers vencerem — o timer de 500 ms do prazo do publish dispara PRIMEIRO, mesmo com o
   * Redis tendo respondido em 1 ms: o disjuntor abre por um estouro FALSO. É o cenário de um gateway
   * reiniciando com um site cheio de carregadores reconectando (e cada um publica `chargepoint.status`).
   */
  it('MEDIÇÃO: publicando 1 evento a cada 50ms enquanto 20 bcrypt.compare de custo 12 rodam (Redis SAUDÁVEL): registra quantos eventos se perdem', async () => {
    await aguardarRedisPronto()
    await sleep(PUBLISH_CIRCUIT_OPEN_MS + 100)
    const u = await createUser({ role: 'DRIVER', label: 'engasgo', suffix })
    const sub = await assinar(u.id)
    const hash12 = await bcrypt.hash('segredo', 12)
    try {
      let n = 0
      let rodando = true
      const emissor = (async () => {
        while (rodando) {
          void publishToUser(u.id, evento(u.id, n++))
          await sleep(50)
        }
      })()
      const t0 = Date.now()
      let lagMax = 0
      let ultimo = Date.now()
      const relogio = setInterval(() => {
        const agora = Date.now()
        lagMax = Math.max(lagMax, agora - ultimo - 10)
        ultimo = agora
      }, 10)
      await Promise.all(Array.from({ length: 20 }, () => bcrypt.compare('segredo', hash12)))
      clearInterval(relogio)
      const duracaoCarga = Date.now() - t0
      rodando = false
      await emissor
      await sleep(1_500)
      const enviados = n
      const entregues = sub.recebidos.length
      console.log(`[medicao] 20 bcrypt custo 12 concorrentes: ${duracaoCarga}ms, lag maximo do event loop=${lagMax}ms; ${enviados} eventos publicados, ${entregues} entregues (${enviados - entregues} PERDIDOS) com o Redis saudavel`)
      // Sem asserção de perda: é uma medição registrada no relatório. O que se afirma é só que o processo se recupera.
      await publishToUser(u.id, evento(u.id, 99_999))
      await waitFor(async () => sub.recebidos.some((r) => r.event.balanceCents === 99_999), { timeoutMs: 5_000, what: 'publish voltar a ser entregue depois da carga' })
    } finally {
      await sub.fechar()
    }
  }, 120_000)
})
