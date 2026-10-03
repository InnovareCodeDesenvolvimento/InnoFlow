import { appendFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * QA da Íris (F5.8, rodada Vega-4) — as corridas do M4c que o teste da Vega NÃO força, agora que a serialização é um LOCK CONSULTIVO (compartilhado em quem cria
 * `PaymentIntent`, exclusivo na transação do PUT do gateway):
 *
 *  M1) o OUTRO lado da serialização: o Pix já está DENTRO da sua transação (preso por um gatilho do banco, de forma determinística) quando o PUT chega — o PUT tem que
 *      ESPERAR o Pix e então ENXERGÁ-LO na contagem (409 GATEWAY_HAS_INFLIGHT_PAYMENTS). Os testes da Vega só provam "o Pix espera a troca" (o lado em que o PUT já tinha
 *      o lock); sem este, apagar o `travarConfigGatewayParaTroca` do PUT NÃO derruba nenhum deles em todas as ordens de chegada;
 *  M2) a PRIMEIRA troca (sem linha em `PaymentGatewayConfig`, ambiente só do env): é o caso que o `FOR SHARE` na linha NÃO cobria e o motivo do lock consultivo;
 *  M3) deadlock/espera infinita: 2 PUTs simultâneos + criação de Pix + criação de intent de cartão, deslocamentos aleatórios, dezenas de rodadas — tudo termina, o Postgres
 *      não registra NENHUM deadlock e nenhum intent vivo sobra com ambiente diferente do efetivo;
 *  M4) cartão com `ambienteEsperado`: recusa 503 quando a troca ocorreu depois de o cartão ser escolhido — também na corrida FORÇADA (espera o PUT e depois recusa);
 *  M5) cartão CADASTRADO (`PaymentMethod`, rota POST /api/me/payment-methods): a troca durante a verificação na Cielo vira 503 e NÃO grava o cartão no ambiente errado;
 *  M6) custo do lock: com um PUT segurando o lock exclusivo, N criadores de intent ficam presos COM conexão do pool — mede se um pedido "bystander" (login) sofre.
 *
 * Forçadas de verdade, sem sorte de temporização: o PUT é segurado por um portão (mock de `writeAuditLog` dentro da transação) e o Pix por um GATILHO do banco que pede um
 * advisory lock de uma chave que o teste segura; a ordem de chegada é confirmada olhando `pg_locks` (esperando/concedido), não com `sleep`.
 */

const gate = vi.hoisted(() => ({
  armado: false,
  entrou: undefined as undefined | (() => void),
  liberar: undefined as undefined | Promise<void>,
}))

vi.mock('../../src/services/auditoria/writeAuditLog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/auditoria/writeAuditLog')>()
  return {
    ...real,
    writeAuditLog: async (...args: Parameters<typeof real.writeAuditLog>) => {
      if (gate.armado && args[0].action === 'PAYMENT_CONFIG_CHANGE') {
        gate.armado = false
        gate.entrou?.()
        await gate.liberar
      }
      return real.writeAuditLog(...args)
    },
  }
})

const CHAVE_SEGURADA = '9000000000001' // advisory lock que o TESTE segura para prender o INSERT do intent (gatilho abaixo)
const VIVOS = ['CREATED', 'AUTHORIZED', 'PENDING', 'CAPTURE_PENDING'] as const
const SAIDA = process.env.IRIS_M4C_SAIDA // opcional: arquivo para gravar medições (o vitest não mostra console.log daqui)

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  getAmbienteEfetivoParaBanco: typeof import('../../src/services/pagamentos/gatewayConfig').getAmbienteEfetivoParaBanco
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  criarIntent: typeof import('../../src/services/pagamentos/criarIntentNoAmbiente').criarPaymentIntentNoAmbienteEfetivo
  encryptPaymentSecret: typeof import('../../src/lib/crypto/paymentSecrets').encryptPaymentSecret
  FakeAdapter: typeof import('../../src/services/pagamentos/fakeAdapter').FakeAdapter
}

