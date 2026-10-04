import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Queue, Worker } from 'bullmq'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis, createRedisConnection } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { CapturaCartaoEmAndamentoError, CapturaCartaoNaoDefinitivaError, capturarSessaoCartao, enqueueCapturarSessaoCartao } from '../../src/services/pagamentos/capturarSessaoCartao'
import { cancelarPreAutorizacaoCartao } from '../../src/services/pagamentos/cancelarPreAutorizacaoCartao'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { reenfileirarCapturasPendentes } from '../../src/services/pagamentos/reenfileirarCapturasPendentes'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { startCapturarSessaoCartaoWorker } from '../../src/worker/jobs/capturarSessaoCartaoJob'
import { uniqueSuffix, waitFor } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp } from './helpers/cenarioCartaoHttp'

/**
 * Íris (C2, 04/10/2026) — RETRIES SEM IDEMPOTÊNCIA, CAPTURA e CANCELAMENTO (`PUT /capture` e `PUT /void` repetidos).
 * Adaptador REAL + "Cielo" por TCP com estado (`efeitos` = o que a Cielo EFETIVOU) + Postgres/Redis reais + BullMQ real.
 * Banco próprio (o varredor olha o banco inteiro; no compartilhado ele mexeria em intents de outras suítes).
 */

