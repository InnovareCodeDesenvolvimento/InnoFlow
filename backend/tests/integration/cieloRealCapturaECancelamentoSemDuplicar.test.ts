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
import { chaveLockCancelamento, pararCancelamento } from '../../src/services/pagamentos/controleCancelamentoPreAuth'
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

// MUDANÇA DELIBERADA (rodada 3): a conta Cielo é COMPARTILHADA com o Parque das Feiras e o pedido vai à Cielo como `IF-<id do intent>` (I-7, 89f36dd). A Cielo falsa guarda e casa o
// `MerchantOrderId` EXATAMENTE como recebeu (como a real), então toda leitura do "mundo da Cielo" por pedido passa por `mo()`.
const mo = (intentId: string) => `IF-${intentId}`

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

    it('I-2 (rodada 2) — na CAPTURA a consulta devolve Status 1 SEM ReturnCode (ou com código fora das tabelas): NÃO vira FAILED nem dívida e NÃO tenta capturar às cegas; fica CAPTURE_PENDING com alerta; recusa CONHECIDA (51) continua FAILED + dívida', async () => {
      const a = await cen.sessaoParada('cap-status1-sem-rc')
      const venda = cielo.vendas.get(a.cieloPaymentId)!
      venda.returnCode = null // Status 1 e nenhum código
      const erro = vi.spyOn(logger, 'error')
      try {
        for (let i = 0; i < 3; i++) await expect(capturarSessaoCartao(a.intentId)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
        const alertasEmitidos = erro.mock.calls.map((c) => (c[0] as { alert?: string; paymentId?: string } | undefined)).filter((o) => o?.alert === 'payment_authorized_status_unlisted_returncode')
        expect(alertasEmitidos.length).toBeGreaterThanOrEqual(1)
        expect(alertasEmitidos[0]!.paymentId).toBe(a.cieloPaymentId)
      } finally {
        erro.mockRestore()
      }
      expect(await intentDe(a.intentId)).toMatchObject({ status: 'CAPTURE_PENDING' })
      expect(await prisma.debt.count({ where: { paymentIntentId: a.intentId } })).toBe(0)
      expect(cielo.contar('PUT_CAPTURE', { paymentId: a.cieloPaymentId })).toBe(0)

      // a Cielo "se completa" (ReturnCode 4): a volta seguinte captura normalmente
      venda.returnCode = '4'
      expect(await capturarSessaoCartao(a.intentId)).toMatchObject({ status: 'CAPTURED' })

      // controle: Status 1 + ReturnCode de recusa CONHECIDA (51) na captura é definitivo (FAILED + dívida integral) — o comportamento anterior, intacto
      const b = await cen.sessaoParada('cap-status1-51')
      const vb = cielo.vendas.get(b.cieloPaymentId)!
      vb.returnCode = '51'
      expect(await capturarSessaoCartao(b.intentId)).toMatchObject({ status: 'FAILED' })
      expect(await prisma.debt.count({ where: { paymentIntentId: b.intentId } })).toBe(1)
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

    // MUDANÇA DELIBERADA (rodada 2, I-3): havia a asserção "a 2ª volta imediata consulta e espelha". Agora o INDEFINIDO entra em BACKOFF (60 s x 2^n) e a volta IMEDIATA não chama a Cielo;
    // passado o backoff (simulado apagando a chave de pausa) a consulta vê VOIDED e espelha — auto-cura continua, com 1 PUT só.
    it('INDEFINIDO que na verdade cancelou (Status 10 sem ReturnCode no void): a 1ª volta não dá por feito e entra em backoff; a volta imediata NÃO chama a Cielo; passado o backoff CONSULTA, vê VOIDED e espelha — 1 PUT só', async () => {
      const { intentId, cieloPaymentId } = await cen.autorizadaAbandonada('x-indef-cura')
      cielo.agendar('PUT_VOID', { processar: true, corpoRespostaCru: { Status: 10, ReasonCode: 0 } })
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false)
      const chamadasAntes = cielo.chamadas.length
      expect(await cancelarPreAutorizacaoCartao(intentId)).toBe(false) // backoff em curso
      expect(cielo.chamadas.length).toBe(chamadasAntes)
      expect(await redis.ttl(`card-void:next:${intentId}`)).toBeGreaterThan(50)
      await redis.del(`card-void:next:${intentId}`) // "passou o backoff"
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

    // MUDANÇA DELIBERADA (rodada 2, I-3): `it.fails` -> `it`, asserção INTACTA (era "no máximo 1 PUT /void por pré-autorização com dois varredores, nunca 2ª escrita sem consulta").
    // O cancelamento ganhou LOCK por intent (Redis) como a captura.
    it('(I-3, CORRIGIDO) com dois varredores simultâneos NUNCA há 2º PUT /void sem consulta no meio — no máximo 1 PUT por pré-autorização', async () => {
      const itens = await abandonadas(5, 'v2wb')
      cielo.agendar('GET_BY_ID', ...atrasos(40))
      cielo.agendar('PUT_VOID', ...atrasos(40))
      await Promise.all([varrerPreAutorizacoesCartao(), varrerPreAutorizacoesCartao()])
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
      for (const { intentId, cieloPaymentId } of itens) {
        expect(cielo.contar('PUT_VOID', { paymentId: cieloPaymentId })).toBe(1)
        expect(cielo.efeitos.cancelamentos.get(cieloPaymentId)).toBe(1)
        expect((await intentDe(intentId)).status).toBe('VOIDED')
      }
    })

    it('TRÊS executores ao mesmo tempo no MESMO intent (varredor, varredor e chamada direta do finalizarSessao): 1 PUT; o lock perdido NÃO chama a Cielo nem alerta', async () => {
      const [x] = await abandonadas(1, 'lock3')
      cielo.agendar('GET_BY_ID', ...atrasos(10))
      cielo.agendar('PUT_VOID', ...atrasos(10))
      const resultados = await Promise.all([cancelarPreAutorizacaoCartao(x.intentId), cancelarPreAutorizacaoCartao(x.intentId), cancelarPreAutorizacaoCartao(x.intentId)])
      expect(resultados.filter(Boolean)).toHaveLength(1)
      expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(1)
      expect(cielo.contar('GET_BY_ID', { paymentId: x.cieloPaymentId })).toBe(1) // quem perdeu o lock nem consulta
    })

    it('lock do cancelamento tomado por OUTRO executor: NÃO cancela e não chama a Cielo (o mesmo caminho da falha fechada com Redis fora, que NÃO foi provada com Redis derrubado de verdade)', async () => {
      const [x] = await abandonadas(1, 'redis-fora')
      await redis.set(chaveLockCancelamento(x.intentId), 'outro-executor', 'EX', 60) // lock já tomado por outro
      const antes = cielo.chamadas.length
      expect(await cancelarPreAutorizacaoCartao(x.intentId)).toBe(false)
      expect(cielo.chamadas.length).toBe(antes)
      await redis.del(chaveLockCancelamento(x.intentId))
      expect(await cancelarPreAutorizacaoCartao(x.intentId)).toBe(true)
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
        const venda = cielo.vendaPorPedido(mo(id))!
        expect(venda.status).toBe(10)
        expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
        expect(cielo.efeitos.vendasCriadas.get(mo(id))).toBe(1)
        expect(cielo.contar('POST_SALE', { merchantOrderId: mo(id) })).toBe(1)
      }
    })

    // MUDANÇA DELIBERADA (rodada 2, I-3): os `it.fails` "recusa DEFINITIVA => no máximo 1 PUT" e "EM ANDAMENTO => no máximo 1 PUT" viraram `it` (asserção mantida) e a MEDIÇÃO do loop
    // (4 PUTs) passou a fixar o novo comportamento (1 PUT, 1 alerta de revisão manual, parada).
    describe.each([['40'], ['41'], ['53'], ['101'], ['103'], ['104'], ['105'], ['106'], ['107']])('recusa DEFINITIVA do cancelamento (ReturnCode %s)', (codigo) => {
      it('4 rodadas do varredor: 1 PUT /void (precedido de GET), `payment_void_manual_review` UMA vez (com o PaymentId), parada persistente, intent segue AUTHORIZED com o idTag ACCEPTED', async () => {
        const [x] = await abandonadas(1, `rec-def-${codigo}`)
        const erro = vi.spyOn(logger, 'error')
        try {
          cielo.agendar('PUT_VOID', ...Array.from({ length: 4 }, () => ({ processar: false, corpoRespostaCru: { Status: 1, ReturnCode: codigo } })))
          for (let i = 0; i < 4; i++) await varrerPreAutorizacoesCartao()
          const alertas = erro.mock.calls.map((c) => c[0] as { alert?: string; paymentId?: string }).filter((o) => o?.alert)
          expect(alertas.filter((a) => a.alert === 'payment_void_manual_review')).toHaveLength(1)
          expect(alertas.find((a) => a.alert === 'payment_void_manual_review')!.paymentId).toBe(x.cieloPaymentId)
          expect(alertas.filter((a) => a.alert === 'payment_void_refused').length).toBeLessThanOrEqual(1)
          expect(alertas.some((a) => a.alert === 'payment_gateway_account_restriction')).toBe(Number(codigo) >= 103)
        } finally {
          erro.mockRestore()
        }
        expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(1)
        expect(cielo.contar('GET_BY_ID', { paymentId: x.cieloPaymentId })).toBe(1) // as rodadas seguintes nem consultam: PARADO
        expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
        expect(await redis.exists(`card-void:stop:${x.intentId}`)).toBe(1)
        const intent = await intentDe(x.intentId)
        expect(intent.status).toBe('AUTHORIZED')
        expect((await prisma.authToken.findUniqueOrThrow({ where: { id: intent.authTokenId! } })).status).toBe('ACCEPTED')
        // mesmo "passado o backoff" a parada é definitiva (30 dias): apagar a pausa não reabre
        await redis.del(`card-void:next:${x.intentId}`)
        await varrerPreAutorizacoesCartao()
        expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(1)
      })
    })

    it('(I-3, CORRIGIDO) cancelamento "EM ANDAMENTO" (ReturnCode 476): rodadas seguidas NÃO repetem o PUT (backoff 60 s x 2^n); passado o backoff repete COM consulta; alerta de "em andamento" no máximo 1x/h', async () => {
      const [x] = await abandonadas(1, 'rec-and')
      cielo.agendar('PUT_VOID', ...Array.from({ length: 6 }, () => ({ processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '476' } })))
      const aviso = vi.spyOn(logger, 'warn')
      try {
        for (let i = 0; i < 4; i++) await varrerPreAutorizacoesCartao() // 4 rodadas seguidas
        expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(1)
        expect(await redis.ttl(`card-void:next:${x.intentId}`)).toBeGreaterThan(50)
        expect(await redis.ttl(`card-void:next:${x.intentId}`)).toBeLessThanOrEqual(60)

        const ttls: number[] = []
        for (let n = 0; n < 3; n++) {
          await redis.del(`card-void:next:${x.intentId}`) // "passou o backoff"
          await varrerPreAutorizacoesCartao()
          ttls.push(await redis.ttl(`card-void:next:${x.intentId}`))
        }
        expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(4)
        expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
        // backoff CRESCENTE: 120, 240, 480 s (2ª, 3ª e 4ª tentativas)
        expect(ttls[0]).toBeGreaterThan(100)
        expect(ttls[1]).toBeGreaterThan(ttls[0])
        expect(ttls[2]).toBeGreaterThan(ttls[1])
        const alertasAndamento = aviso.mock.calls.filter((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_void_in_progress')
        expect(alertasAndamento).toHaveLength(1) // 4 PUTs, 1 alerta (limite 1/h por intent)
      } finally {
        aviso.mockRestore()
      }
      expect((await intentDe(x.intentId)).status).toBe('AUTHORIZED')
    })

    it('INDEFINIDO repetido 5 vezes (ReturnCode 77, Status 1): vira revisão manual e PARA; antes da 5ª só há backoff', async () => {
      const [x] = await abandonadas(1, 'indef-5')
      cielo.agendar('PUT_VOID', ...Array.from({ length: 6 }, () => ({ processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '77' } })))
      const erro = vi.spyOn(logger, 'error')
      try {
        for (let n = 0; n < 7; n++) {
          await redis.del(`card-void:next:${x.intentId}`)
          await varrerPreAutorizacoesCartao()
        }
        expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(5) // a 5ª já pede revisão e para; as 2 voltas seguintes não chamam a Cielo
        expect(erro.mock.calls.filter((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_void_manual_review')).toHaveLength(1)
        expect(await redis.exists(`card-void:stop:${x.intentId}`)).toBe(1)
      } finally {
        erro.mockRestore()
      }
    })

    it('a consulta diz FAILED (negada/abortada): NÃO tenta void — espelha o intent como FAILED e expira o idTag', async () => {
      const [x] = await abandonadas(1, 'espelha-failed')
      const v = cielo.vendas.get(x.cieloPaymentId)!
      v.status = 3
      v.returnCode = '51'
      expect(await cancelarPreAutorizacaoCartao(x.intentId)).toBe(false)
      expect(cielo.contar('PUT_VOID')).toBe(0)
      const intent = await intentDe(x.intentId)
      expect(intent.status).toBe('FAILED')
      expect((await prisma.authToken.findUniqueOrThrow({ where: { id: intent.authTokenId! } })).status).toBe('EXPIRED')
    })

    it('MUDANÇA DELIBERADA (era a MEDIÇÃO do loop: 4 PUTs): 4 rodadas com recusa definitiva agora são 1 PUT, intent AUTHORIZED, idTag ACCEPTED', async () => {
      const [x] = await abandonadas(1, 'rec-med')
      cielo.agendar('PUT_VOID', ...Array.from({ length: 4 }, () => ({ processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '40' } })))
      for (let i = 0; i < 4; i++) await varrerPreAutorizacoesCartao()
      expect(cielo.contar('PUT_VOID', { paymentId: x.cieloPaymentId })).toBe(1)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
      expect((await intentDe(x.intentId)).status).toBe('AUTHORIZED')
    })

    it('presos em PARADA/BACKOFF não gastam o lote: 55 intents parados na frente NÃO impedem a rodada de cancelar um intent abandonado mais novo', async () => {
      const presos = await abandonadas(55, 'presos')
      for (const p of presos) await pararCancelamento(p.intentId)
      const [novo] = await abandonadas(1, 'novo-atras')
      await varrerPreAutorizacoesCartao()
      expect((await intentDe(novo.intentId)).status).toBe('VOIDED')
      expect(cielo.contar('PUT_VOID')).toBe(1) // nenhum dos 55 presos foi tocado
    }, 120_000)
  })
})