const dump = (v: unknown) => JSON.stringify(v)
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('M4c — lock consultivo: corridas forçadas nos dois sentidos, primeira troca, deadlock, cartão — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let fake: InstanceType<Mods['FakeAdapter']>
  let segurador: PrismaClient
  const envBaseline: Record<string, unknown> = {}
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgm')
    // Pool PEQUENO de propósito (4 conexões: o padrão do Prisma numa VPS de 2 vCPU é 5): é o cenário adversário para espera infinita — criadores de intent presos no lock seguram conexão.
    process.env.DATABASE_URL = `${banco.url}${banco.url.includes('?') ? '&' : '?'}connection_limit=4`
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, jwtMod, cfgMod, portMod, criarMod, secMod, fakeMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/pagamentos/criarIntentNoAmbiente'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/fakeAdapter'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      getAmbienteEfetivoParaBanco: cfgMod.getAmbienteEfetivoParaBanco,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      criarIntent: criarMod.criarPaymentIntentNoAmbienteEfetivo,
      encryptPaymentSecret: secMod.encryptPaymentSecret,
      FakeAdapter: fakeMod.FakeAdapter,
    }
    app = m.createApp()
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX', 'PAYMENT_ALLOW_FAKE_ADAPTER']) envBaseline[k] = m.env[k]
    m.resetPagamentoPortCacheParaTeste()
    fake = (await m.getPagamentoPort()) as InstanceType<Mods['FakeAdapter']>
    segurador = new PrismaClient({ datasources: { db: { url: banco.url } } })
    // GATILHO que prende o INSERT de qualquer PaymentIntent enquanto o teste segura a chave (sem segurar, o `xact_lock` volta na hora e não muda nada para as outras suítes/testes).
    await m.prisma.$executeRawUnsafe(`CREATE FUNCTION iris_prender_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${CHAVE_SEGURADA}); RETURN NEW; END $$`)
    await m.prisma.$executeRawUnsafe(`CREATE TRIGGER iris_prender_intent BEFORE INSERT ON "PaymentIntent" FOR EACH ROW EXECUTE FUNCTION iris_prender_intent()`)
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await segurador?.$disconnect()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentIntent.updateMany({ where: { status: { in: [...VIVOS] } }, data: { status: 'EXPIRED' } })
    await m.prisma.paymentGatewayConfig.deleteMany()
    m.env.NODE_ENV = 'test'
    m.env.CIELO_SANDBOX = true
    m.env.PAYMENT_ALLOW_FAKE_ADAPTER = true
    m.invalidarCacheConfigGateway()
    gate.armado = false
  })
  afterEach(() => {
    gate.armado = false
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
  })

  async function novoUsuario(role: 'ADMIN' | 'DRIVER') {
    contador += 1
    const s = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    const user = await m.prisma.user.create({ data: { role, name: `${role} ${s}`, email: `${role.toLowerCase()}-m4c-${s}@example.com`, passwordHash: role === 'ADMIN' ? HASH_SENHA_ADMIN_TESTE : null, ...(role === 'DRIVER' ? { wallet: { create: {} } } : {}) } })
    return { id: user.id, token: m.issueToken({ id: user.id, role, operatorId: null }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  const putProducao = (u: { token: string }) => request(app).put('/api/admin/payment-gateway').set(auth(u)).send({ currentPassword: SENHA_ADMIN_TESTE, environment: 'production', confirmProduction: true, pixEnabled: false, cardEnabled: false }).then((r) => r)
  const pix = (u: { token: string }) => request(app).post('/api/me/wallet/topups').set(auth(u)).send({ amountCents: 2000 }).then((r) => r)
  const semeiaSandbox = () => m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'sandbox', cardEnabled: true, pixEnabled: true } })

  /** Locks consultivos da config (chave `hashtext('payment_gateway_config')`) neste banco, por modo/concedido. */
  async function locksDaConfig() {
    return segurador.$queryRaw<Array<{ mode: string; granted: boolean; n: number }>>`
      SELECT mode, granted, count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND objid::bigint = (hashtext('payment_gateway_config')::bigint & 4294967295)
      GROUP BY mode, granted`
  }
  async function esperandoNaChaveSegurada(): Promise<number> {
    const [r] = await segurador.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = ${CHAVE_SEGURADA}`)
    return r?.n ?? 0
  }
  async function esperarAte(cond: () => Promise<boolean>, quem: string, limiteMs = 10_000) {
    const fim = Date.now() + limiteMs
    while (!(await cond())) {
      if (Date.now() > fim) throw new Error(`timeout esperando: ${quem}. locks da config: ${dump(await locksDaConfig())}`)
      await dormir(30)
    }
  }
  // O MODO do lock é ignorado de propósito: o que importa é quem ESPERA e quem JÁ TEM o lock da config, não se o criador usa shared ou exclusive (trocar um pelo outro só muda a concorrência, não a correção).
  const tem = (locks: Array<{ mode: string; granted: boolean; n: number }>, _mode: string, granted: boolean) => locks.some((l) => l.granted === granted && l.n > 0)

  /** Segura (numa transação do `segurador`) a chave que o gatilho pede; `soltar()` libera. */
  async function segurarChave() {
    let soltar!: () => void
    const liberar = new Promise<void>((r) => (soltar = r))
    let preso!: () => void
    const pronto = new Promise<void>((r) => (preso = r))
    const tx = segurador.$transaction(
      async (t) => {
        await t.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${CHAVE_SEGURADA})`)
        preso()
        await liberar
      },
      { timeout: 60_000, maxWait: 15_000 },
    )
    await pronto
    return { soltar, terminou: tx }
  }
  /** Segura o PUT (portão no `writeAuditLog`, depois da contagem e antes do commit). */
  async function segurarPut() {
    let soltar!: () => void
    gate.liberar = new Promise<void>((r) => (soltar = r))
    const dentro = new Promise<void>((r) => (gate.entrou = r))
    gate.armado = true
    return { soltar, dentro }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  it('M1 — o Pix já está DENTRO da transação (preso por gatilho) quando o PUT chega: o PUT ESPERA e depois ENXERGA o intent (409 GATEWAY_HAS_INFLIGHT_PAYMENTS); a config não muda', async () => {
    await semeiaSandbox()
    m.invalidarCacheConfigGateway()
    const admin = await novoUsuario('ADMIN')
    const motorista = await novoUsuario('DRIVER')
    const preso = await segurarChave()

    const pixEmVoo = pix(motorista)
    await esperarAte(async () => (await esperandoNaChaveSegurada()) > 0 && tem(await locksDaConfig(), 'ShareLock', true), 'o Pix chegar ao gatilho JÁ com o lock compartilhado da config concedido')
    const putEmVoo = putProducao(admin)
    await esperarAte(async () => tem(await locksDaConfig(), 'ExclusiveLock', false), 'o PUT ficar ESPERANDO o lock exclusivo (atrás do Pix)')
    let putTerminou = false
    void putEmVoo.then(() => (putTerminou = true))
    await dormir(300)
    expect(putTerminou, 'o PUT não pode terminar enquanto o Pix (que já tem o lock compartilhado) não commitou').toBe(false)

    preso.soltar()
    await preso.terminou
    const [resPix, resPut] = await Promise.all([pixEmVoo, putEmVoo])
    expect(resPix.status, dump(resPix.body)).toBe(201)
    expect(resPut.status, dump(resPut.body)).toBe(409)
    expect(resPut.body.code).toBe('GATEWAY_HAS_INFLIGHT_PAYMENTS')
    const intent = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: resPix.body.id } })
    expect(intent.environment).toBe('SANDBOX')
    expect((await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })).environment).toBe('sandbox')
    m.invalidarCacheConfigGateway()
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('SANDBOX')
    expect(await m.prisma.paymentIntent.count({ where: { status: { in: [...VIVOS] }, NOT: { environment: 'SANDBOX' } } })).toBe(0)
  }, 60_000)

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  it('M2 — PRIMEIRA troca (sem linha de config, ambiente só do env): o Pix pedido com o PUT dentro da transação ESPERA (lock consultivo não depende da linha) e nasce PRODUCTION', async () => {
    expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)
    m.invalidarCacheConfigGateway()
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('SANDBOX') // do env
    const admin = await novoUsuario('ADMIN')
    const motorista = await novoUsuario('DRIVER')
    const segurado = await segurarPut()
    const putEmVoo = putProducao(admin)
    await Promise.race([segurado.dentro, dormir(15_000).then(() => Promise.reject(new Error('o PUT nunca chegou ao portão')))])
    expect(await m.prisma.paymentGatewayConfig.count(), 'a linha semeada ainda não está visível fora da transação do PUT').toBe(0)

    const pixEmVoo = pix(motorista)
    await esperarAte(async () => tem(await locksDaConfig(), 'ShareLock', false), 'o criador do Pix ficar ESPERANDO o lock compartilhado (a linha nem existe fora da transação)')
    let pixTerminou = false
    void pixEmVoo.then(() => (pixTerminou = true))
    await dormir(300)
    expect(pixTerminou, 'o Pix não pode criar o intent com o ambiente velho durante a primeira troca').toBe(false)

    segurado.soltar()
    const [resPut, resPix] = await Promise.all([putEmVoo, pixEmVoo])
    expect(resPut.status, dump(resPut.body)).toBe(200)
    const intents = await m.prisma.paymentIntent.findMany({ where: { userId: motorista.id } })
    expect(intents.length, `Pix: ${resPix.status} ${dump(resPix.body)}`).toBe(1)
    expect(intents[0]!.environment).toBe('PRODUCTION')
    m.invalidarCacheConfigGateway()
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('PRODUCTION')
    expect(await m.prisma.paymentIntent.count({ where: { status: { in: [...VIVOS] }, environment: 'SANDBOX' } })).toBe(0)
  }, 60_000)

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  it('M3 — 2 PUTs + Pix + intent de cartão simultâneos, 40 rodadas com deslocamentos aleatórios, SEM linha de config: tudo termina, zero deadlock no Postgres, nenhum 500 e nenhum intent vivo com ambiente diferente do efetivo', async () => {
    const [{ antes }] = await m.prisma.$queryRaw<Array<{ antes: number }>>`SELECT deadlocks::int AS antes FROM pg_stat_database WHERE datname = current_database()`
    const metodo = await m.prisma.paymentMethod.create({ data: { userId: (await novoUsuario('DRIVER')).id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret('tok-m3'), brand: 'Visa', last4: '4242', environment: 'SANDBOX' } })
    const resumo = { rodadas: 0, put200: 0, put409: 0, putOutro: [] as number[], pix201: 0, pixOutro: {} as Record<string, number>, cartaoCriado: 0, cartao503: 0, cartaoOutro: [] as string[], maisLenta: 0 }
    for (let i = 0; i < 40; i += 1) {
      await m.prisma.paymentIntent.updateMany({ where: { status: { in: [...VIVOS] } }, data: { status: 'EXPIRED' } })
      await m.prisma.paymentGatewayConfig.deleteMany()
      m.env.CIELO_SANDBOX = true
      m.invalidarCacheConfigGateway()
      const [adminA, adminB, motorista] = await Promise.all([novoUsuario('ADMIN'), novoUsuario('ADMIN'), novoUsuario('DRIVER')])
      await m.getAmbienteEfetivoParaBanco() // aquece o cache em SANDBOX: é o que um criador "atrasado" leria
      const atraso = (max = 25) => dormir(Math.floor(Math.random() * max))
      const t0 = Date.now()
      const limite = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`rodada ${i}: não terminou em 20 s (espera infinita/deadlock?) locks=${dump({})}`)), 20_000))
      const [rA, rB, rPix, rCartao] = await Promise.race([
        Promise.all([
          atraso().then(() => putProducao(adminA)),
          atraso().then(() => putProducao(adminB)),
          atraso(260).then(() => pix(motorista)),
          atraso(260).then(() => m.criarIntent({ purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: metodo.userId, paymentMethodId: metodo.id, walletId: null, amountRequestedCents: 500, status: 'CREATED' }, { ambienteEsperado: 'SANDBOX' }).then((x) => ({ ok: true as const, x }), (e: { statusCode?: number; code?: string }) => ({ ok: false as const, status: e.statusCode, code: e.code }))),
        ]),
        limite,
      ])
      resumo.maisLenta = Math.max(resumo.maisLenta, Date.now() - t0)
      resumo.rodadas += 1
      for (const r of [rA, rB]) {
        if (r.status === 200) resumo.put200 += 1
        else if (r.status === 409 && r.body.code === 'GATEWAY_HAS_INFLIGHT_PAYMENTS') resumo.put409 += 1
        else resumo.putOutro.push(r.status)
      }
      if (rPix.status === 201) resumo.pix201 += 1
      else {
        const k = `${rPix.status}:${rPix.body?.code}`
        resumo.pixOutro[k] = (resumo.pixOutro[k] ?? 0) + 1
      }
      if (rCartao.ok) resumo.cartaoCriado += 1
      else if (rCartao.status === 503) resumo.cartao503 += 1
      else resumo.cartaoOutro.push(`${rCartao.status}:${rCartao.code}`)

      // INVARIANTE central: nenhum intent VIVO com ambiente diferente do efetivo (o que o bloqueio M4c promete)
      m.invalidarCacheConfigGateway()
      const efetivo = await m.getAmbienteEfetivoParaBanco()
      const desalinhados = await m.prisma.paymentIntent.findMany({ where: { status: { in: [...VIVOS] }, NOT: { environment: efetivo } }, select: { id: true, environment: true, purpose: true } })
      expect(desalinhados, `rodada ${i}: efetivo=${efetivo} PUTs=${rA.status}/${rB.status} pix=${rPix.status}`).toEqual([])
      // coerência: se algum PUT deu 200 o efetivo é PRODUCTION; se os dois deram 409 continua SANDBOX
      if (rA.status === 200 || rB.status === 200) expect(efetivo, `rodada ${i}`).toBe('PRODUCTION')
      else expect(efetivo, `rodada ${i}`).toBe('SANDBOX')
    }
    const [{ depois }] = await m.prisma.$queryRaw<Array<{ depois: number }>>`SELECT deadlocks::int AS depois FROM pg_stat_database WHERE datname = current_database()`
    if (SAIDA) appendFileSync(SAIDA, `[M3] ${dump(resumo)} deadlocks=${depois - antes}\n`)
    expect(depois - antes, 'o Postgres não pode registrar deadlock').toBe(0)
    expect(resumo.putOutro, `PUT com status inesperado: ${dump(resumo)}`).toEqual([])
    expect(resumo.cartaoOutro, `cartão com desfecho inesperado: ${dump(resumo)}`).toEqual([])
    expect(resumo.maisLenta).toBeLessThan(15_000)
    // as duas ordens de chegada ocorreram? (sem isto o teste poderia estar sempre no mesmo desfecho) — registrado, não exigido: depende de temporização
  }, 240_000)

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  it('M4a — cartão com ambienteEsperado: o ambiente efetivo (lido sob o lock) é PRODUCTION mas o cartão foi escolhido em SANDBOX => 503 e NENHUM intent gravado; com o esperado certo, cria marcando o ambiente', async () => {
    await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'production', cardEnabled: true, pixEnabled: true } })
    m.invalidarCacheConfigGateway()
    const u = await novoUsuario('DRIVER')
    const metodo = await m.prisma.paymentMethod.create({ data: { userId: u.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret('tok-m4a'), brand: 'Visa', last4: '4242', environment: 'SANDBOX' } })
    const dados = { purpose: 'SESSION_CARD_CAPTURE' as const, provider: 'CIELO_CARD' as const, userId: u.id, paymentMethodId: metodo.id, walletId: null, amountRequestedCents: 500, status: 'CREATED' as const }
    await expect(m.criarIntent(dados, { ambienteEsperado: 'SANDBOX' })).rejects.toMatchObject({ statusCode: 503, code: 'PAYMENT_GATEWAY_UNAVAILABLE' })
    expect(await m.prisma.paymentIntent.count({ where: { userId: u.id } })).toBe(0)
    const ok = await m.criarIntent(dados, { ambienteEsperado: 'PRODUCTION' })
    expect(ok.environment).toBe('PRODUCTION')
    const semEsperado = await m.criarIntent(dados)
    expect(semEsperado.environment).toBe('PRODUCTION') // sem `ambienteEsperado` não recusa: só marca com o efetivo
  })

  it('M4b — cartão, corrida FORÇADA: o PUT sandbox->production está dentro da transação; o criador (ambienteEsperado SANDBOX) ESPERA, e quando a troca commita é RECUSADO (503), sem intent', async () => {
    await semeiaSandbox()
    m.invalidarCacheConfigGateway()
    const admin = await novoUsuario('ADMIN')
    const u = await novoUsuario('DRIVER')
    const metodo = await m.prisma.paymentMethod.create({ data: { userId: u.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret('tok-m4b'), brand: 'Visa', last4: '4242', environment: 'SANDBOX' } })
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('SANDBOX') // cache quente em SANDBOX: o que a rota leria antes de escolher o cartão
    const segurado = await segurarPut()
    const putEmVoo = putProducao(admin)
    await Promise.race([segurado.dentro, dormir(15_000).then(() => Promise.reject(new Error('o PUT nunca chegou ao portão')))])

    const criar = m.criarIntent({ purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: u.id, paymentMethodId: metodo.id, walletId: null, amountRequestedCents: 500, status: 'CREATED' }, { ambienteEsperado: 'SANDBOX' }).then(
      (x) => ({ ok: true as const, x }),
      (e: { statusCode?: number; code?: string }) => ({ ok: false as const, status: e.statusCode, code: e.code }),
    )
    await esperarAte(async () => tem(await locksDaConfig(), 'ShareLock', false), 'o criador do intent de cartão ficar esperando o lock')
    segurado.soltar()
    const [resPut, resCriar] = await Promise.all([putEmVoo, criar])
    expect(resPut.status, dump(resPut.body)).toBe(200)
    expect(resCriar, 'o cartão escolhido em SANDBOX não pode gerar intent depois da troca').toMatchObject({ ok: false, status: 503, code: 'PAYMENT_GATEWAY_UNAVAILABLE' })
    expect(await m.prisma.paymentIntent.count({ where: { userId: u.id } })).toBe(0)
  }, 60_000)

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  it('M5 — cartão CADASTRADO (PaymentMethod): se o admin troca o ambiente DURANTE a verificação do token na Cielo, o POST recusa (503) e NÃO grava cartão nenhum (nem no ambiente velho com a marca nova, nem o inverso)', async () => {
    await semeiaSandbox()
    m.invalidarCacheConfigGateway()
    const admin = await novoUsuario('ADMIN')
    const motorista = await novoUsuario('DRIVER')
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('SANDBOX')

    let entrou!: () => void
    const dentro = new Promise<void>((r) => (entrou = r))
    let liberar!: () => void
    const livre = new Promise<void>((r) => (liberar = r))
    const original = fake.consultarCartaoTokenizado.bind(fake)
    const espia = vi.spyOn(fake, 'consultarCartaoTokenizado').mockImplementation(async (tok: string) => {
      entrou()
      await livre
      return original(tok)
    })
    try {
      const postCartao = request(app).post('/api/me/payment-methods').set(auth(motorista)).send({ cardToken: 'tok-m5-4242', brand: 'Visa' }).then((r) => r)
      await Promise.race([dentro, dormir(15_000).then(() => Promise.reject(new Error('o POST do cartão nunca chegou à consulta do token')))])
      const troca = await putProducao(admin) // nenhum intent vivo: a troca é permitida
      expect(troca.status, dump(troca.body)).toBe(200)
      liberar()
      const res = await postCartao
      expect(res.status, dump(res.body)).toBe(503)
      expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
      expect(await m.prisma.paymentMethod.count({ where: { userId: motorista.id } })).toBe(0)
    } finally {
      liberar()
      espia.mockRestore()
    }
  }, 60_000)

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  it('M6 — custo do lock (medição, pool de 4): com o PUT segurando o lock exclusivo, 12 Pix ficam presos COM conexão do pool; o pedido sem relação (leitura do admin) fica atrás na fila do pool, mas TUDO termina depois da soltura e nada vira 500', async () => {
    await semeiaSandbox()
    m.invalidarCacheConfigGateway()
    const admin = await novoUsuario('ADMIN')
    const motoristas = await Promise.all(Array.from({ length: 12 }, () => novoUsuario('DRIVER')))
    const bystander = await novoUsuario('ADMIN')
    const segurado = await segurarPut()
    const putEmVoo = putProducao(admin)
    await Promise.race([segurado.dentro, dormir(15_000).then(() => Promise.reject(new Error('o PUT nunca chegou ao portão')))])
    const pixes = motoristas.map((u) => pix(u))
    await esperarAte(async () => tem(await locksDaConfig(), 'ShareLock', false), 'criadores de intent presos no lock')
    const t0 = Date.now()
    let bystanderTerminou = false
    const leituraEmVoo = request(app).get('/api/admin/payment-gateway').set(auth(bystander)).then((r) => {
      bystanderTerminou = true
      return { status: r.status, ms: Date.now() - t0 }
    })
    await dormir(1000) // segura a troca por ~1 s COM o pool tomado (abaixo do maxWait de 2 s da transação, para não confundir com timeout)
    const bystanderPresoDuranteALock = !bystanderTerminou
    segurado.soltar()
    const [resPut, leitura, ...resPix] = await Promise.all([putEmVoo, leituraEmVoo, ...pixes])
    const status = resPix.map((r) => r.status)
    if (SAIDA) appendFileSync(SAIDA, `[M6] pool=4; bystander ${leitura.status} terminou em ${leitura.ms} ms (preso durante o lock: ${bystanderPresoDuranteALock}); put=${resPut.status}; pix=${dump(Object.fromEntries([...new Set(status)].map((x) => [x, status.filter((y) => y === x).length])))}\n`)
    expect(resPut.status, dump(resPut.body)).toBe(200)
    expect(status.filter((x) => x === 500), `status dos Pix: ${status.join(',')}`).toEqual([])
    expect(leitura.status).toBe(200)
    expect(leitura.ms, 'o pedido sem relação com o lock só pode esperar a troca, não ficar preso para sempre').toBeLessThan(9_000)
  }, 120_000)

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------
  it('M7 — config ILEGÍVEL lida sob o lock (linha com ambiente inválido commitada depois de o cache aquecer): o Pix recusa com 503 PAYMENT_GATEWAY_UNAVAILABLE (fail-closed), sem intent e sem 500', async () => {
    await semeiaSandbox()
    m.invalidarCacheConfigGateway()
    const motorista = await novoUsuario('DRIVER')
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('SANDBOX') // cache quente: a guarda de começos novos passa
    await m.prisma.$executeRaw`UPDATE "PaymentGatewayConfig" SET "environment" = 'banana' WHERE "id" = 1`
    const res = await pix(motorista)
    expect(res.status, dump(res.body)).toBe(503)
    expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
    expect(await m.prisma.paymentIntent.count({ where: { userId: motorista.id } })).toBe(0)
  }, 60_000)
})
