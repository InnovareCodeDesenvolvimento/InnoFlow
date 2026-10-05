import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { uniqueSuffix } from './helpers/fixtures'
import { SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { criarCenarioEstorno } from './helpers/estornoFixture'

/**
 * L1.8, item 4 — `GET /api/admin/reports/payments?tid=|authorizationCode=|proofOfSale=`: achar a venda de um chargeback pelos identificadores da adquirente.
 * A CONCILIAÇÃO NÃO MUDA: o bloco `reconciliation` é do período/escopo, nunca do filtro, e estorno/chargeback continuam informativos (provado antes/depois).
 */
describe('relatório de pagamentos — filtros tid / authorizationCode / proofOfSale (L1.8)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const periodo = () => ({ from: new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10), to: new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10) })
  const relatorio = (token: string, query: Record<string, unknown>) => request(app).get('/api/admin/reports/payments').query({ ...periodo(), pageSize: 100, ...query }).set(auth(token))

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('acha a venda por Tid, por código de autorização e por NSU (igualdade exata), e só ela; identificador desconhecido -> lista vazia; combina com provider', async () => {
    const a = await criarCenarioEstorno(suffix, 'rel-a', { paga: 'CARD', totalCents: 1000 })
    const b = await criarCenarioEstorno(suffix, 'rel-b', { paga: 'CARD', totalCents: 700, tenant: a.tenant, admin: a.admin })
    const ia = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: a.intentId! } })
    const ib = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: b.intentId! } })
    await prisma.paymentIntent.update({ where: { id: ib.id }, data: { cieloAuthorizationCode: '654321' } })

    for (const [nome, valor] of [['tid', ia.cieloTid], ['proofOfSale', ia.cieloProofOfSale]] as const) {
      const res = await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, [nome]: valor })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.items.map((i: { id: string }) => i.id), nome).toEqual([ia.id])
      expect(res.body.meta.total ?? res.body.meta.totalItems ?? res.body.items.length).toBeGreaterThanOrEqual(1)
    }
    // o código de autorização do fixture é o mesmo ('123456') em toda venda; a b ganhou outro: filtra a certa
    const porCodigo = await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, authorizationCode: '654321' })
    expect(porCodigo.body.items.map((i: { id: string }) => i.id)).toEqual([ib.id])

    expect((await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, tid: 'tid-que-nao-existe' })).body.items).toEqual([])
    expect((await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, tid: ia.cieloTid!.slice(0, 5) })).body.items).toEqual([]) // exato, não "começa com"
    const pix = await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, tid: ia.cieloTid, provider: 'CIELO_PIX' })
    expect(pix.status, JSON.stringify(pix.body)).toBe(200)
    expect(pix.body.items).toEqual([])
    expect((await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, tid: ia.cieloTid, provider: 'CIELO_CARD' })).body.items).toHaveLength(1)
    // espaços nas pontas e valor vazio (formulário) são tolerados; vazio = sem filtro
    expect((await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, tid: `  ${ia.cieloTid}  ` })).body.items).toHaveLength(1)
    expect((await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, tid: '' })).body.items.length).toBeGreaterThanOrEqual(2)
  })

  it('REGRESSÃO: provider e status SOZINHOS filtram (antes respondiam 500: o enum do Postgres não compara com texto)', async () => {
    const a = await criarCenarioEstorno(suffix, 'rel-enum', { paga: 'CARD' })
    const q = { operatorId: a.tenant.operatorId }
    const porProvider = await relatorio(a.admin.token, { ...q, provider: 'CIELO_CARD' })
    expect(porProvider.status, JSON.stringify(porProvider.body)).toBe(200)
    expect(porProvider.body.items.map((i: { id: string }) => i.id)).toContain(a.intentId)
    const porStatus = await relatorio(a.admin.token, { ...q, status: 'CAPTURED' })
    expect(porStatus.status, JSON.stringify(porStatus.body)).toBe(200)
    expect(porStatus.body.items.map((i: { id: string }) => i.id)).toContain(a.intentId)
    expect((await relatorio(a.admin.token, { ...q, status: 'DENIED' })).body.items.map((i: { id: string }) => i.id)).not.toContain(a.intentId)
  })

  it('valor acima de 64 caracteres -> 400; o texto vai como PARÂMETRO (aspas/SQL no valor não quebram nem injetam)', async () => {
    const a = await criarCenarioEstorno(suffix, 'rel-inj', { paga: 'CARD' })
    expect((await relatorio(a.admin.token, { tid: 'x'.repeat(65) })).status).toBe(400)
    const inj = await relatorio(a.admin.token, { operatorId: a.tenant.operatorId, tid: "x' OR '1'='1" })
    expect(inj.status).toBe(200)
    expect(inj.body.items).toEqual([])
  })

  it('o ESCOPO do operador vale: OPERATOR não acha a venda de OUTRO operador pelo Tid; o dono dela acha', async () => {
    const dono = await criarCenarioEstorno(suffix, 'rel-dono', { paga: 'CARD' })
    const outro = await criarCenarioEstorno(suffix, 'rel-outro', { paga: 'CARD' })
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: dono.intentId! } })
    const meu = await relatorio(dono.tenant.staff.token, { tid: intent.cieloTid })
    expect(meu.status).toBe(200)
    expect(meu.body.items.map((i: { id: string }) => i.id)).toEqual([intent.id])
    const alheio = await relatorio(outro.tenant.staff.token, { tid: intent.cieloTid })
    expect(alheio.status).toBe(200)
    expect(alheio.body.items).toEqual([])
  })

  it('CONCILIAÇÃO: o bloco reconciliation é o MESMO com e sem filtro, e idêntico antes/depois de estorno (carteira), chargeback e dívida de chargeback; difference segue 0', async () => {
    const c = await criarCenarioEstorno(suffix, 'rel-conc', { paga: 'CARD', totalCents: 1000 })
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId! } })
    const q = { operatorId: c.tenant.operatorId }
    const antes = (await relatorio(c.admin.token, q)).body.reconciliation as Record<string, number>
    expect(antes.differenceCents).toBe(0)
    expect(((await relatorio(c.admin.token, { ...q, tid: intent.cieloTid })).body.reconciliation as Record<string, number>)).toEqual(antes) // o filtro é só da lista

    const refund = await request(app).post(`/api/admin/sessions/${c.sessionId}/refunds`).set(auth(c.admin.token)).send({ amountCents: 300, reason: 'Estorno de teste na carteira', destination: 'WALLET', currentPassword: SENHA_ADMIN_TESTE })
    expect(refund.status, JSON.stringify(refund.body)).toBe(201)
    const cb = await request(app).post(`/api/admin/payments/${c.intentId}/chargebacks`).set(auth(c.admin.token)).send({ amountCents: 1000, notifiedAt: new Date(Date.now() - 3600_000).toISOString(), caseReference: 'CASO-REL-1' })
    expect(cb.status, JSON.stringify(cb.body)).toBe(201)
    const perdido = await request(app).patch(`/api/admin/chargebacks/${cb.body.chargebackId}`).set(auth(c.admin.token)).send({ outcome: 'LOST', debtPolicy: 'CREATE_DEBT', currentPassword: SENHA_ADMIN_TESTE })
    expect(perdido.status, JSON.stringify(perdido.body)).toBe(200)

    const depois = (await relatorio(c.admin.token, q)).body.reconciliation as Record<string, number>
    for (const campo of ['revenueCents', 'cardCapturedCents', 'cardCapturePendingCents', 'walletDebitCents', 'debtSettledCents', 'openDebtCents', 'expectedCents', 'accountedCents', 'differenceCents']) {
      expect(depois[campo], campo).toBe(antes[campo])
    }
    expect(depois.differenceCents).toBe(0)
    // e a linha da venda segue CAPTURED (estorno/chargeback são informativos)
    const lista = await relatorio(c.admin.token, { ...q, tid: intent.cieloTid })
    expect(lista.body.items[0]).toMatchObject({ id: intent.id, status: 'CAPTURED', amountCapturedCents: 1000 })
  })
})
