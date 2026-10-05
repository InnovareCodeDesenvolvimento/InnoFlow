import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// A rota NUNCA fala com a Cielo (DL8) e o FAIL-CLOSED da auditoria é provado com uma falha simulada ao gravá-la.
const portSpy = vi.hoisted(() => ({ chamadas: 0 }))
const auditoriaFalha = vi.hoisted(() => ({ ligada: false }))
vi.mock('../../src/services/pagamentos/pagamentoPortInstance', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/pagamentos/pagamentoPortInstance')>()
  return {
    ...real,
    getPagamentoPort: async (...args: Parameters<typeof real.getPagamentoPort>) => {
      portSpy.chamadas += 1
      return real.getPagamentoPort(...args)
    },
  }
})
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
import type { PagamentoPort, ResultadoConsultaPagamento } from '../../src/core/pagamentos/porta'
import { getPaymentsReconciliation } from '../../src/api/services/paymentsService'
import { confirmarEstornosPortal } from '../../src/services/estornos/confirmarEstornosPortal'
import { uniqueSuffix, waitFor } from './helpers/fixtures'
import { SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { criarAdminComSenha, criarCenarioEstorno, type CenarioEstorno } from './helpers/estornoFixture'

/**
 * L1.8 — confirmação MANUAL de uma devolução pelo portal (`POST /api/admin/refunds/:id/confirm`): o caso que o job não resolve (estorno PARCIAL, venda fora da janela de reconsulta).
 * Postgres + Redis reais. As respostas da Cielo do job são fixtures inventados (a forma real da consulta de estorno parcial nunca foi vista).
 */
describe('confirmação manual de devolução no portal (L1.8)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const MOTIVO = 'Cobrança em duplicidade, devolvido no portal'
  const PROVA = 'COMPROVANTE-2026/10-0042'
  const registroUrl = (sessionId: string) => `/api/admin/sessions/${sessionId}/refunds`
  const confirmUrl = (id: string) => `/api/admin/refunds/${id}/confirm`
  const cancelUrl = (id: string) => `/api/admin/refunds/${id}/cancel`
  const corpoRegistro = (over: Record<string, unknown> = {}) => ({ amountCents: 400, reason: MOTIVO, destination: 'CARD_VIA_PORTAL', portalReference: 'PORTAL-ABC-1', currentPassword: SENHA_ADMIN_TESTE, ...over })
  const confirmar = (id: string, token: string, body: Record<string, unknown> = {}) => request(app).post(confirmUrl(id)).set(auth(token)).send({ proofReference: PROVA, currentPassword: SENHA_ADMIN_TESTE, ...body })

  beforeEach(() => {
    portSpy.chamadas = 0
    auditoriaFalha.ligada = false
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const cartao = (label: string, over: Parameters<typeof criarCenarioEstorno>[2] = {}) => criarCenarioEstorno(suffix, label, { paga: 'CARD', totalCents: 1000, ...over })
  const linha = (id: string) => prisma.paymentReversal.findUniqueOrThrow({ where: { id } })
  const intentDe = (c: CenarioEstorno) => prisma.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId! } })
  const auditoriasDe = (id: string, detail: string, outcome = 'SUCCESS') => prisma.auditLog.findMany({ where: { entityId: id, actionDetail: detail, outcome: outcome as never } })

  async function registrar(c: CenarioEstorno, over: Record<string, unknown> = {}) {
    const res = await request(app).post(registroUrl(c.sessionId)).set(auth(c.admin.token)).send(corpoRegistro(over))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.refundId as string
  }

  function portFalso(statusBruto: number | null) {
    const consultar = vi.fn(async (providerPaymentId: string): Promise<ResultadoConsultaPagamento> => ({
      providerPaymentId,
      merchantOrderId: 'x',
      status: 'CAPTURED',
      returnCode: '00',
      amountAuthorizedCents: 1000,
      amountCapturedCents: 1000,
      identificadores: { tid: null, authorizationCode: null, proofOfSale: null },
      statusBruto,
    }))
    return { port: { consultar } as unknown as PagamentoPort, consultar }
  }

  it('estorno PARCIAL (400 de 1000) pendente -> 200 CONFIRMED manual; o trigger sobe amountRefundedCents; o status do intent e a CONCILIAÇÃO não mudam; sem tocar na Cielo', async () => {
    const c = await cartao('m-parcial')
    const id = await registrar(c)
    const janela = { from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 24 * 3600_000) }
    const escopo = { operatorId: c.tenant.operatorId, siteId: undefined, chargePointId: undefined } as never
    const antes = await getPaymentsReconciliation(escopo, janela as never, true)
    expect(antes.differenceCents).toBe(0)
    expect((await intentDe(c)).amountRefundedCents).toBe(0)

    const res = await confirmar(id, c.admin.token)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ refundId: id, status: 'CONFIRMED', confirmedManually: true, proofReference: PROVA })

    const r = await linha(id)
    expect(r).toMatchObject({ status: 'CONFIRMED', resolvedByUserId: c.admin.id, portalReference: PROVA, amountCents: 400, destination: 'CARD_VIA_PORTAL' })
    expect(r.resolvedAt).toBeInstanceOf(Date)
    expect(await intentDe(c)).toMatchObject({ amountRefundedCents: 400, status: 'CAPTURED' })

    const depois = await getPaymentsReconciliation(escopo, janela as never, true)
    for (const campo of ['revenueCents', 'walletDebitCents', 'cardCapturedCents', 'cardCapturePendingCents', 'debtSettledCents', 'openDebtCents', 'expectedCents', 'accountedCents', 'differenceCents'] as const) {
      expect(depois[campo], campo).toBe(antes[campo])
    }
    expect(depois.differenceCents).toBe(0)
    expect(depois.cardRefundedCents - antes.cardRefundedCents).toBe(400) // só o campo INFORMATIVO sobe
    expect(portSpy.chamadas).toBe(0)
  })

  it('AUDITORIA REFUND/refund:manually_confirmed na mesma transação: ator, status e referência (de -> para); sem senha, sem motivo, sem nome/e-mail do motorista', async () => {
    const c = await cartao('m-audit')
    const id = await registrar(c, { reason: 'MOTIVO-SECRETO-do-estorno' })
    const res = await confirmar(id, c.admin.token)
    expect(res.status).toBe(200)

    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: id, action: 'REFUND', actionDetail: 'refund:manually_confirmed' } }))
    expect(audit).toMatchObject({ actorUserId: c.admin.id, outcome: 'SUCCESS', httpStatus: 200, entityType: 'PaymentReversal', method: 'POST' })
    expect(audit.changes).toMatchObject({ status: { from: 'PENDING_CONFIRMATION', to: 'CONFIRMED' }, portalReference: { from: 'PORTAL-ABC-1', to: PROVA }, amountCents: { to: 400 } })
    const dump = JSON.stringify(audit.changes)
    for (const proibido of ['MOTIVO-SECRETO', SENHA_ADMIN_TESTE, c.driver.email, c.driver.name, 'currentPassword']) expect(dump).not.toContain(proibido)
    expect(await auditoriasDe(id, 'refund:manually_confirmed')).toHaveLength(1) // o middleware NÃO duplica (skip)
  })

  it('no DTO da sessão: confirmedManually=true na manual; false na confirmada pelo JOB (resolvedByUserId nulo), na pendente e na carteira', async () => {
    const c = await cartao('m-dto')
    const manual = await registrar(c, { amountCents: 300, portalReference: 'P-1' })
    const pendente = await registrar(c, { amountCents: 200, portalReference: 'P-2' })
    const doJob = await registrar(c, { amountCents: 500, portalReference: 'P-3' })
    expect((await confirmar(manual, c.admin.token)).status).toBe(200)
    // o job só confirma com o registro cobrindo o capturado INTEIRO: 300 (manual, já CONFIRMED) + 200 (pendente) + 500 = 1000 -> confirma as DUAS pendentes
    await confirmarEstornosPortal({ port: portFalso(11).port })
    expect((await linha(pendente)).status).toBe('CONFIRMED')
    expect((await linha(doJob)).status).toBe('CONFIRMED')

    const lista = await request(app).get(registroUrl(c.sessionId)).set(auth(c.admin.token))
    expect(lista.status).toBe(200)
    const porId = Object.fromEntries((lista.body.items as Array<{ id: string; confirmedManually: boolean; status: string; portalReference: string | null }>).map((i) => [i.id, i]))
    expect(porId[manual]).toMatchObject({ status: 'CONFIRMED', confirmedManually: true, portalReference: PROVA })
    expect(porId[pendente]).toMatchObject({ status: 'CONFIRMED', confirmedManually: false, portalReference: 'P-2' })
    expect(porId[doJob]).toMatchObject({ status: 'CONFIRMED', confirmedManually: false })

    const w = await criarCenarioEstorno(suffix, 'm-dto-w', { paga: 'WALLET', totalCents: 1000 })
    await request(app).post(registroUrl(w.sessionId)).set(auth(w.admin.token)).send(corpoRegistro({ destination: 'WALLET', portalReference: undefined }))
    const listaW = await request(app).get(registroUrl(w.sessionId)).set(auth(w.admin.token))
    expect(listaW.body.items[0]).toMatchObject({ destination: 'WALLET', status: 'CONFIRMED', confirmedManually: false })
  })

  it('venda FORA da janela de reconsulta (100 dias): o job não a consulta e a confirmação manual resolve (o caso que ficava pendente para sempre)', async () => {
    const c = await cartao('m-janela')
    await prisma.paymentIntent.update({ where: { id: c.intentId! }, data: { capturedAt: new Date(Date.now() - 100 * 24 * 3600_000), authorizedAt: new Date(Date.now() - 100 * 24 * 3600_000) } })
    const id = await registrar(c, { amountCents: 1000 })
    const { port, consultar } = portFalso(11)
    await confirmarEstornosPortal({ port })
    expect(consultar).not.toHaveBeenCalledWith((await intentDe(c)).cieloPaymentId)
    expect((await linha(id)).status).toBe('PENDING_CONFIRMATION')

    expect((await confirmar(id, c.admin.token)).status).toBe(200)
    expect((await linha(id)).status).toBe('CONFIRMED')
    expect((await intentDe(c)).amountRefundedCents).toBe(1000)
  })

  it('duas devoluções pendentes confirmadas à mão: amountRefundedCents é a SOMA (recalculada, não incrementada) e nunca passa do capturado', async () => {
    const c = await cartao('m-soma')
    const a = await registrar(c, { amountCents: 400, portalReference: 'P-A' })
    const b = await registrar(c, { amountCents: 600, portalReference: 'P-B' })
    expect((await confirmar(a, c.admin.token, { proofReference: 'PROVA-AAAAA' })).status).toBe(200)
    expect((await intentDe(c)).amountRefundedCents).toBe(400)
    expect((await confirmar(b, c.admin.token, { proofReference: 'PROVA-BBBBB' })).status).toBe(200)
    expect((await intentDe(c)).amountRefundedCents).toBe(1000)
    // o teto continua do registro: 1 centavo a mais não entra mais
    const alem = await request(app).post(registroUrl(c.sessionId)).set(auth(c.admin.token)).send(corpoRegistro({ amountCents: 1 }))
    expect(alem.status).toBe(409)
    expect(alem.body.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')
  })

  it('CORRIDA: dois ADMINs confirmam a MESMA devolução ao mesmo tempo -> exatamente 1 vence (200), o outro 409 REFUND_NOT_CONFIRMABLE; 1 auditoria; amountRefundedCents conta uma vez', async () => {
    const c = await cartao('m-corrida')
    const admin2 = await criarAdminComSenha(suffix, 'm-corrida-2')
    const id = await registrar(c)
    const [r1, r2] = await Promise.all([confirmar(id, c.admin.token, { proofReference: 'PROVA-ADMIN-UM' }), confirmar(id, admin2.token, { proofReference: 'PROVA-ADMIN-DOIS' })])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    const perdedor = r1.status === 409 ? r1 : r2
    const vencedor = r1.status === 200 ? r1 : r2
    expect(perdedor.body.code).toBe('REFUND_NOT_CONFIRMABLE')

    const r = await linha(id)
    expect(r.status).toBe('CONFIRMED')
    expect(r.portalReference).toBe(vencedor.body.proofReference) // a prova gravada é a do VENCEDOR, não a do perdedor
    expect([c.admin.id, admin2.id]).toContain(r.resolvedByUserId)
    expect(await auditoriasDe(id, 'refund:manually_confirmed')).toHaveLength(1) // só UMA confirmação com sucesso...
    const recusa = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: id, actionDetail: 'refund:manually_confirmed', outcome: { not: 'SUCCESS' } } }))
    expect(recusa.actorUserId).toBe(perdedor === r1 ? c.admin.id : admin2.id) // ...e a recusa do perdedor fica registrada pelo middleware
    expect((await intentDe(c)).amountRefundedCents).toBe(400)
  })

  it('CORRIDA com o JOB: o ADMIN confirma ENQUANTO o job consulta a Cielo -> o job NÃO sobrescreve (mantém a prova e o ADMIN) e não duplica a auditoria', async () => {
    const c = await cartao('m-corrida-job')
    const id = await registrar(c, { amountCents: 1000 })
    const { port, consultar } = portFalso(11)
    consultar.mockImplementationOnce(async (providerPaymentId: string) => {
      expect((await confirmar(id, c.admin.token)).status).toBe(200) // durante a consulta de rede
      return { providerPaymentId, merchantOrderId: 'x', status: 'CAPTURED', returnCode: '00', amountAuthorizedCents: 1000, amountCapturedCents: 1000, identificadores: { tid: null, authorizationCode: null, proofOfSale: null }, statusBruto: 11 }
    })
    await confirmarEstornosPortal({ port })
    const r = await linha(id)
    expect(r).toMatchObject({ status: 'CONFIRMED', resolvedByUserId: c.admin.id, portalReference: PROVA })
    expect(await auditoriasDe(id, 'refund:auto_confirmed')).toHaveLength(0)
    expect(await auditoriasDe(id, 'refund:manually_confirmed')).toHaveLength(1)
    expect((await intentDe(c)).amountRefundedCents).toBe(1000)
  })

  it('409 REFUND_NOT_CONFIRMABLE: já confirmada, cancelada, devolução na CARTEIRA; chargeback e id inexistente -> 404; nada muda', async () => {
    const c = await cartao('m-409')
    const id = await registrar(c, { amountCents: 500 })
    expect((await confirmar(id, c.admin.token)).status).toBe(200)
    const denovo = await confirmar(id, c.admin.token, { proofReference: 'OUTRA-PROVA-9' })
    expect(denovo.status).toBe(409)
    expect(denovo.body.code).toBe('REFUND_NOT_CONFIRMABLE')
    expect((await linha(id)).portalReference).toBe(PROVA) // a 2ª prova NÃO sobrescreve

    const cancelada = await registrar(c, { amountCents: 100, portalReference: 'P-X' })
    expect((await request(app).post(cancelUrl(cancelada)).set(auth(c.admin.token)).send({ currentPassword: SENHA_ADMIN_TESTE })).status).toBe(200)
    const c409 = await confirmar(cancelada, c.admin.token)
    expect(c409.status).toBe(409)
    expect(c409.body.code).toBe('REFUND_NOT_CONFIRMABLE')
    expect((await linha(cancelada)).status).toBe('CANCELLED')

    const w = await criarCenarioEstorno(suffix, 'm-409-w', { paga: 'WALLET', totalCents: 1000 })
    const idW = (await request(app).post(registroUrl(w.sessionId)).set(auth(w.admin.token)).send(corpoRegistro({ destination: 'WALLET', portalReference: undefined }))).body.refundId as string
    const wRes = await confirmar(idW, w.admin.token)
    expect(wRes.status).toBe(409)
    expect(wRes.body.code).toBe('REFUND_NOT_CONFIRMABLE')

    const k = await cartao('m-409-cb')
    const cb = await request(app).post(`/api/admin/payments/${k.intentId}/chargebacks`).set(auth(k.admin.token)).send({ amountCents: 1000, notifiedAt: new Date(Date.now() - 3600_000).toISOString(), caseReference: 'CASO-CONF-1' })
    expect(cb.status, JSON.stringify(cb.body)).toBe(201)
    expect((await confirmar(cb.body.chargebackId, k.admin.token)).status).toBe(404) // chargeback não é devolução
    expect((await linha(cb.body.chargebackId)).status).toBe('OPEN')
    expect((await confirmar('nao-existe', c.admin.token)).status).toBe(404)
  })

  it('SEGURANÇA: sem token 401; DRIVER/OPERATOR 403; senha errada 403 e NADA muda (nem a referência)', async () => {
    const c = await cartao('m-seg')
    const id = await registrar(c)
    expect((await request(app).post(confirmUrl(id)).send({ proofReference: PROVA, currentPassword: SENHA_ADMIN_TESTE })).status).toBe(401)
    expect((await confirmar(id, c.driver.token)).status).toBe(403)
    expect((await confirmar(id, c.tenant.staff.token)).status).toBe(403)
    const errada = await confirmar(id, c.admin.token, { currentPassword: 'SenhaErrada#Marcador-9f3a' })
    expect(errada.status).toBe(403)
    expect(errada.body.code).toBe('INVALID_CURRENT_PASSWORD')
    expect(await linha(id)).toMatchObject({ status: 'PENDING_CONFIRMATION', portalReference: 'PORTAL-ABC-1', resolvedAt: null, resolvedByUserId: null })
    const denied = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: id, action: 'REFUND', actionDetail: 'stepup_failed' } }))
    expect(denied.outcome).toBe('DENIED')
  })

  it('VALIDAÇÃO 400: proofReference ausente/curta/longa/com espaço/e-mail/CPF/número de cartão/tipo errado/campo desconhecido; nada muda', async () => {
    const c = await cartao('m-val')
    const id = await registrar(c)
    const invalidos: Array<[string, Record<string, unknown>]> = [
      ['ausente', { proofReference: undefined }],
      ['vazia', { proofReference: '' }],
      ['4 caracteres', { proofReference: 'ABCD' }],
      ['121 caracteres', { proofReference: 'A'.repeat(121) }],
      ['só espaços', { proofReference: '      ' }],
      ['com espaço (frase/nome)', { proofReference: 'Joao da Silva 2026' }],
      ['e-mail', { proofReference: 'joao@exemplo.com' }],
      ['CPF com máscara', { proofReference: '123.456.789-09' }],
      ['número de cartão (Luhn válido)', { proofReference: '4111111111111111' }],
      ['caractere de controle', { proofReference: 'COMP\nROVANTE1' }],
      ['tipo errado', { proofReference: 12345678 }],
      ['campo desconhecido', { status: 'CONFIRMED' }],
      ['senha ausente', { currentPassword: undefined }],
    ]
    for (const [rotulo, over] of invalidos) {
      const res = await confirmar(id, c.admin.token, over)
      expect(res.status, `${rotulo}: ${JSON.stringify(res.body)}`).toBe(400)
      expect(res.body.code, rotulo).toBe('VALIDATION_ERROR')
    }
    expect(await linha(id)).toMatchObject({ status: 'PENDING_CONFIRMATION', portalReference: 'PORTAL-ABC-1' })
  })

  it('VALIDAÇÃO 200: aceita códigos reais do comprovante (letras, dígitos . _ - / # :), 5 e 120 caracteres, e um número de 16 dígitos que NÃO passa no Luhn', async () => {
    for (const [i, prova] of ['ABCDE', 'A'.repeat(120), 'NSU:123456/2026#7', '4111111111111112', 'comp.2026-10_05'].entries()) {
      const c = await cartao(`m-ok-${i}`)
      const id = await registrar(c)
      const res = await confirmar(id, c.admin.token, { proofReference: prova })
      expect(res.status, `${prova}: ${JSON.stringify(res.body)}`).toBe(200)
      expect((await linha(id)).portalReference).toBe(prova)
    }
  })

  it('FAIL-CLOSED: se a auditoria não grava, NADA é confirmado (a transação inteira reverte) e amountRefundedCents fica intacto', async () => {
    const c = await cartao('m-failclosed')
    const id = await registrar(c)
    auditoriaFalha.ligada = true
    const res = await confirmar(id, c.admin.token)
    auditoriaFalha.ligada = false
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await linha(id)).toMatchObject({ status: 'PENDING_CONFIRMATION', portalReference: 'PORTAL-ABC-1', resolvedAt: null, resolvedByUserId: null })
    expect((await intentDe(c)).amountRefundedCents).toBe(0)
    expect((await confirmar(id, c.admin.token)).status).toBe(200) // e dá para tentar de novo
  })
})