const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_real_c')
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('captura/cancelamento de cartão — nunca um 2º PUT sem consulta antes, nunca duas cobranças (adaptador real + Cielo falsa por TCP)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }
  const filasParaFechar: Queue[] = []
  const workersParaFechar: Worker[] = []

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    cen = await criarCenarioCartaoHttp(app, suffix, 'cap-real')
  })
  afterAll(async () => {
    await cielo.parar()
    await cen.fechar()
    Object.assign(env, baseline)
    if (processEnvBaseline.api === undefined) delete process.env.CIELO_API_BASE_URL
    else process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    if (processEnvBaseline.query === undefined) delete process.env.CIELO_API_QUERY_BASE_URL
    else process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  })
  beforeEach(() => cielo.zerarRegistro())
  afterEach(async () => {
    for (const w of workersParaFechar.splice(0)) await w.close(true).catch(() => {})
    for (const q of filasParaFechar.splice(0)) {
      await q.obliterate({ force: true }).catch(() => {})
      await q.close().catch(() => {})
    }
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
  })

  const intentDe = (id: string) => prisma.paymentIntent.findUniqueOrThrow({ where: { id } })

  describe('captura — PUT /capture', () => {
    it('CONTROLE: caminho feliz — consulta, 1 PUT, intent CAPTURED com valor certo e os identificadores da autorização preservados (a resposta de captura NÃO os repete e não pode apagá-los)', async () => {
      const { intentId, cieloPaymentId } = await cen.sessaoParada('feliz')
      const antes = await intentDe(intentId)
      expect(antes).toMatchObject({ cieloTid: expect.any(String), cieloAuthorizationCode: expect.any(String), cieloProofOfSale: expect.any(String) })

      const r = await capturarSessaoCartao(intentId)
      expect(r).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 300 })
      expect(cielo.sequencia({ paymentId: cieloPaymentId })).toEqual(['GET_BY_ID', 'PUT_CAPTURE'])
      const depois = await intentDe(intentId)
      expect(depois).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 300, cieloTid: antes.cieloTid, cieloAuthorizationCode: antes.cieloAuthorizationCode, cieloProofOfSale: antes.cieloProofOfSale })
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    })

    it('a Cielo CAPTURA e nunca responde (timeout): o adaptador reconsulta por PaymentId, vê CAPTURED, e NÃO repete o PUT — 1 PUT, 2 GET, 1 captura efetiva', async () => {
      const { intentId, cieloPaymentId } = await cen.sessaoParada('timeout')
      cielo.agendar('PUT_CAPTURE', { processar: true, resposta: 'travar' })
      const r = await capturarSessaoCartao(intentId)
      expect(r).toMatchObject({ status: 'CAPTURED' })
      expect(cielo.sequencia({ paymentId: cieloPaymentId })).toEqual(['GET_BY_ID', 'PUT_CAPTURE', 'GET_BY_ID'])
      expect(cielo.efeitos.capturas.get(cieloPaymentId)).toBe(1)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
      expect(await prisma.debt.count({ where: { paymentIntentId: intentId } })).toBe(0)
    })

    it('a Cielo CAPTURA e a CONEXÃO CAI (ECONNRESET): a 1ª tentativa falha SEM decidir nada; a reentrega do job consulta, vê CAPTURED e só espelha — 1 PUT no total', async () => {
      const { intentId, cieloPaymentId } = await cen.sessaoParada('queda')
      cielo.agendar('PUT_CAPTURE', { processar: true, resposta: 'derrubar' })
      await expect(capturarSessaoCartao(intentId)).rejects.toThrow()
      expect((await intentDe(intentId)).status).toBe('CAPTURE_PENDING')
      expect(await prisma.debt.count({ where: { paymentIntentId: intentId } })).toBe(0) // falha de rede NUNCA vira dívida

      expect(await capturarSessaoCartao(intentId)).toMatchObject({ status: 'CAPTURED' })
      expect(cielo.contar('PUT_CAPTURE', { paymentId: cieloPaymentId })).toBe(1)
      expect(cielo.efeitos.capturas.get(cieloPaymentId)).toBe(1)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    })

    it('a Cielo responde 503 sem capturar: a reentrega CONSULTA de novo (ainda AUTHORIZED) e SÓ ENTÃO repete o PUT — 2 PUT, cada um precedido de GET, 1 captura efetiva', async () => {
      const { intentId, cieloPaymentId } = await cen.sessaoParada('503')
      cielo.agendar('PUT_CAPTURE', { processar: false, resposta: { http: 503, bruto: 'Service Unavailable' } })
      await expect(capturarSessaoCartao(intentId)).rejects.toThrow()
      expect(await capturarSessaoCartao(intentId)).toMatchObject({ status: 'CAPTURED' })
      expect(cielo.sequencia({ paymentId: cieloPaymentId })).toEqual(['GET_BY_ID', 'PUT_CAPTURE', 'GET_BY_ID', 'PUT_CAPTURE'])
      expect(cielo.efeitos.capturas.get(cieloPaymentId)).toBe(1)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    })

    it('resposta de captura SEM ReturnCode (Status 2 puro): não é CAPTURED nem FAILED — lança "não definitivo", nada gravado, sem dívida; a próxima volta reconsulta (venda já capturada lá) e só espelha, sem 2º PUT', async () => {
      const { intentId, cieloPaymentId } = await cen.sessaoParada('sem-rc')
      cielo.agendar('PUT_CAPTURE', { processar: true, corpoRespostaCru: { Status: 2, ReasonCode: 0, ReasonMessage: 'Successful' } })
      await expect(capturarSessaoCartao(intentId)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
      expect(await intentDe(intentId)).toMatchObject({ status: 'CAPTURE_PENDING' })
      expect(await prisma.debt.count({ where: { paymentIntentId: intentId } })).toBe(0)
      expect(await capturarSessaoCartao(intentId)).toMatchObject({ status: 'CAPTURED' })
      expect(cielo.contar('PUT_CAPTURE', { paymentId: cieloPaymentId })).toBe(1)
    })

    it('CARACTERIZAÇÃO — venda capturada que a Cielo devolve como Status 2 + ReturnCode "0" (fora de {00,4,6}): o intent NÃO fecha (fica CAPTURE_PENDING, sem dívida) e o PUT NUNCA é repetido em 5 voltas — seguro, mas só o alerta humano resolve', async () => {
      const { intentId, cieloPaymentId } = await cen.sessaoParada('rc0')
      cielo.agendar('PUT_CAPTURE', { processar: true, venda: { returnCode: '0' }, corpoRespostaCru: { Status: 2, ReturnCode: '0' } })
      for (let i = 0; i < 5; i++) await expect(capturarSessaoCartao(intentId)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
      expect(cielo.contar('PUT_CAPTURE', { paymentId: cieloPaymentId })).toBe(1) // nunca martela a captura
      expect(await intentDe(intentId)).toMatchObject({ status: 'CAPTURE_PENDING' })
      expect(await prisma.debt.count({ where: { paymentIntentId: intentId } })).toBe(0)
    })

    it('a captura devolve identificador NOVO e longo: o valor novo substitui, > 64 vira 64 (com alerta) e a captura NÃO cai; identificador vazio/null NÃO apaga o que a autorização gravou', async () => {
      const { intentId } = await cen.sessaoParada('ids')
      const antes = await intentDe(intentId)
      cielo.agendar('PUT_CAPTURE', { processar: true, corpoRespostaCru: { Status: 2, ReturnCode: '6', Tid: 'N'.repeat(100), AuthorizationCode: '', ProofOfSale: null } })
      const aviso = vi.spyOn(logger, 'warn')
      const r = await capturarSessaoCartao(intentId)
      expect(r).toMatchObject({ status: 'CAPTURED' })
      const depois = await intentDe(intentId)
      expect(depois.cieloTid).toBe('N'.repeat(64))
      expect(depois.cieloAuthorizationCode).toBe(antes.cieloAuthorizationCode) // vazio não apaga
      expect(depois.cieloProofOfSale).toBe(antes.cieloProofOfSale) // null não apaga
      expect(aviso.mock.calls.some((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_cielo_identifier_truncated')).toBe(true)
      aviso.mockRestore()
    })

    it('DOIS executores do mesmo intent ao mesmo tempo (PUT lento): 1 PUT, 1 captura efetiva; o perdedor lança "em andamento" e NÃO chama a Cielo', async () => {
      apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 3000 })
      const { intentId, cieloPaymentId } = await cen.sessaoParada('dois')
      cielo.agendar('PUT_CAPTURE', { atrasoMs: 500 })
      const resultados = await Promise.allSettled([capturarSessaoCartao(intentId), capturarSessaoCartao(intentId)])
      expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejeitado = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(rejeitado.reason).toBeInstanceOf(CapturaCartaoEmAndamentoError)
      expect(cielo.contar('PUT_CAPTURE', { paymentId: cieloPaymentId })).toBe(1)
      expect(cielo.efeitos.capturas.get(cieloPaymentId)).toBe(1)
    })

    it('JOB STALLED/REENTREGUE de verdade (BullMQ): o worker A perde o lock enquanto o PUT ainda está na rede, o BullMQ reentrega ao worker B — B NÃO captura de novo (lock por intent), tenta depois e só espelha: 1 PUT, 1 captura efetiva, intent CAPTURED', async () => {
      apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 4000 })
      const { intentId, cieloPaymentId } = await cen.sessaoParada('stalled')
      cielo.agendar('PUT_CAPTURE', { atrasoMs: 1800 })
      const nomeFila = `iris-cap-stalled-${suffix}`
      const fila = new Queue(nomeFila, { connection: createRedisConnection() })
      filasParaFechar.push(fila)

      // Worker A = "zumbi": não renova o lock (lockDuration curto), então o job vira "stalled" ENQUANTO capturarSessaoCartao ainda espera a Cielo.
      const workerA = new Worker(nomeFila, async (job) => void (await capturarSessaoCartao(job.data.paymentIntentId)), { connection: createRedisConnection(), lockDuration: 600, stalledInterval: 300, maxStalledCount: 5, skipLockRenewal: true, concurrency: 1 })
      workerA.on('error', () => {})
      workerA.on('failed', () => {})
      workersParaFechar.push(workerA)
      await enqueueCapturarSessaoCartao(intentId, fila, { attempts: 8, backoffMs: 400 })
      await waitFor(async () => cielo.contar('PUT_CAPTURE', { paymentId: cieloPaymentId }) >= 1, { timeoutMs: 8000, what: 'o worker A chegar ao PUT' })

      // Worker B = o real do projeto, sobe depois e herda o job reentregue.
      const workerB = startCapturarSessaoCartaoWorker({ queueName: nomeFila })
      workerB.on('error', () => {})
      workersParaFechar.push(workerB)

      await waitFor(async () => (await intentDe(intentId)).status === 'CAPTURED', { timeoutMs: 20_000, intervalMs: 200, what: 'intent CAPTURED' })
      await sleep(800) // tempo para QUALQUER 2º PUT aparecer, se existisse
      expect(cielo.contar('PUT_CAPTURE', { paymentId: cieloPaymentId })).toBe(1)
      expect(cielo.efeitos.capturas.get(cieloPaymentId)).toBe(1)
      expect(await prisma.debt.count({ where: { paymentIntentId: intentId } })).toBe(0)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    }, 60_000)

    it('o MESMO job reenfileirado depois de concluído (reentrega tardia) não toca a Cielo: zero chamadas novas', async () => {
      const { intentId } = await cen.sessaoParada('reentrega-tardia')
      await capturarSessaoCartao(intentId)
      const chamadasAntes = cielo.chamadas.length
      expect(await capturarSessaoCartao(intentId)).toBeNull()
      expect(cielo.chamadas.length).toBe(chamadasAntes)
    })

    it('dois varredores (reenfileirarCapturasPendentes) ao mesmo tempo + worker real: um único job por intent, 1 PUT, 1 captura efetiva', async () => {
      const { intentId, cieloPaymentId } = await cen.sessaoParada('varredores')
      await prisma.paymentIntent.update({ where: { id: intentId }, data: { updatedAt: new Date(Date.now() - 6 * 3600_000) } })
      const nomeFila = `iris-cap-varredores-${suffix}`
      const fila = new Queue(nomeFila, { connection: createRedisConnection() })
      filasParaFechar.push(fila)
      const [a, b] = await Promise.all([reenfileirarCapturasPendentes({ queue: fila }), reenfileirarCapturasPendentes({ queue: fila })])
      expect(a.reenfileiradas + b.reenfileiradas).toBeGreaterThanOrEqual(1)
      expect(await fila.getJobCounts('waiting', 'active', 'delayed')).toMatchObject({}) // fila existe
      const workerB = startCapturarSessaoCartaoWorker({ queueName: nomeFila })
      workerB.on('error', () => {})
      workersParaFechar.push(workerB)
      await waitFor(async () => (await intentDe(intentId)).status === 'CAPTURED', { timeoutMs: 15_000, intervalMs: 200, what: 'intent CAPTURED' })
      await sleep(500)
      expect(cielo.contar('PUT_CAPTURE', { paymentId: cieloPaymentId })).toBe(1)
      expect(cielo.efeitos.capturas.get(cieloPaymentId)).toBe(1)
    }, 40_000)
  })

  describe('cancelamento — cancelarPreAutorizacaoCartao (PUT /void)', () => {
    it('CONFIRMADO (Status 10 + ReturnCode 0): consulta antes, 1 PUT, intent VOIDED e idTag virtual EXPIRED', async () => {
      const { intentId, cieloPaymentId } = await cen.autorizadaAbandonada('x-conf')
      const antes = await intentDe(intentId)
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(true)
      expect(cielo.sequencia({ paymentId: cieloPaymentId })).toEqual(['GET_BY_ID', 'PUT_VOID'])
      expect(await intentDe(intentId)).toMatchObject({ status: 'VOIDED', returnCode: '0' })
      expect(await prisma.authToken.findUniqueOrThrow({ where: { id: antes.authTokenId! } })).toMatchObject({ status: 'EXPIRED' })
    })

    it('a Cielo JÁ cancelou (o void anterior pegou e a resposta/commit se perdeu): só espelha VOIDED e expira o idTag — NENHUM novo PUT', async () => {
      const { intentId, cieloPaymentId } = await cen.autorizadaAbandonada('x-ja')
      const v = cielo.vendas.get(cieloPaymentId)!
      v.status = 10
      v.returnCode = '0'
      const antes = await intentDe(intentId)
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(true)
      expect(cielo.contar('PUT_VOID')).toBe(0)
      expect((await intentDe(intentId)).status).toBe('VOIDED')
      expect((await prisma.authToken.findUniqueOrThrow({ where: { id: antes.authTokenId! } })).status).toBe('EXPIRED')
    })

    it('a Cielo diz CAPTURED: NUNCA cancela (seria estornar dinheiro cobrado) — zero PUT, intent e idTag intactos, alerta payment_void_skipped_already_captured', async () => {
      const { intentId, cieloPaymentId } = await cen.autorizadaAbandonada('x-cap')
      const v = cielo.vendas.get(cieloPaymentId)!
      v.status = 2
      v.returnCode = '6'
      const erro = vi.spyOn(logger, 'error')
      const antes = await intentDe(intentId)
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false)
      expect(cielo.contar('PUT_VOID')).toBe(0)
      expect((await intentDe(intentId)).status).toBe('AUTHORIZED')
      expect((await prisma.authToken.findUniqueOrThrow({ where: { id: antes.authTokenId! } })).status).toBe('ACCEPTED')
      expect(erro.mock.calls.some((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_void_skipped_already_captured')).toBe(true)
      erro.mockRestore()
    })

    it('a CONSULTA antes de cancelar falha (503): NENHUM PUT é enviado, nada muda; quando a consulta volta, cancela', async () => {
      const { intentId, cieloPaymentId } = await cen.autorizadaAbandonada('x-consulta')
      cielo.agendar('GET_BY_ID', { resposta: { http: 503, bruto: 'down' } })
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false)
      expect(cielo.contar('PUT_VOID')).toBe(0)
      expect((await intentDe(intentId)).status).toBe('AUTHORIZED')
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(true)
      expect(cielo.contar('PUT_VOID', { paymentId: cieloPaymentId })).toBe(1)
    })

    it('timeout NO void (Cielo cancelou e não respondeu): intent segue AUTHORIZED sem decidir nada; a próxima volta CONSULTA, vê VOIDED e só espelha — 1 PUT no total', async () => {
      const { intentId, cieloPaymentId } = await cen.autorizadaAbandonada('x-timeout')
      cielo.agendar('PUT_VOID', { processar: true, resposta: 'travar' })
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false)
      expect((await intentDe(intentId)).status).toBe('AUTHORIZED')
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(true)
      expect(cielo.contar('PUT_VOID', { paymentId: cieloPaymentId })).toBe(1)
      expect(cielo.efeitos.cancelamentos.get(cieloPaymentId)).toBe(1)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    })

    it.each([
      ['EM_ANDAMENTO (ReturnCode 476)', { processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '476' } }, 'payment_void_in_progress'],
      ['RECUSADO em definitivo (ReturnCode 40)', { processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '40' } }, 'payment_void_refused'],
      ['INDEFINIDO (ReturnCode 77, Status 1)', { processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '77' } }, 'payment_void_unconfirmed'],
    ] as const)('void %s: o intent NÃO vira VOIDED, o idTag NÃO expira e o alerta certo sai', async (_nome, diretiva, alerta) => {
      const { intentId } = await cen.autorizadaAbandonada(`x-${alerta}`)
      const antes = await intentDe(intentId)
      cielo.agendar('PUT_VOID', diretiva)
      const aviso = vi.spyOn(logger, 'warn')
      const erro = vi.spyOn(logger, 'error')
      try {
        expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false)
        const alertas = [...aviso.mock.calls, ...erro.mock.calls].map((c) => (c[0] as { alert?: string } | undefined)?.alert)
        expect(alertas).toContain(alerta)
      } finally {
        aviso.mockRestore()
        erro.mockRestore()
      }
      expect((await intentDe(intentId)).status).toBe('AUTHORIZED')
      expect((await prisma.authToken.findUniqueOrThrow({ where: { id: antes.authTokenId! } })).status).toBe('ACCEPTED')
    })

    it('INDEFINIDO que na verdade cancelou (Status 10 sem ReturnCode na resposta do void): a 1ª volta não dá por feito, a 2ª CONSULTA, vê VOIDED e espelha — auto-cura com 1 PUT só', async () => {
      const { intentId, cieloPaymentId } = await cen.autorizadaAbandonada('x-indef-cura')
      cielo.agendar('PUT_VOID', { processar: true, corpoRespostaCru: { Status: 10, ReasonCode: 0 } })
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false)
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(true)
      expect(cielo.contar('PUT_VOID', { paymentId: cieloPaymentId })).toBe(1)
    })

    it('intent que NÃO está AUTHORIZED (já VOIDED localmente): zero chamadas à Cielo', async () => {
      const { intentId } = await cen.autorizadaAbandonada('x-nao-auth')
      await prisma.paymentIntent.update({ where: { id: intentId }, data: { status: 'VOIDED' } })
      const antes = cielo.chamadas.length
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false)
      expect(cielo.chamadas.length).toBe(antes)
    })
  })

  describe('varredor (pré-autorizações abandonadas) — repetição e concorrência', () => {
    async function abandonadas(n: number, rotulo: string) {
      const itens: Array<{ intentId: string; cieloPaymentId: string }> = []
      for (let i = 0; i < n; i++) {
        const x = await cen.autorizadaAbandonada(`${rotulo}-${i}`)
        await cen.envelhecer(x.intentId, 30)
        itens.push(x)
      }
      return itens
    }
    const atrasos = (n: number) => Array.from({ length: n }, () => ({ atrasoMs: 120 }))

    it('DOIS varredores ao mesmo tempo sobre as mesmas pré-autorizações abandonadas: todas terminam VOIDED e a Cielo EFETIVA 1 cancelamento por venda (o 2º PUT é recusado por ela — o dinheiro está salvo)', async () => {
      const itens = await abandonadas(5, 'v2w')
      cielo.agendar('GET_BY_ID', ...atrasos(40))
      cielo.agendar('PUT_VOID', ...atrasos(40))
      await Promise.all([varrerPreAutorizacoesCartao(), varrerPreAutorizacoesCartao()])
      for (const { intentId, cieloPaymentId } of itens) {
        expect((await intentDe(intentId)).status).toBe('VOIDED')
        expect(cielo.efeitos.cancelamentos.get(cieloPaymentId)).toBe(1)
      }
    })

    /**
     * ACHADO (Íris): o cancelamento NÃO tem lock por intent (a captura tem). Dois varredores (2 workers) leem AUTHORIZED, consultam (ambos veem AUTHORIZED) e os DOIS
     * enviam PUT /void. A Cielo recusa o 2º (venda já cancelada, 400), então o dinheiro está salvo — mas o 2º vira um erro "falha ao cancelar" no log e, para um
     * estorno de venda já capturada ou um void parcial, repetir é exatamente o que a política "consulta antes" existe para evitar. Desejado: no máximo 1 PUT /void
     * por pré-autorização. Vira `it` quando `cancelarPreAutorizacaoCartao` serializar por intent (lock Redis como a captura).
     */
    it.fails('(achado) com dois varredores simultâneos o 2º PUT /void sai SEM consulta no meio (regra: nunca 2ª escrita sem consultar antes) — deveria ser no máximo 1 PUT por pré-autorização', async () => {
      const itens = await abandonadas(5, 'v2wb')
      cielo.agendar('GET_BY_ID', ...atrasos(40))
      cielo.agendar('PUT_VOID', ...atrasos(40))
      await Promise.all([varrerPreAutorizacoesCartao(), varrerPreAutorizacoesCartao()])
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
      for (const { cieloPaymentId } of itens) expect(cielo.contar('PUT_VOID', { paymentId: cieloPaymentId })).toBe(1)
    })

    it('DOIS varredores sobre intents CREATED (Cielo autorizou, resposta perdida): cada venda é cancelada uma vez e NENHUM 2º POST sai — a gravação condicional (CREATED -> AUTHORIZED) tem um único vencedor', async () => {
      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        const m = await cen.novoMotorista(`crd-${i}`)
        const c = await cen.novoConector()
        cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
        const res = await cen.iniciar(m, c)
        expect(res.status).toBe(503)
        const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: m.user.id }, orderBy: { createdAt: 'desc' } })
        await cen.envelhecer(intent.id, 30)
        ids.push(intent.id)
      }
      cielo.agendar('GET_BY_ORDER', ...atrasos(20))
      const [r1, r2] = await Promise.all([varrerPreAutorizacoesCartao(), varrerPreAutorizacoesCartao()])
      // cada intent é CONTADO uma única vez (a gravação condicional CREATED -> AUTHORIZED tem um só vencedor); sem ela os dois varredores 'ganham' e ressuscitam o intent
      expect(r1.resolvidasCreated + r2.resolvidasCreated).toBe(ids.length)
      for (const id of ids) {
        const venda = cielo.vendaPorPedido(id)!
        expect(venda.status).toBe(10)
        expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
        expect(cielo.efeitos.vendasCriadas.get(id)).toBe(1)
        expect(cielo.contar('POST_SALE', { merchantOrderId: id })).toBe(1)
      }
    })

    /**
     * ACHADO (Íris): quando a Cielo RECUSA o cancelamento em definitivo (ReturnCode 40/41/53/101/103-107) o log diz "não vou repetir às cegas", mas o intent
     * continua AUTHORIZED e o caso A do varredor o pega DE NOVO a cada rodada (60 s): consulta, PUT /void, recusa, alerta de ERRO — para sempre. Idem para
     * "em andamento" (10/223/476), que o próprio doc de desenho (F19) manda NÃO retentar. Não é dinheiro em risco (sempre há consulta antes e a Cielo recusa de novo),
     * mas é um loop de PUTs e de alertas de erro por intent, sem teto nem backoff. Desejado: depois de uma recusa definitiva, parar de enviar PUT (alertar 1x e
     * deixar para conciliação manual). Vira `it` quando o desfecho RECUSADO/EM_ANDAMENTO deixar de ser reenviado.
     */
    it.fails('(achado) recusa DEFINITIVA do cancelamento (ReturnCode 40): em 4 rodadas do varredor o PUT /void deveria sair no máximo 1 vez', async () => {
      const [x] = await abandonadas(1, 'rec-def')
      cielo.agendar('PUT_VOID', ...Array.from({ length: 4 }, () => ({ processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '40' } })))
      for (let i = 0; i < 4; i++) await varrerPreAutorizacoesCartao()
      expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBeLessThanOrEqual(1)
    })

    it.fails('(achado) cancelamento "EM ANDAMENTO" (ReturnCode 476): em 4 rodadas do varredor o PUT /void deveria sair no máximo 1 vez (a doc de desenho manda não retentar)', async () => {
      const [x] = await abandonadas(1, 'rec-and')
      cielo.agendar('PUT_VOID', ...Array.from({ length: 4 }, () => ({ processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '476' } })))
      for (let i = 0; i < 4; i++) await varrerPreAutorizacoesCartao()
      expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBeLessThanOrEqual(1)
    })

    it('MEDIÇÃO do loop acima: 4 rodadas com recusa definitiva => 4 PUTs (cada um precedido de GET) e o intent segue AUTHORIZED com o idTag ainda ACCEPTED', async () => {
      const [x] = await abandonadas(1, 'rec-med')
      cielo.agendar('PUT_VOID', ...Array.from({ length: 4 }, () => ({ processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '40' } })))
      for (let i = 0; i < 4; i++) await varrerPreAutorizacoesCartao()
      expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(4)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
      expect((await intentDe(x.intentId)).status).toBe('AUTHORIZED')
    })
  })
})
