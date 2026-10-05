import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// Só para provar o FAIL-CLOSED do registro: com a flag ligada, gravar a auditoria falha.
const auditoriaFalha = vi.hoisted(() => ({ ligada: false }))
vi.mock('../../src/services/auditoria/writeAuditLog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/auditoria/writeAuditLog')>()
  return {
    ...real,
    writeAuditLog: (...args: Parameters<typeof real.writeAuditLog>) => {
      if (auditoriaFalha.ligada) return Promise.reject(new Error('falha simulada ao gravar a auditoria'))
      return real.writeAuditLog(...args)
    },
  }
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { getPaymentsReconciliation } from '../../src/api/services/paymentsService'
import { uniqueSuffix, waitFor } from './helpers/fixtures'
import { SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { criarAdminComSenha, criarCenarioEstorno, type CenarioEstorno } from './helpers/estornoFixture'

/**
 * L1.8, item 3 — chargeback MANUAL assistido (DL7) + desbloqueio manual do cartão (P3): registro com dossiê montado na hora, desfecho WON/LOST/ACCEPTED, `CREATE_DEBT` opcional,
 * bloqueio DERIVADO do modo cartão nos 4 pontos (lista, tokenização, cadastro, start CARD) e a conciliação intacta. Postgres + Redis reais.
 */
describe('chargeback manual (L1.8)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const aviso = () => new Date(Date.now() - 3600_000).toISOString()
  const corpo = (over: Record<string, unknown> = {}) => ({ amountCents: 1000, notifiedAt: aviso(), caseReference: `CASO-${randomUUID().slice(0, 8)}`, reasonCode: '4837', responseDeadline: new Date(Date.now() + 10 * 24 * 3600_000).toISOString(), ...over })
  const registrarUrl = (intentId: string) => `/api/admin/payments/${intentId}/chargebacks`
  const cbUrl = (id: string) => `/api/admin/chargebacks/${id}`
  const MOTIVO_DESBLOQUEIO = 'Motorista comprovou a fraude do cartão, liberado pelo dono'

  beforeEach(() => {
    auditoriaFalha.ligada = false
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const cartao = (label: string, over: Parameters<typeof criarCenarioEstorno>[2] = {}) => criarCenarioEstorno(suffix, label, { paga: 'CARD', totalCents: 1000, ...over })
  const intentDe = (c: CenarioEstorno) => prisma.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId! } })
  const linha = (id: string) => prisma.paymentReversal.findUniqueOrThrow({ where: { id } })
  const elegibilidade = async (c: CenarioEstorno) => (await request(app).get('/api/me/payment-methods').set(auth(c.driver.token))).body.cardEligibility

  async function registrar(c: CenarioEstorno, over: Record<string, unknown> = {}) {
    const res = await request(app).post(registrarUrl(c.intentId!)).set(auth(c.admin.token)).send(corpo(over))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body as { chargebackId: string; dossierId: string }
  }
  const desfecho = (id: string, token: string, body: Record<string, unknown>) => request(app).patch(cbUrl(id)).set(auth(token)).send({ currentPassword: SENHA_ADMIN_TESTE, ...body })
  const desbloquear = (id: string, token: string, body: Record<string, unknown> = {}) => request(app).post(`${cbUrl(id)}/unblock-card`).set(auth(token)).send({ reason: MOTIVO_DESBLOQUEIO, currentPassword: SENHA_ADMIN_TESTE, ...body })

  describe('registro + dossiê', () => {
    it('201 {chargebackId, dossierId}; OPEN; intent ganha chargebackAt e CONTINUA CAPTURED (conciliação); dossiê montado NO MOMENTO sem PII do motorista nem idTag', async () => {
      const c = await cartao('cb-reg')
      // dados reais para o dossiê: pessoais do motorista (NÃO podem ir), origem do início, curva de medição e trilha OCPP
      const cpf = `${Date.now()}`.slice(-11)
      await prisma.user.update({ where: { id: c.driver.id }, data: { cpf, phone: '+55 11 98888-7777' } })
      const sessao = await prisma.chargingSession.findUniqueOrThrow({ where: { id: c.sessionId }, include: { authToken: true } })
      await prisma.chargingSession.update({ where: { id: c.sessionId }, data: { startIp: '203.0.113.77', startUserAgent: `Mozilla/5.0 ${'x'.repeat(300)}` } })
      const t0 = sessao.startedAt.getTime()
      for (let i = 0; i < 600; i++) {
        await prisma.meterSample.createMany({
          data: [
            { sessionId: c.sessionId, chargePointId: c.tenant.chargePointId, operatorId: c.tenant.operatorId, ts: new Date(t0 + i * 5_000), measurand: 'Energy.Active.Import.Register', value: String(i * 10), unit: 'Wh' },
            { sessionId: c.sessionId, chargePointId: c.tenant.chargePointId, operatorId: c.tenant.operatorId, ts: new Date(t0 + i * 5_000), measurand: 'Power.Active.Import', value: '7400', unit: 'W' },
          ],
        })
      }
      const conector = await prisma.connector.findFirstOrThrow({ where: { chargePointId: c.tenant.chargePointId } })
      const base = { chargePointId: c.tenant.chargePointId, operatorId: c.tenant.operatorId, direction: 'INBOUND' as const, messageType: 'CALL' as const }
      await prisma.ocppMessage.createMany({
        data: [
          { ...base, ocppMessageId: randomUUID(), action: 'StartTransaction', occurredAt: new Date(t0 + 1000), payload: [2, 'a', 'StartTransaction', { connectorId: conector.connectorId, idTag: sessao.authToken.idTag, meterStart: 0, timestamp: 'x' }] },
          { ...base, ocppMessageId: randomUUID(), action: 'StopTransaction', occurredAt: new Date(t0 + 3_000_000), payload: [2, 'b', 'StopTransaction', { transactionId: sessao.ocppTransactionId, idTag: sessao.authToken.idTag, meterStop: 10000, reason: 'Local' }] },
          { ...base, ocppMessageId: randomUUID(), action: 'StopTransaction', occurredAt: new Date(t0 + 3_000_100), payload: [2, 'c', 'StopTransaction', { transactionId: sessao.ocppTransactionId + 999, meterStop: 1 }] }, // OUTRA transação: fora
        ],
      })

      const res = await request(app).post(registrarUrl(c.intentId!)).set(auth(c.admin.token)).send(corpo({ amountCents: 1000, caseReference: 'CASO-DOSSIE-1' }))
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body).toEqual({ chargebackId: expect.any(String), dossierId: res.body.chargebackId })

      const r = await linha(res.body.chargebackId)
      expect(r).toMatchObject({ kind: 'CHARGEBACK', status: 'OPEN', paymentIntentId: c.intentId, chargingSessionId: c.sessionId, userId: c.driver.id, amountCents: 1000, caseReference: 'CASO-DOSSIE-1', reasonCode: '4837', createdByUserId: c.admin.id, resolvedAt: null })
      const intent = await intentDe(c)
      expect(intent.status).toBe('CAPTURED')
      expect(intent.chargebackAt).not.toBeNull()
      expect(intent.amountRefundedCents).toBe(0)

      const dossie = r.dossierSnapshot as Record<string, any>
      expect(dossie.versaoDoDossie).toBe(1)
      expect(dossie.venda.adquirente).toMatchObject({ tid: intent.cieloTid, authorizationCode: '123456', proofOfSale: intent.cieloProofOfSale })
      expect(dossie.sessao).toMatchObject({ id: c.sessionId, ocppTransactionId: sessao.ocppTransactionId, energyDeliveredWh: 10000, custo: { totalCostCents: 1000 } })
      expect(dossie.sessao.tarifa).toMatchObject({ model: 'PER_KWH' })
      expect(dossie.cartao).toMatchObject({ brand: 'Visa', last4: '4242' })
      expect(dossie.pagador).toMatchObject({ id: c.driver.id, identidadeVerificada: false })
      expect(dossie.curvaDeMedicao.totalDeAmostrasLidas).toBe(1200)
      expect(dossie.curvaDeMedicao.series.energia.pontos.length).toBeLessThanOrEqual(240) // amostrada
      expect(dossie.curvaDeMedicao.series.energia.totalDePontos).toBe(600)
      expect(dossie.curvaDeMedicao.series.energia.pontos[0][1]).toBe(0) // primeiro e último ponto da curva sempre ficam
      expect(dossie.curvaDeMedicao.series.energia.pontos.at(-1)[1]).toBe(5990)
      expect(dossie.trilhaOcpp.map((e: { acao: string }) => e.acao)).toEqual(['StartTransaction', 'StopTransaction']) // a Stop da OUTRA transação ficou de fora
      expect(dossie.trilhaOcpp[1].resumo).toMatchObject({ meterStop: 10000, reason: 'Local' })
      // origem do início: IP MASCARADO e User-Agent truncado
      expect(dossie.sessao.origemDoInicio.ipMascarado).toBe('203.0.113.0/24')
      expect(dossie.sessao.origemDoInicio.userAgent.length).toBeLessThanOrEqual(120)

      // SEM PII: nada do motorista nem do cartão nem do token do carregador no JSON gravado
      const texto = JSON.stringify(r.dossierSnapshot)
      for (const proibido of [c.driver.name, c.driver.email, cpf, '98888-7777', '203.0.113.77', sessao.authToken.idTag, `Titular driver-cb-reg ${suffix}`, 'holderName', 'passwordHash']) {
        expect(texto, `vazou: ${proibido}`).not.toContain(proibido)
      }
    })

    it('o dossiê SOBREVIVE ao expurgo da medição e do log OCPP (retenção N-11) e o GET devolve exatamente o snapshot; ver o dossiê é auditado; ADMIN-only', async () => {
      const c = await cartao('cb-dossie')
      await prisma.meterSample.create({ data: { sessionId: c.sessionId, chargePointId: c.tenant.chargePointId, operatorId: c.tenant.operatorId, ts: new Date(), measurand: 'SoC', value: '55', unit: 'Percent' } })
      const cb = await registrar(c)
      const gravado = (await linha(cb.chargebackId)).dossierSnapshot
      await prisma.meterSample.deleteMany({ where: { sessionId: c.sessionId } })

      const res = await request(app).get(`${cbUrl(cb.dossierId)}/dossier`).set(auth(c.admin.token))
      expect(res.status).toBe(200)
      expect(res.body).toEqual(gravado)
      expect(res.body.curvaDeMedicao.series.soc.pontos).toHaveLength(1) // a curva continua lá, sem a partição
      const visto = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: cb.chargebackId, actionDetail: 'dossier:view' } }))
      expect(visto).toMatchObject({ action: 'CHARGEBACK', actorUserId: c.admin.id })
      expect((await request(app).get(`${cbUrl(cb.dossierId)}/dossier`).set(auth(c.tenant.staff.token))).status).toBe(403)
      expect((await request(app).get(`${cbUrl(cb.dossierId)}/dossier`).set(auth(c.driver.token))).status).toBe(403)
      expect((await request(app).get(`${cbUrl('nao-existe')}/dossier`).set(auth(c.admin.token))).status).toBe(404)
    })

    it('auditoria CHARGEBACK do registro (fail-closed) sem PII; e se a auditoria falha, NADA é registrado e o cartão NÃO é bloqueado', async () => {
      const c = await cartao('cb-audit')
      auditoriaFalha.ligada = true
      const falhou = await request(app).post(registrarUrl(c.intentId!)).set(auth(c.admin.token)).send(corpo())
      auditoriaFalha.ligada = false
      expect(falhou.status).toBe(500)
      expect(await prisma.paymentReversal.count({ where: { paymentIntentId: c.intentId!, kind: 'CHARGEBACK' } })).toBe(0)
      expect((await elegibilidade(c)).eligible).toBe(true)

      const cb = await registrar(c)
      const a = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: cb.chargebackId, action: 'CHARGEBACK', actionDetail: 'chargeback:registered' } }))
      expect(a).toMatchObject({ outcome: 'SUCCESS', actorUserId: c.admin.id, httpStatus: 201 })
      const dump = JSON.stringify(a.changes)
      expect(dump).not.toContain(c.driver.email)
      expect(dump).not.toContain(c.driver.name)
    })

    it('UM chargeback por venda: o 2º -> 409 CHARGEBACK_ALREADY_REGISTERED; 6 pedidos SIMULTÂNEOS -> exatamente 1 vence', async () => {
      const c = await cartao('cb-dup')
      await registrar(c)
      const dup = await request(app).post(registrarUrl(c.intentId!)).set(auth(c.admin.token)).send(corpo())
      expect(dup.status).toBe(409)
      expect(dup.body.code).toBe('CHARGEBACK_ALREADY_REGISTERED')

      const c2 = await cartao('cb-dup-race')
      const respostas = await Promise.all(Array.from({ length: 6 }, () => request(app).post(registrarUrl(c2.intentId!)).set(auth(c2.admin.token)).send(corpo())))
      expect(respostas.map((r) => r.status).sort(), JSON.stringify(respostas.map((r) => r.body))).toEqual([201, 409, 409, 409, 409, 409])
      for (const r of respostas.filter((x) => x.status === 409)) expect(r.body.code).toBe('CHARGEBACK_ALREADY_REGISTERED') // inclusive os que passaram da pré-checagem e perderam no índice único
      expect(await prisma.paymentReversal.count({ where: { paymentIntentId: c2.intentId!, kind: 'CHARGEBACK' } })).toBe(1)
    })

    it('erros: 404 PAYMENT_NOT_FOUND (inexistente e sessão paga com carteira), 400 (valor > capturado, zero, aviso no futuro, prazo antes do aviso, sem caso, campo desconhecido), 401/403 por papel', async () => {
      const c = await cartao('cb-err')
      const w = await criarCenarioEstorno(suffix, 'cb-err-w', { paga: 'WALLET' })
      const naoExiste = await request(app).post(registrarUrl('intent-que-nao-existe')).set(auth(c.admin.token)).send(corpo())
      expect(naoExiste.status).toBe(404)
      expect(naoExiste.body.code).toBe('PAYMENT_NOT_FOUND')

      const pix = await prisma.paymentIntent.create({ data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: w.driver.id, walletId: w.walletId, status: 'CREATED', amountRequestedCents: 1000 } })
      expect((await request(app).post(registrarUrl(pix.id)).set(auth(c.admin.token)).send(corpo())).status).toBe(404) // Pix não tem chargeback

      const invalidos: Array<Record<string, unknown>> = [
        { amountCents: 1001 }, // acima do capturado
        { amountCents: 0 },
        { notifiedAt: new Date(Date.now() + 86_400_000).toISOString() },
        { notifiedAt: 'ontem' },
        { responseDeadline: new Date(Date.now() - 30 * 86_400_000).toISOString() },
        { caseReference: '' },
        { userId: 'x' },
      ]
      for (const over of invalidos) {
        const res = await request(app).post(registrarUrl(c.intentId!)).set(auth(c.admin.token)).send(corpo(over))
        expect(res.status, JSON.stringify(over)).toBe(400)
        expect(res.body.code).toBe('VALIDATION_ERROR')
      }
      expect(await prisma.paymentReversal.count({ where: { paymentIntentId: c.intentId!, kind: 'CHARGEBACK' } })).toBe(0)

      expect((await request(app).post(registrarUrl(c.intentId!)).set(auth(c.tenant.staff.token)).send(corpo())).status).toBe(403)
      expect((await request(app).post(registrarUrl(c.intentId!)).set(auth(c.driver.token)).send(corpo())).status).toBe(403)
      expect((await request(app).post(registrarUrl(c.intentId!)).send(corpo())).status).toBe(401)
      expect(await prisma.paymentReversal.count({ where: { paymentIntentId: c.intentId!, kind: 'CHARGEBACK' } })).toBe(0)
    })

    it('GET /api/admin/chargebacks (lista paginada) e /:id (ChargebackDTO com cardBlocked), ADMIN-only', async () => {
      const c = await cartao('cb-list')
      const cb = await registrar(c, { caseReference: 'CASO-LISTA-1' })
      const lista = await request(app).get('/api/admin/chargebacks').query({ paymentIntentId: c.intentId!, pageSize: 5 }).set(auth(c.admin.token))
      expect(lista.status).toBe(200)
      expect(lista.body).toMatchObject({ total: 1, page: 1, pageSize: 5 })
      expect(lista.body.items[0]).toMatchObject({ id: cb.chargebackId, paymentIntentId: c.intentId, amountCents: 1000, caseReference: 'CASO-LISTA-1', outcome: null, dossierId: cb.chargebackId, status: 'OPEN', cardBlocked: true, cardUnblockedAt: null })
      const um = await request(app).get(cbUrl(cb.chargebackId)).set(auth(c.admin.token))
      expect(um.body.id).toBe(cb.chargebackId)
      expect((await request(app).get('/api/admin/chargebacks').set(auth(c.tenant.staff.token))).status).toBe(403)
      expect((await request(app).get(cbUrl('nao-existe')).set(auth(c.admin.token))).status).toBe(404)
    })
  })

  describe('bloqueio DERIVADO do modo cartão (CHARGEBACK_BLOCKED) — Pix e carteira seguem', () => {
    const tokenizacao = (c: CenarioEstorno) => request(app).post('/api/me/payment-methods/tokenization-session').set(auth(c.driver.token)).send({})
    const cadastro = (c: CenarioEstorno) => request(app).post('/api/me/payment-methods').set(auth(c.driver.token)).send({ cardToken: randomUUID(), brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2031 })
    const startCartao = async (c: CenarioEstorno) => {
      const metodo = await prisma.paymentMethod.findFirstOrThrow({ where: { userId: c.driver.id } })
      return request(app).post('/api/me/sessions/start').set(auth(c.driver.token)).send({ ocppIdentity: c.tenant.ocppIdentity, connectorId: 1, payment: { mode: 'CARD', paymentMethodId: metodo.id } })
    }
    const startCarteira = (c: CenarioEstorno) => request(app).post('/api/me/sessions/start').set(auth(c.driver.token)).send({ ocppIdentity: c.tenant.ocppIdentity, connectorId: 1, payment: { mode: 'WALLET' } })
    const topupPix = (c: CenarioEstorno) => request(app).post('/api/me/wallet/topups').set(auth(c.driver.token)).send({ amountCents: 1500 })

    it('ANTES do registro nenhum dos 4 pontos barra; DEPOIS: lista = CHARGEBACK_BLOCKED, tokenização/cadastro/start CARD = 403 CARD_CHARGEBACK_BLOCKED; carteira e Pix NÃO são barrados', async () => {
      const c = await cartao('bq-ok')
      expect(await elegibilidade(c)).toMatchObject({ eligible: true, reason: null })
      for (const r of [await tokenizacao(c), await cadastro(c), await startCartao(c)]) expect(r.body.code).not.toBe('CARD_CHARGEBACK_BLOCKED')

      await registrar(c)
      expect(await elegibilidade(c)).toEqual({ eligible: false, reason: 'CHARGEBACK_BLOCKED', blockedUntil: null })
      for (const [nome, chamada] of [['tokenizacao', tokenizacao], ['cadastro', cadastro], ['start CARD', startCartao]] as const) {
        const res = await chamada(c)
        expect(res.status, nome).toBe(403)
        expect(res.body.code, nome).toBe('CARD_CHARGEBACK_BLOCKED')
        expect(JSON.stringify(res.body), nome).not.toContain('CASO-') // o aviso ao motorista não vaza o caso
      }
      // Pix e carteira SEGUEM (não passam pelo portão de cartão)
      expect((await startCarteira(c)).body.code).not.toBe('CARD_CHARGEBACK_BLOCKED')
      expect((await topupPix(c)).body.code).not.toBe('CARD_CHARGEBACK_BLOCKED')
      // e os cartões JÁ cadastrados continuam na lista (a tela os mostra, inutilizáveis)
      const lista = await request(app).get('/api/me/payment-methods').set(auth(c.driver.token))
      expect(lista.status).toBe(200)
      expect(lista.body.items.length).toBeGreaterThanOrEqual(1)
    })

    it('o bloqueio é do MOTORISTA do chargeback — outro motorista não é afetado', async () => {
      const a = await cartao('bq-a')
      const b = await cartao('bq-b')
      await registrar(a)
      expect((await elegibilidade(b)).eligible).toBe(true)
      expect((await elegibilidade(a)).eligible).toBe(false)
    })

    it('WON devolve o cartão sozinho; LOST e ACCEPTED MANTÊM o bloqueio (plataforma absorve, DL7)', async () => {
      const ganho = await cartao('bq-won')
      const perdido = await cartao('bq-lost')
      const aceito = await cartao('bq-acc')
      const idGanho = (await registrar(ganho)).chargebackId
      const idPerdido = (await registrar(perdido)).chargebackId
      const idAceito = (await registrar(aceito)).chargebackId

      const w = await desfecho(idGanho, ganho.admin.token, { outcome: 'WON' })
      expect(w.status, JSON.stringify(w.body)).toBe(200)
      expect(w.body).toMatchObject({ id: idGanho, outcome: 'WON', status: 'WON', cardBlocked: false, debtId: null })
      expect((await elegibilidade(ganho)).eligible).toBe(true)

      const l = await desfecho(idPerdido, perdido.admin.token, { outcome: 'LOST' })
      expect(l.body).toMatchObject({ outcome: 'LOST', cardBlocked: true, debtId: null })
      expect(await prisma.debt.count({ where: { userId: perdido.driver.id } })).toBe(0) // DL7: ABSORVE por padrão (debtPolicy omitido)
      expect((await elegibilidade(perdido)).reason).toBe('CHARGEBACK_BLOCKED')

      const ac = await desfecho(idAceito, aceito.admin.token, { outcome: 'ACCEPTED', debtPolicy: 'ABSORB' })
      expect(ac.body).toMatchObject({ outcome: 'ACCEPTED', cardBlocked: true, debtId: null })
      expect((await elegibilidade(aceito)).reason).toBe('CHARGEBACK_BLOCKED')
      expect(await prisma.debt.count({ where: { userId: aceito.driver.id } })).toBe(0)
      expect((await linha(idPerdido)).resolvedByUserId).toBe(perdido.admin.id)
    })
  })

  describe('desfecho (PATCH /api/admin/chargebacks/:id)', () => {
    it('LOST + CREATE_DEBT (ação manual do ADMIN): Debt OPEN do valor do chargeback, SEM chargingSessionId (não quebra a conciliação), ligada ao intent; conciliação IDÊNTICA antes/depois', async () => {
      const c = await cartao('d-debt')
      const janela = { from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 24 * 3600_000) }
      const escopo = { operatorId: c.tenant.operatorId } as never
      const antes = await getPaymentsReconciliation(escopo, janela as never, true)
      const cb = await registrar(c, { amountCents: 800 })
      const res = await desfecho(cb.chargebackId, c.admin.token, { outcome: 'LOST', debtPolicy: 'CREATE_DEBT' })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.debtId).toEqual(expect.any(String))

      const divida = await prisma.debt.findUniqueOrThrow({ where: { id: res.body.debtId } })
      expect(divida).toMatchObject({ userId: c.driver.id, amountCents: 800, status: 'OPEN', reason: 'CHARGEBACK', chargingSessionId: null, paymentIntentId: c.intentId })
      expect((await linha(cb.chargebackId)).debtId).toBe(divida.id)

      const depois = await getPaymentsReconciliation(escopo, janela as never, true)
      for (const campo of ['revenueCents', 'cardCapturedCents', 'walletDebitCents', 'debtSettledCents', 'openDebtCents', 'expectedCents', 'accountedCents', 'differenceCents'] as const) {
        expect(depois[campo], campo).toBe(antes[campo])
      }
      expect(depois.differenceCents).toBe(0)
    })

    it('WON + CREATE_DEBT -> 400 (ganho não gera dívida); desfecho inválido/ausente -> 400; nada muda', async () => {
      const c = await cartao('d-won-debt')
      const cb = await registrar(c)
      for (const body of [{ outcome: 'WON', debtPolicy: 'CREATE_DEBT' }, { outcome: 'ABERTO' }, {}, { outcome: 'LOST', debtPolicy: 'TALVEZ' }, { outcome: 'LOST', amountCents: 5 }]) {
        const res = await desfecho(cb.chargebackId, c.admin.token, body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
      expect((await linha(cb.chargebackId)).status).toBe('OPEN')
      expect(await prisma.debt.count({ where: { userId: c.driver.id } })).toBe(0)
    })

    it('já resolvido -> 409 CHARGEBACK_ALREADY_RESOLVED; dois ADMINs ao mesmo tempo -> exatamente um vence (e 1 dívida só)', async () => {
      const c = await cartao('d-race')
      const outro = await criarAdminComSenha(suffix, 'd-race-2')
      const cb = await registrar(c)
      const [x, y] = await Promise.all([desfecho(cb.chargebackId, c.admin.token, { outcome: 'LOST', debtPolicy: 'CREATE_DEBT' }), desfecho(cb.chargebackId, outro.token, { outcome: 'WON' })])
      expect([x.status, y.status].sort()).toEqual([200, 409])
      expect([x, y].find((r) => r.status === 409)!.body.code).toBe('CHARGEBACK_ALREADY_RESOLVED')
      const final = await linha(cb.chargebackId)
      expect(['LOST', 'WON']).toContain(final.status)
      expect(await prisma.debt.count({ where: { userId: c.driver.id } })).toBe(final.status === 'LOST' ? 1 : 0)

      const denovo = await desfecho(cb.chargebackId, c.admin.token, { outcome: 'ACCEPTED' })
      expect(denovo.status).toBe(409)
      expect(denovo.body.code).toBe('CHARGEBACK_ALREADY_RESOLVED')
    })

    it('STEP-UP: sem senha 400; errada 403 INVALID_CURRENT_PASSWORD antes de qualquer regra (nada muda) com DENIED/CHARGEBACK na auditoria; OPERATOR/DRIVER 403; inexistente 404; auditoria do desfecho sem PII', async () => {
      const c = await cartao('d-step')
      const cb = await registrar(c)
      const { currentPassword: _p, ...semSenha } = { currentPassword: '', outcome: 'WON' }
      expect((await request(app).patch(cbUrl(cb.chargebackId)).set(auth(c.admin.token)).send(semSenha)).status).toBe(400)
      const errada = await desfecho(cb.chargebackId, c.admin.token, { outcome: 'WON', currentPassword: 'SenhaErrada#Marcador-9f3a' })
      expect(errada.status).toBe(403)
      expect(errada.body.code).toBe('INVALID_CURRENT_PASSWORD')
      expect((await linha(cb.chargebackId)).status).toBe('OPEN')
      const negada = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: c.admin.id, action: 'CHARGEBACK', outcome: 'DENIED' } }))
      expect(negada.actionDetail).toBe('stepup_failed')

      expect((await desfecho(cb.chargebackId, c.tenant.staff.token, { outcome: 'WON' })).status).toBe(403)
      expect((await desfecho(cb.chargebackId, c.driver.token, { outcome: 'WON' })).status).toBe(403)
      expect((await desfecho('nao-existe', c.admin.token, { outcome: 'WON' })).status).toBe(404)

      expect((await desfecho(cb.chargebackId, c.admin.token, { outcome: 'LOST', debtPolicy: 'CREATE_DEBT' })).status).toBe(200)
      const a = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: cb.chargebackId, actionDetail: 'chargeback:lost:debt_created' } }))
      expect(a).toMatchObject({ action: 'CHARGEBACK', outcome: 'SUCCESS' })
      expect(JSON.stringify(a.changes)).not.toContain(c.driver.email)
      expect(JSON.stringify(a.changes)).not.toContain(SENHA_ADMIN_TESTE)
    })
  })

  describe('desbloqueio manual do cartão (P3, aceita pelo dono em 06/10/2026)', () => {
    it('LOST bloqueia ATÉ o desbloqueio; depois o cartão volta, o registro/desfecho/dossiê NÃO mudam e nada é apagado', async () => {
      const c = await cartao('u-ok')
      const cb = await registrar(c)
      await desfecho(cb.chargebackId, c.admin.token, { outcome: 'LOST', debtPolicy: 'CREATE_DEBT' })
      const antes = await linha(cb.chargebackId)
      expect((await elegibilidade(c)).reason).toBe('CHARGEBACK_BLOCKED')

      const res = await desbloquear(cb.chargebackId, c.admin.token)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body).toMatchObject({ id: cb.chargebackId, status: 'LOST', outcome: 'LOST', cardBlocked: false, cardUnblockedAt: expect.any(String), cardUnblockReason: MOTIVO_DESBLOQUEIO })

      expect(await elegibilidade(c)).toMatchObject({ eligible: true, reason: null })
      const depois = await linha(cb.chargebackId)
      expect(depois).toMatchObject({ status: 'LOST', debtId: antes.debtId, resolvedByUserId: antes.resolvedByUserId, cardUnblockedByUserId: c.admin.id, cardUnblockReason: MOTIVO_DESBLOQUEIO })
      expect(depois.cardUnblockedAt).toBeInstanceOf(Date)
      expect(depois.dossierSnapshot).toEqual(antes.dossierSnapshot) // dossiê intacto
      expect(depois.resolvedAt).toEqual(antes.resolvedAt)
      expect(await prisma.paymentReversal.count({ where: { id: cb.chargebackId } })).toBe(1) // não apagou
      expect(await prisma.debt.count({ where: { id: antes.debtId! } })).toBe(1) // a dívida continua (ação à parte)
    })

    it('ACCEPTED também pode ser desbloqueado; 2º desbloqueio -> 409 CARD_ALREADY_UNBLOCKED; aberto e ganho -> 409 CHARGEBACK_NOT_LOST', async () => {
      const aceito = await cartao('u-acc')
      const aberto = await cartao('u-open')
      const ganho = await cartao('u-won')
      const idAceito = (await registrar(aceito)).chargebackId
      const idAberto = (await registrar(aberto)).chargebackId
      const idGanho = (await registrar(ganho)).chargebackId
      await desfecho(idAceito, aceito.admin.token, { outcome: 'ACCEPTED' })
      await desfecho(idGanho, ganho.admin.token, { outcome: 'WON' })

      expect((await desbloquear(idAceito, aceito.admin.token)).status).toBe(200)
      const dois = await desbloquear(idAceito, aceito.admin.token)
      expect(dois.status).toBe(409)
      expect(dois.body.code).toBe('CARD_ALREADY_UNBLOCKED')

      for (const [id, c] of [[idAberto, aberto], [idGanho, ganho]] as const) {
        const res = await desbloquear(id, c.admin.token)
        expect(res.status).toBe(409)
        expect(res.body.code).toBe('CHARGEBACK_NOT_LOST')
      }
      expect((await linha(idAberto)).cardUnblockedAt).toBeNull()
      expect((await elegibilidade(aberto)).reason).toBe('CHARGEBACK_BLOCKED') // aberto continua bloqueado
    })

    it('com DOIS chargebacks perdidos, desbloquear UM mantém o cartão bloqueado pelo outro', async () => {
      const c1 = await cartao('u-dois')
      const sessao2 = await criarCenarioEstorno(suffix, 'u-dois-b', { paga: 'CARD', totalCents: 500, tenant: c1.tenant, admin: c1.admin })
      // a 2ª venda precisa ser do MESMO motorista: move sessão/intent/ficha para o motorista 1 (fixture direto no banco)
      await prisma.chargingSession.update({ where: { id: sessao2.sessionId }, data: { userId: c1.driver.id } })
      await prisma.paymentIntent.update({ where: { id: sessao2.intentId! }, data: { userId: c1.driver.id, paymentMethodId: null } })
      const a = (await registrar(c1)).chargebackId
      const b = (await request(app).post(registrarUrl(sessao2.intentId!)).set(auth(c1.admin.token)).send(corpo({ amountCents: 500 })))
      expect(b.status, JSON.stringify(b.body)).toBe(201)
      await desfecho(a, c1.admin.token, { outcome: 'LOST' })
      await desfecho(b.body.chargebackId, c1.admin.token, { outcome: 'LOST' })

      expect((await desbloquear(a, c1.admin.token)).status).toBe(200)
      expect((await elegibilidade(c1)).reason).toBe('CHARGEBACK_BLOCKED') // o 2º segue
      expect((await desbloquear(b.body.chargebackId, c1.admin.token)).status).toBe(200)
      expect((await elegibilidade(c1)).eligible).toBe(true)
    })

    it('STEP-UP e motivo: sem motivo/curto/com quebra de linha 400; senha errada 403 (nada muda); OPERATOR/DRIVER 403; 404; auditoria SEM o texto do motivo', async () => {
      const c = await cartao('u-step')
      const cb = (await registrar(c)).chargebackId
      await desfecho(cb, c.admin.token, { outcome: 'LOST' })
      for (const over of [{ reason: undefined }, { reason: 'curto' }, { reason: 'motivo com\nquebra de linha' }, { reason: 'x'.repeat(501) }, { extra: 1 }]) {
        expect((await desbloquear(cb, c.admin.token, over)).status, JSON.stringify(over)).toBe(400)
      }
      const errada = await desbloquear(cb, c.admin.token, { currentPassword: 'SenhaErrada#Marcador-9f3a' })
      expect(errada.status).toBe(403)
      expect(errada.body.code).toBe('INVALID_CURRENT_PASSWORD')
      expect((await desbloquear(cb, c.tenant.staff.token)).status).toBe(403)
      expect((await desbloquear(cb, c.driver.token)).status).toBe(403)
      expect((await desbloquear('nao-existe', c.admin.token)).status).toBe(404)
      expect((await linha(cb)).cardUnblockedAt).toBeNull()
      expect((await elegibilidade(c)).reason).toBe('CHARGEBACK_BLOCKED')

      expect((await desbloquear(cb, c.admin.token, { reason: 'MOTIVO-SECRETO-NAO-VAI-PARA-A-AUDITORIA' })).status).toBe(200)
      const a = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: cb, actionDetail: 'chargeback:card_unblocked' } }))
      expect(a).toMatchObject({ action: 'CHARGEBACK', outcome: 'SUCCESS', actorUserId: c.admin.id })
      expect(JSON.stringify(a.changes)).not.toContain('MOTIVO-SECRETO')
    })

    it('duas tentativas SIMULTÂNEAS (2 ADMINs) -> exatamente um desbloqueio', async () => {
      const c = await cartao('u-race')
      const outro = await criarAdminComSenha(suffix, 'u-race-2')
      const cb = (await registrar(c)).chargebackId
      await desfecho(cb, c.admin.token, { outcome: 'LOST' })
      const [x, y] = await Promise.all([desbloquear(cb, c.admin.token), desbloquear(cb, outro.token)])
      expect([x.status, y.status].sort()).toEqual([200, 409])
    })

    it('REDE DO BANCO: o desbloqueio não vale em OPEN/WON, não se desfaz e não vem pela metade (CHECK/trigger do Cronos + migration do Vega-E)', async () => {
      const c = await cartao('u-db')
      const cb = (await registrar(c)).chargebackId
      const tentar = (sql: ReturnType<typeof prisma.$executeRaw>) => sql.then(() => null, (e: unknown) => String(e instanceof Error ? e.message : e))
      // OPEN: não pode
      expect(await tentar(prisma.$executeRaw`UPDATE "PaymentReversal" SET "cardUnblockedAt" = now(), "cardUnblockedByUserId" = ${c.admin.id}, "cardUnblockReason" = 'direto no banco' WHERE id = ${cb}`)).toMatch(/payment_reversal_card_unblock|chargeback já perdido/)
      await desfecho(cb, c.admin.token, { outcome: 'LOST' })
      // pela metade: não pode
      expect(await tentar(prisma.$executeRaw`UPDATE "PaymentReversal" SET "cardUnblockedAt" = now() WHERE id = ${cb}`)).toMatch(/payment_reversal_card_unblock/)
      // mudar o desfecho junto com o desbloqueio: não pode
      expect(await tentar(prisma.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'WON' WHERE id = ${cb}`)).toMatch(/terminal/)
      await desbloquear(cb, c.admin.token)
      // desfazer / reescrever: não pode
      expect(await tentar(prisma.$executeRaw`UPDATE "PaymentReversal" SET "cardUnblockedAt" = NULL, "cardUnblockedByUserId" = NULL, "cardUnblockReason" = NULL WHERE id = ${cb}`)).toMatch(/desbloqueio do cartão já foi registrado/)
      expect(await tentar(prisma.$executeRaw`UPDATE "PaymentReversal" SET "cardUnblockReason" = 'reescrito' WHERE id = ${cb}`)).toMatch(/desbloqueio do cartão já foi registrado/)
      // o dossiê segue imutável
      expect(await tentar(prisma.$executeRaw`UPDATE "PaymentReversal" SET "dossierSnapshot" = '{}'::jsonb WHERE id = ${cb}`)).toMatch(/imutáveis/)
    })
  })
})
