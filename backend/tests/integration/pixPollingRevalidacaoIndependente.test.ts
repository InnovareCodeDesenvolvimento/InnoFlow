import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import Redis from 'ioredis'

// Redis da aplicação pelo proxy desta suíte (para o teste de Redis fora); o Redis REAL é inspecionado direto (TTL das reservas).
const { proxy, realRedisUrl } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})
// Banco próprio: o varredor olha o banco INTEIRO e `take: 50`/300 por rodada — no compartilhado ele varreria intents de outras suítes.
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('pix_poll_r3')
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { calcularReadiness } from '../../src/core/pagamentos/configGateway'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { backoffPollSegundos, chaveConsultaPorLeituraPix, chaveCursorVarredorPix, chaveProximaConsultaPix, LOTE_POLL_PIX, tentarCreditarPixPendente, varrerTopupsPixPendentes } from '../../src/services/pagamentos/pollTopupsPix'
import { varrerTopupsPixExpirados } from '../../src/services/pagamentos/varrerTopupsPixExpirados'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa } from './helpers/cenarioCartaoHttp'
import { createUser, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Íris (rodada 3) — REVALIDAÇÃO INDEPENDENTE do Pix por POLLING (conta Cielo compartilhada, sem webhook do InnoFlow). O adaptador é o REAL, a Cielo é falsa por TCP e CONTA cada
 * consulta que de fato chegou a ela (`GET_BY_ID`); Postgres e Redis reais. As provas são sobre o mundo da Cielo: "sem martelar" = poucas consultas chegaram; "idempotente" = um só
 * lançamento no razão.
 */

const mo = (intentId: string) => `IF-${intentId}`

describe('Pix por polling (varredor + gatilho na leitura) — Cielo falsa por TCP', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  const direct = new Redis(realRedisUrl)
  const baseline = { ...env } as Record<string, unknown>
  const e = env as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }
  let n = 0

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 600 })
    e.TOPUP_PIX_MAX_PENDING_PER_USER = 50
  }, 30_000)
  beforeEach(async () => {
    cielo.zerarRegistro()
    await proxy.up()
    e.TOPUP_PIX_POLL_MIN_AGE_MS = 15_000
    await limparMeusPix()
  })
  afterAll(async () => {
    Object.assign(env, baseline)
    process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await limparMeusPix().catch(() => undefined)
    await proxy.stop()
    await cielo.parar()
    direct.disconnect()
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  })

  /**
   * Parte de zero SEM tocar no que é dos outros: o Redis é COMPARTILHADO entre as suítes em paralelo, e um `keys('pix-poll:*')` + `del` apagava as reservas (`pix-poll:next:<id>`/`read:<id>`) e o
   * CURSOR (`pix-poll:cursor:<banco>`) de outros arquivos no meio do teste deles (flake do teste "Pix NÃO pago" da Vega). Aqui só saem as chaves dos intents DESTE banco (banco próprio) e o cursor
   * DESTE banco (a chave leva o nome do banco).
   */
  async function limparMeusPix() {
    const meus = await prisma.paymentIntent.findMany({ where: { purpose: 'WALLET_TOPUP_PIX' }, select: { id: true } })
    const chaves = [chaveCursorVarredorPix(), ...meus.flatMap((i) => [chaveProximaConsultaPix(i.id), chaveConsultaPorLeituraPix(i.id)])]
    for (let i = 0; i < chaves.length; i += 500) await direct.del(...chaves.slice(i, i + 500))
    await prisma.paymentIntent.deleteMany({ where: { purpose: 'WALLET_TOPUP_PIX' } }) // varredor olha o banco inteiro: cada teste parte de zero
  }

  async function motoristaComCarteira() {
    const u = await createUser({ role: 'DRIVER', label: `pixr3-${++n}`, suffix })
    const wallet = await prisma.wallet.create({ data: { userId: u.id } })
    return { ...u, walletId: wallet.id, auth: { Authorization: `Bearer ${u.token}` } }
  }
  type Mot = Awaited<ReturnType<typeof motoristaComCarteira>>

  /** Pix criado pela PORTA HTTP (o caminho real), já PENDING na Cielo falsa. */
  async function pixPelaApi(m: Mot, centavos = 1500) {
    const res = await request(app).post('/api/me/wallet/topups').set(m.auth).send({ amountCents: centavos })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: m.id, purpose: 'WALLET_TOPUP_PIX' }, orderBy: { createdAt: 'desc' } })
    return { intent, venda: cielo.vendaPorPedido(mo(intent.id))! }
  }
  /** Linhas direto no banco + venda PENDING na Cielo falsa — para volumes que a API (limite por usuário/rate limit) não permite. */
  async function pixEmMassa(m: Mot, quantidade: number, idadeSeg: number) {
    const base = Date.now()
    const ids: string[] = []
    for (let i = 0; i < quantidade; i++) {
      const i2 = await prisma.paymentIntent.create({
        data: {
          purpose: 'WALLET_TOPUP_PIX',
          provider: 'CIELO_PIX',
          userId: m.id,
          walletId: m.walletId,
          amountRequestedCents: 1000,
          status: 'PENDING',
          cieloPaymentId: `pay-massa-${suffix}-${base}-${i}`,
          pixQrCode: 'qr',
          pixExpiresAt: new Date(base + 25 * 60_000),
          createdAt: new Date(base - idadeSeg * 1000 - i),
        },
      })
      cielo.plantarVenda({ paymentId: i2.cieloPaymentId!, merchantOrderId: mo(i2.id), status: 12, returnCode: '0', amount: 1000, tipo: 'Pix' })
      ids.push(i2.id)
    }
    return ids
  }
  const consultasDe = (paymentId: string) => cielo.contar('GET_BY_ID', { paymentId })
  const pagar = (paymentId: string) => {
    const v = cielo.vendas.get(paymentId)!
    v.status = 2
  }
  const saldo = async (m: Mot) => (await prisma.walletEntry.findFirst({ where: { walletId: m.walletId }, orderBy: { createdAt: 'desc' } }))?.balanceAfterCents ?? 0
  const lancamentos = (m: Mot) => prisma.walletEntry.count({ where: { walletId: m.walletId, type: 'TOPUP_PIX' } })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('backoff por idade, teto por rodada e reservas', () => {
    it('backoffPollSegundos: 15 s no 1º minuto, 30 s até 5 min, 60 s até 30 min, 120 s depois (fronteiras exatas)', () => {
      const casos: Array<[number, number]> = [[0, 15], [59, 15], [60, 30], [299, 30], [300, 60], [1799, 60], [1800, 120], [86_400, 120]]
      for (const [idade, esperado] of casos) expect(backoffPollSegundos(idade), `idade ${idade}s`).toBe(esperado)
    })

    it('a reserva no Redis nasce com o TTL da faixa de idade (15/30/60/120 s) — e uma 2ª rodada IMEDIATA não consulta ninguém de novo', async () => {
      const m = await motoristaComCarteira()
      const faixas: Array<[number, number]> = [[20, 15], [90, 30], [600, 60], [1_700 + 200, 120]]
      const consultados: Array<{ id: string; pid: string; ttl: number }> = []
      for (const [idade, ttl] of faixas) {
        const [id] = await pixEmMassa(m, 1, idade)
        const pid = (await prisma.paymentIntent.findUniqueOrThrow({ where: { id } })).cieloPaymentId!
        consultados.push({ id, pid, ttl })
      }
      // o de 1.900 s precisa continuar dentro do prazo do QR: pixEmMassa já dá 25 min de validade a partir de AGORA
      const r1 = await varrerTopupsPixPendentes()
      expect(r1).toEqual({ consultados: 4, creditados: 0 })
      for (const c of consultados) {
        expect(consultasDe(c.pid)).toBe(1)
        const pttl = await direct.pttl(chaveProximaConsultaPix(c.id))
        expect(pttl, `faixa de ${c.ttl} s`).toBeGreaterThan(c.ttl * 1000 - 2_000)
        expect(pttl).toBeLessThanOrEqual(c.ttl * 1000)
      }
      const r2 = await varrerTopupsPixPendentes()
      expect(r2.consultados).toBe(0)
      for (const c of consultados) expect(consultasDe(c.pid)).toBe(1) // a Cielo NÃO foi tocada de novo
      // simula o fim do backoff de UM deles: só ele é consultado
      await direct.del(chaveProximaConsultaPix(consultados[1].id))
      expect((await varrerTopupsPixPendentes()).consultados).toBe(1)
      expect(consultasDe(consultados[1].pid)).toBe(2)
      expect(consultasDe(consultados[0].pid)).toBe(1)
    })

    it('Pix MAIS NOVO que a idade mínima (15 s) não é consultado ainda; fora do prazo do QR fica com o expirador (não é consultado pelo varredor de polling)', async () => {
      const m = await motoristaComCarteira()
      const [novo] = await pixEmMassa(m, 1, 3)
      const [vencido] = await pixEmMassa(m, 1, 2_000)
      await prisma.paymentIntent.update({ where: { id: vencido }, data: { pixExpiresAt: new Date(Date.now() - 60_000) } })
      const r = await varrerTopupsPixPendentes()
      expect(r.consultados).toBe(0)
      expect(cielo.contar('GET_BY_ID')).toBe(0)
      expect(await direct.exists(chaveProximaConsultaPix(novo))).toBe(0)
      expect(await direct.exists(chaveProximaConsultaPix(vencido))).toBe(0)
    })

    it(`TETO de ${LOTE_POLL_PIX} consultas à Cielo por rodada: 130 Pix pendentes => 50, 50, 30 em 3 rodadas seguidas, cada um consultado UMA vez`, async () => {
      const m = await motoristaComCarteira()
      const ids = await pixEmMassa(m, 130, 30)
      const resultados = []
      for (let i = 0; i < 3; i++) {
        resultados.push((await varrerTopupsPixPendentes()).consultados)
        if (i === 0) expect(cielo.contar('GET_BY_ID')).toBe(LOTE_POLL_PIX) // a Cielo recebeu EXATAMENTE o teto na 1ª rodada
      }
      expect(resultados).toEqual([50, 50, 30])
      expect(cielo.contar('GET_BY_ID')).toBe(130)
      for (const id of ids) expect(consultasDe((await prisma.paymentIntent.findUniqueOrThrow({ where: { id } })).cieloPaymentId!)).toBe(1)
      expect((await varrerTopupsPixPendentes()).consultados).toBe(0) // todos em backoff
    })

    it(`o TETO vale também no meio de uma página: 30 já em backoff na 1ª página + 70 devidos => a rodada consulta EXATAMENTE ${LOTE_POLL_PIX}, não 70`, async () => {
      const m = await motoristaComCarteira()
      const ids = await pixEmMassa(m, 100, 30)
      const ordenados = [...ids].sort() // o varredor lê por id crescente
      for (const id of ordenados.slice(0, 30)) await direct.set(chaveProximaConsultaPix(id), '1', 'EX', 600) // os 30 primeiros já foram consultados há pouco
      const r = await varrerTopupsPixPendentes()
      expect(r.consultados).toBe(LOTE_POLL_PIX)
      expect(cielo.contar('GET_BY_ID')).toBe(LOTE_POLL_PIX)
    })

    it('DOIS varredores ao mesmo tempo (2 workers): a reserva NX evita consulta dupla — cada Pix é consultado no máximo UMA vez e o teto vale somado', async () => {
      const m = await motoristaComCarteira()
      await pixEmMassa(m, 60, 30)
      const [a, b] = await Promise.all([varrerTopupsPixPendentes(), varrerTopupsPixPendentes()])
      expect(a.consultados + b.consultados).toBeLessThanOrEqual(60)
      const consultas = cielo.chamadas.filter((c) => c.rota === 'GET_BY_ID')
      const porId = new Map<string, number>()
      for (const c of consultas) porId.set(c.paymentId!, (porId.get(c.paymentId!) ?? 0) + 1)
      expect([...porId.values()].every((q) => q === 1)).toBe(true)
      expect(consultas.length).toBe(a.consultados + b.consultados)
    })

    // ACHADO (rodada 3, severidade baixa; só aparece com > 300 Pix pendentes AO MESMO TEMPO): o varredor lê no máximo 6 páginas x 50 (= 300) por rodada, ordenadas por id. Os 300 primeiros
    // ficam sempre "devidos" quando o backoff deles vence, e a cauda nunca é lida. Hoje só o gatilho de LEITURA e o expirador (que reconsulta) alcançam a cauda. `it.fails`: ao corrigir
    // (ordenar por "consultado há mais tempo" / cursor persistente), vira `it`.
    it('ACHADO — com 320 Pix pendentes, todos deveriam ser consultados ao menos uma vez em 8 rodadas (hoje a cauda além da posição 300 nunca é lida)', async () => {
      const m = await motoristaComCarteira()
      const ids = await pixEmMassa(m, 320, 30)
      for (let i = 0; i < 8; i++) await varrerTopupsPixPendentes()
      const nuncaConsultados = []
      for (const id of ids) {
        const pid = (await prisma.paymentIntent.findUniqueOrThrow({ where: { id } })).cieloPaymentId!
        if (consultasDe(pid) === 0) nuncaConsultados.push(id)
      }
      expect(nuncaConsultados).toHaveLength(0)
    }, 120_000)

    it('Pix de OUTRO ambiente que o gateway efetivo NÃO é consultado (host errado) e fica PENDING', async () => {
      const m = await motoristaComCarteira()
      const [id] = await pixEmMassa(m, 1, 30)
      await prisma.paymentIntent.update({ where: { id }, data: { environment: 'PRODUCTION' } }) // o gateway efetivo deste banco é SANDBOX
      const r = await varrerTopupsPixPendentes()
      expect(r.consultados).toBe(0)
      expect(cielo.contar('GET_BY_ID')).toBe(0)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING')
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('crédito idempotente e gatilho na leitura', () => {
    it('Cielo diz PAGO: 3 varreduras + 6 leituras da tela EM PARALELO => 1 só lançamento no razão, saldo = valor, intent PAID', async () => {
      const m = await motoristaComCarteira()
      const { intent, venda } = await pixPelaApi(m, 2_500)
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { createdAt: new Date(Date.now() - 30_000) } })
      pagar(venda.paymentId)
      const leituras = Array.from({ length: 6 }, () => request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth))
      await Promise.all([varrerTopupsPixPendentes(), varrerTopupsPixPendentes(), varrerTopupsPixPendentes(), ...leituras])
      expect(await lancamentos(m)).toBe(1)
      expect(await saldo(m)).toBe(2_500)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
      // nenhuma varredura/leitura posterior credita de novo
      await direct.del(chaveProximaConsultaPix(intent.id), chaveConsultaPorLeituraPix(intent.id))
      await varrerTopupsPixPendentes()
      expect(await lancamentos(m)).toBe(1)
      // o razão tem o índice único que garante isso mesmo se o código errasse
      const idx = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE indexname = 'ux_wallet_entry_topup_once'`
      expect(idx).toHaveLength(1)
    })

    it('GATILHO NA LEITURA: 25 leituras em ~1,5 s => UMA consulta à Cielo; a leitura que vê o pagamento já devolve PAID; depois de 5 s sai mais uma', async () => {
      const m = await motoristaComCarteira()
      const { intent, venda } = await pixPelaApi(m)
      const ler = () => request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth)
      const rajada = await Promise.all(Array.from({ length: 25 }, ler))
      expect(rajada.every((r) => r.status === 200 && r.body.status === 'PENDING')).toBe(true)
      expect(consultasDe(venda.paymentId)).toBe(1)
      await new Promise((r) => setTimeout(r, 5_300))
      pagar(venda.paymentId)
      const depois = await ler()
      expect(depois.body.status, JSON.stringify(depois.body)).toBe('PAID') // creditou NA leitura, sem esperar o varredor
      expect(consultasDe(venda.paymentId)).toBe(2)
      expect(await saldo(m)).toBe(1_500)
    }, 30_000)

    it('leitura de Pix de OUTRO usuário => 404 e a Cielo NÃO é consultada; Pix que não está PENDING (PAID/EXPIRED) também não gera consulta', async () => {
      const dono = await motoristaComCarteira()
      const intruso = await motoristaComCarteira()
      const { intent, venda } = await pixPelaApi(dono)
      const r = await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(intruso.auth)
      expect(r.status).toBe(404)
      expect(consultasDe(venda.paymentId)).toBe(0)
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'EXPIRED' } })
      await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(dono.auth)
      expect(consultasDe(venda.paymentId)).toBe(0)
    })

    it('Cielo FORA/lenta na leitura: a tela responde 200 com o estado atual dentro do prazo (a leitura não espera a Cielo indefinidamente) e nada é creditado', async () => {
      const m = await motoristaComCarteira()
      const { intent } = await pixPelaApi(m)
      cielo.agendar('GET_BY_ID', { resposta: 'travar' })
      const t0 = Date.now()
      const r = await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth)
      expect(r.status).toBe(200)
      expect(r.body.status).toBe('PENDING')
      expect(Date.now() - t0).toBeLessThan(8_000)
      expect(await lancamentos(m)).toBe(0)
    }, 30_000)

    it('Cielo devolve 5xx/derruba a conexão no varredor: o lote NÃO morre (os outros são consultados) e o intent com falha só tenta de novo depois do backoff', async () => {
      const m = await motoristaComCarteira()
      const ids = await pixEmMassa(m, 3, 30)
      cielo.agendar('GET_BY_ID', { resposta: { http: 503, bruto: 'x' } }, { resposta: 'derrubar' })
      const aviso = vi.spyOn(logger, 'error')
      const r = await varrerTopupsPixPendentes()
      aviso.mockRestore()
      expect(r.consultados).toBe(3)
      expect(cielo.contar('GET_BY_ID')).toBe(3)
      expect((await varrerTopupsPixPendentes()).consultados).toBe(0) // os 3 (inclusive os 2 que falharam) estão em backoff: não martela
      expect(ids).toHaveLength(3)
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('Redis fora: o varredor não consulta nada (não martela a Cielo sem controle) e nada se perde', () => {
    it('Redis CAÍDO: varredura e leitura fazem ZERO consultas; ao voltar, o Pix pago é creditado pelo caminho normal', async () => {
      const m = await motoristaComCarteira()
      const { intent, venda } = await pixPelaApi(m)
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { createdAt: new Date(Date.now() - 30_000) } })
      pagar(venda.paymentId)
      await proxy.down()
      const r = await varrerTopupsPixPendentes()
      expect(r.consultados).toBe(0)
      expect(await tentarCreditarPixPendente(intent.id)).toBe(false)
      expect(cielo.contar('GET_BY_ID')).toBe(0)
      expect(await lancamentos(m)).toBe(0)
      await proxy.up()
      await waitFor(async () => (await varrerTopupsPixPendentes()).creditados === 1 || (await lancamentos(m)) === 1, { timeoutMs: 25_000, what: 'o varredor voltar a creditar depois da reconexão' })
      expect(await lancamentos(m)).toBe(1)
    }, 60_000)

    it('Redis fora NÃO impede o CRÉDITO pelo expirador seguro: ele reconsulta a Cielo direto (sem Redis) e credita um Pix pago cujo QR já venceu; só a PUBLICAÇÃO em tempo real fica esperando o Redis voltar', async () => {
      const m = await motoristaComCarteira()
      const { intent, venda } = await pixPelaApi(m, 3_000)
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { pixExpiresAt: new Date(Date.now() - 60_000) } })
      pagar(venda.paymentId)
      await proxy.down()
      const rodada = varrerTopupsPixExpirados() // o publish (tempo real) pendura sem Redis: não aguardar aqui
      await waitFor(async () => (await lancamentos(m)) === 1, { timeoutMs: 15_000, what: 'o crédito gravado com o Redis fora' })
      expect(await saldo(m)).toBe(3_000)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
      await proxy.up()
      await expect(rodada).resolves.toEqual({ creditados: 1, expirados: 0 }) // termina quando o Redis volta
      expect(await lancamentos(m)).toBe(1)
    }, 60_000)
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('readiness do Pix sem webhook', () => {
    const estado = (over: Record<string, unknown> = {}) =>
      ({
        origem: { merchant: 'env', webhookHeaderSecret: 'env', sop: 'env' },
        merchantId: 'm',
        temMerchantKey: true,
        temWebhookHeaderSecret: false,
        sopClientId: null,
        temSopClientSecret: false,
        environment: 'sandbox',
        cardEnabled: true,
        pixEnabled: true,
        ...over,
      }) as unknown as Parameters<typeof calcularReadiness>[0]
    const envGateway = (over: Record<string, unknown> = {}) => ({ webhookPathToken: undefined, paymentSecretsKeyOk: true, ...over }) as unknown as Parameters<typeof calcularReadiness>[1]

    it('sem token de caminho e sem segredo do header: o Pix NÃO acusa WEBHOOK_PATH_TOKEN nem WEBHOOK_HEADER_SECRET (só credencial importa)', () => {
      const r = calcularReadiness(estado(), envGateway())
      expect(r.pix.missing).not.toContain('WEBHOOK_PATH_TOKEN')
      expect(r.pix.missing).not.toContain('WEBHOOK_HEADER_SECRET')
      expect(r.pix.missing).toEqual([])
      expect(r.pix.ready).toBe(true)
    })

    it('CONTROLE: sem credencial (merchantKey) o Pix continua NÃO pronto — o readiness não virou "sempre verde"', () => {
      const r = calcularReadiness(estado({ temMerchantKey: false }), envGateway())
      expect(r.pix.ready).toBe(false)
      expect(r.pix.missing).toContain('MERCHANT_KEY')
    })
  })
})
