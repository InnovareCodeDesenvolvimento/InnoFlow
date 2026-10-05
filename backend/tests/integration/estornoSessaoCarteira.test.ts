import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// Só para provar o FAIL-CLOSED: com a flag ligada, gravar a auditoria falha. Fora disso é a função real.
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
import { createUser, uniqueSuffix, waitFor } from './helpers/fixtures'
import { SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { criarAdminComSenha, criarCenarioEstorno, saldoDaCarteira } from './helpers/estornoFixture'
import { traduzirErroDoBancoDeEstorno } from '../../src/services/estornos/tipos'
import { getPaymentsReconciliation } from '../../src/api/services/paymentsService'

/**
 * L1.8, item 1 — estorno de uma sessão para a CARTEIRA: `POST /api/admin/sessions/:id/refunds` (destination WALLET), ADMIN-only com step-up de senha. Postgres + Redis reais.
 */
describe('estorno de sessão na carteira (L1.8)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const MOTIVO = 'Motorista contestou o consumo, devolvido ao saldo'
  const corpo = (over: Record<string, unknown> = {}) => ({ amountCents: 400, reason: MOTIVO, destination: 'WALLET', currentPassword: SENHA_ADMIN_TESTE, ...over })
  const url = (sessionId: string) => `/api/admin/sessions/${sessionId}/refunds`

  beforeEach(() => {
    auditoriaFalha.ligada = false
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const reversoes = (sessionId: string) => prisma.paymentReversal.findMany({ where: { chargingSessionId: sessionId, kind: 'REFUND' } })
  const lancamentosRefund = (walletId: string) => prisma.walletEntry.findMany({ where: { walletId, type: 'REFUND' } })

  it('credita o saldo na MESMA transação: WalletEntry REFUND (referenceType CHARGING_SESSION) + PaymentReversal WALLET/CONFIRMED com resolvedAt e walletEntryId; extrato "Estorno da recarga de dd/mm"', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-ok', { totalCents: 1000 })
    const saldoAntes = await saldoDaCarteira(c.walletId)
    expect(saldoAntes).toBe(0)

    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toEqual({ refundId: expect.any(String), status: 'CONFIRMED' })

    const [entrada] = await lancamentosRefund(c.walletId)
    expect(entrada).toMatchObject({ type: 'REFUND', amountCents: 400, balanceAfterCents: 400, referenceType: 'CHARGING_SESSION', referenceId: c.sessionId, createdBy: c.admin.id })
    expect(entrada!.description).toMatch(/^Estorno da recarga de \d{2}\/\d{2}$/)
    expect(await saldoDaCarteira(c.walletId)).toBe(400)

    const [reversao] = await reversoes(c.sessionId)
    expect(reversao).toMatchObject({
      id: res.body.refundId,
      kind: 'REFUND',
      status: 'CONFIRMED',
      destination: 'WALLET',
      amountCents: 400,
      walletEntryId: entrada!.id,
      paymentIntentId: null,
      userId: c.driver.id,
      createdByUserId: c.admin.id,
      resolvedByUserId: c.admin.id,
    })
    expect(reversao!.resolvedAt).toBeInstanceOf(Date)
    expect(reversao!.reason).toBe(MOTIVO)
  })

  it('auditoria REFUND gravada (fail-closed) com ator e requisição — SEM o texto do motivo, SEM a senha e SEM nome/e-mail do motorista', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-audit', { totalCents: 1000 })
    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ reason: 'MOTIVO-SECRETO-QUE-NAO-PODE-IR-PARA-A-AUDITORIA' }))
    expect(res.status).toBe(201)

    const linhas = await waitFor(async () => {
      const l = await prisma.auditLog.findMany({ where: { entityId: res.body.refundId, action: 'REFUND' } })
      return l.length > 0 ? l : null
    })
    expect(linhas).toHaveLength(1) // o middleware genérico NÃO duplica (skip)
    const linha = linhas[0]!
    expect(linha).toMatchObject({ actorUserId: c.admin.id, outcome: 'SUCCESS', httpStatus: 201, entityType: 'PaymentReversal', actionDetail: 'refund:wallet', method: 'POST' })
    const dump = JSON.stringify(linha.changes)
    expect(dump).toContain('"amountCents"')
    expect(dump).not.toContain('MOTIVO-SECRETO')
    expect(dump).not.toContain(SENHA_ADMIN_TESTE)
    expect(dump).not.toContain(c.driver.email)
    expect(dump).not.toContain(c.driver.name)
  })

  it('a identidade de conciliação do período fecha IGUAL antes e depois do estorno (estorno é informativo)', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-conc', { totalCents: 1000 })
    const janela = { from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 24 * 3600_000) }
    const escopo = { operatorId: c.tenant.operatorId, siteId: undefined, chargePointId: undefined } as never
    const antes = await getPaymentsReconciliation(escopo, janela as never, true)
    expect(antes.differenceCents).toBe(0)

    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 1000 }))
    expect(res.status).toBe(201)

    const depois = await getPaymentsReconciliation(escopo, janela as never, true)
    for (const campo of ['revenueCents', 'walletDebitCents', 'cardCapturedCents', 'cardCapturePendingCents', 'debtSettledCents', 'openDebtCents', 'expectedCents', 'accountedCents', 'differenceCents'] as const) {
      expect(depois[campo], campo).toBe(antes[campo])
    }
    expect(depois.differenceCents).toBe(0)
    expect(depois.cardRefundedCents).toBe(antes.cardRefundedCents) // estorno na carteira não entra no estorno de cartão
  })

  it('respeita o teto: parcial, total e 1 centavo a mais -> 409 AMOUNT_EXCEEDS_REFUNDABLE com o que ainda resta; nada é gravado na recusa', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-teto', { totalCents: 1000 })
    expect((await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 600 }))).status).toBe(201)

    const passou = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 401 }))
    expect(passou.status).toBe(409)
    expect(passou.body).toMatchObject({ code: 'AMOUNT_EXCEEDS_REFUNDABLE', details: { refundableCents: 400 } })
    expect(await reversoes(c.sessionId)).toHaveLength(1)
    expect(await lancamentosRefund(c.walletId)).toHaveLength(1)

    expect((await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 400 }))).status).toBe(201) // exatamente o que resta
    const alemDoTotal = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 1 }))
    expect(alemDoTotal.status).toBe(409)
    expect(alemDoTotal.body.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')
    expect(await saldoDaCarteira(c.walletId)).toBe(1000)
  })

  it('CONCORRÊNCIA: 8 estornos de 300 ao mesmo tempo numa sessão de 1000 -> exatamente 3 entram (R$ 9,00), 5 recebem 409, saldo e razão batem', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-conc8', { totalCents: 1000 })
    // 8 ADMINS diferentes: o step-up reserva vagas por USUÁRIO (5 simultâneas) — 8 pedidos do MESMO admin esbarrariam nele (429) antes de chegar à regra do estorno.
    const admins = await Promise.all(Array.from({ length: 8 }, (_, i) => criarAdminComSenha(suffix, `w-conc8-${i}`)))
    const respostas = await Promise.all(admins.map((a) => request(app).post(url(c.sessionId)).set(auth(a.token)).send(corpo({ amountCents: 300 }))))
    const codigos = respostas.map((r) => r.status).sort()
    expect(codigos, JSON.stringify(respostas.map((r) => r.body))).toEqual([201, 201, 201, 409, 409, 409, 409, 409])
    for (const r of respostas.filter((x) => x.status === 409)) expect(r.body.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')

    expect(await reversoes(c.sessionId)).toHaveLength(3)
    expect(await lancamentosRefund(c.walletId)).toHaveLength(3)
    expect(await saldoDaCarteira(c.walletId)).toBe(900)
    const soma = (await reversoes(c.sessionId)).reduce((s, r) => s + r.amountCents, 0)
    expect(soma).toBe(900)
  })

  it('SESSION_NOT_BILLED: sessão sem custo, ainda aberta, ou que virou dívida (nada foi pago) -> 409, nada gravado', async () => {
    const semCusto = await criarCenarioEstorno(suffix, 'nb-null', { totalNulo: true })
    const aberta = await criarCenarioEstorno(suffix, 'nb-open', { status: 'STARTED' })
    const soDivida = await criarCenarioEstorno(suffix, 'nb-debt', { paga: 'NENHUMA', totalCents: 500 })
    await prisma.debt.create({ data: { userId: soDivida.driver.id, operatorId: soDivida.tenant.operatorId, chargingSessionId: soDivida.sessionId, amountCents: 500, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE' } })

    for (const c of [semCusto, aberta, soDivida]) {
      const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 100 }))
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.code).toBe('SESSION_NOT_BILLED')
      expect(await reversoes(c.sessionId)).toHaveLength(0)
      expect(await lancamentosRefund(c.walletId)).toHaveLength(0)
    }
  })

  it('sessão paga com CARTÃO também pode ser estornada na carteira (saída recomendada) — e isso NÃO mexe em amountRefundedCents do intent', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-card', { paga: 'CARD', totalCents: 800 })
    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 800 }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await saldoDaCarteira(c.walletId)).toBe(800)
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId! } })
    expect(intent.amountRefundedCents).toBe(0)
    expect(intent.status).toBe('CAPTURED')
  })

  it('STEP-UP: sem a senha -> 400; senha errada -> 403 INVALID_CURRENT_PASSWORD ANTES de qualquer regra (nada criado) e DENIED com action REFUND na auditoria', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-step', { totalCents: 1000 })
    const { currentPassword: _s, ...semSenha } = corpo()
    const r400 = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(semSenha)
    expect(r400.status).toBe(400)
    expect(r400.body.code).toBe('VALIDATION_ERROR')

    const errada = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ currentPassword: 'SenhaErrada#Marcador-9f3a' }))
    expect(errada.status).toBe(403)
    expect(errada.body.code).toBe('INVALID_CURRENT_PASSWORD')
    // mesmo com valor absurdo (que daria 409): a senha vem primeiro
    const erradaEValorAbsurdo = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ currentPassword: 'SenhaErrada#Marcador-9f3a', amountCents: 9_999_999 }))
    expect(erradaEValorAbsurdo.status).toBe(403)
    expect(await reversoes(c.sessionId)).toHaveLength(0)
    expect(await lancamentosRefund(c.walletId)).toHaveLength(0)

    const negada = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: c.admin.id, action: 'REFUND', outcome: 'DENIED' } }))
    expect(negada.actionDetail).toBe('stepup_failed')
    expect(JSON.stringify(negada)).not.toContain('SenhaErrada#Marcador-9f3a')
  })

  it('ADMIN-only: OPERATOR e DRIVER recebem 403, sem token 401 — e nada é criado', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-papel', { totalCents: 1000 })
    const operador = c.tenant.staff
    const motorista = await createUser({ role: 'DRIVER', label: 'drv-papel', suffix })
    for (const token of [operador.token, motorista.token, c.driver.token]) {
      const res = await request(app).post(url(c.sessionId)).set(auth(token)).send(corpo())
      expect(res.status).toBe(403)
    }
    expect((await request(app).post(url(c.sessionId)).send(corpo())).status).toBe(401)
    expect(await reversoes(c.sessionId)).toHaveLength(0)
    expect(await lancamentosRefund(c.walletId)).toHaveLength(0)
  })

  it('404 SESSION_NOT_FOUND para sessão inexistente', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-404', {})
    const res = await request(app).post(url('cuid-que-nao-existe')).set(auth(c.admin.token)).send(corpo())
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('SESSION_NOT_FOUND')
  })

  it('validação (400 VALIDATION_ERROR, nada criado): valor zero/negativo/fracionário/enorme, motivo curto/com quebra de linha, destino inválido, campo desconhecido e portalReference com WALLET', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-val', { totalCents: 1000 })
    const invalidos: Array<Record<string, unknown>> = [
      { amountCents: 0 },
      { amountCents: -5 },
      { amountCents: 10.5 },
      { amountCents: '400' },
      { amountCents: 10_000_001 },
      { reason: 'curto' },
      { reason: 'motivo com\nquebra de linha' },
      { destination: 'PIX' },
      { userId: 'outro' }, // o pagador nunca vem do cliente (.strict())
      { portalReference: 'ref-123' }, // referência do portal só vale para CARD_VIA_PORTAL
    ]
    for (const over of invalidos) {
      const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo(over))
      expect(res.status, JSON.stringify(over)).toBe(400)
      expect(res.body.code).toBe('VALIDATION_ERROR')
    }
    expect(await reversoes(c.sessionId)).toHaveLength(0)
    expect(await lancamentosRefund(c.walletId)).toHaveLength(0)
  })

  it('FAIL-CLOSED: se a auditoria não grava, o estorno INTEIRO reverte (sem lançamento, sem registro, saldo intacto) -> 500', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-failclosed', { totalCents: 1000 })
    auditoriaFalha.ligada = true
    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo())
    auditoriaFalha.ligada = false
    expect(res.status).toBe(500)
    expect(await reversoes(c.sessionId)).toHaveLength(0)
    expect(await lancamentosRefund(c.walletId)).toHaveLength(0)
    expect(await saldoDaCarteira(c.walletId)).toBe(0)
  })

  it('conta do motorista EXCLUÍDA (LGPD): estorno para a carteira é recusado (409 DRIVER_ACCOUNT_DELETED) — não se credita saldo em conta anonimizada', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-excluida', { totalCents: 1000 })
    await prisma.$executeRaw`UPDATE "User" SET "name" = 'Conta excluída', "email" = ${`excluido+${c.driver.id}@anon.invalid`}, "passwordHash" = NULL, "googleSub" = NULL, "cpf" = NULL, "phone" = NULL, "active" = false, "sessionsValidAfter" = now(), "deletedAt" = now() WHERE id = ${c.driver.id}`
    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo())
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe('DRIVER_ACCOUNT_DELETED')
    expect(await lancamentosRefund(c.walletId)).toHaveLength(0)
  })

  it('GET /api/admin/sessions/:id/refunds mostra cobrado, estornado e o que ainda resta (ADMIN-only)', async () => {
    const c = await criarCenarioEstorno(suffix, 'w-get', { totalCents: 1000 })
    await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 250 }))
    const res = await request(app).get(url(c.sessionId)).set(auth(c.admin.token))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sessionId: c.sessionId, billedCents: 1000, refundedCents: 250, refundableCents: 750 })
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0]).toMatchObject({ destination: 'WALLET', status: 'CONFIRMED', amountCents: 250 })
    expect((await request(app).get(url(c.sessionId)).set(auth(c.tenant.staff.token))).status).toBe(403)
  })

  it('REDE DE SEGURANÇA do banco: se algo passar da regra da aplicação, o trigger recusa e o erro vira 409 estruturado (não 500)', async () => {
    const cartao = await criarCenarioEstorno(suffix, 'w-trigger', { paga: 'CARD', totalCents: 500 })
    const erro = await prisma.paymentReversal
      .create({ data: { kind: 'REFUND', status: 'PENDING_CONFIRMATION', destination: 'CARD_VIA_PORTAL', chargingSessionId: cartao.sessionId, paymentIntentId: cartao.intentId, userId: cartao.driver.id, amountCents: 501, reason: 'direto no banco', createdByUserId: cartao.admin.id } })
      .then(() => null, (e: unknown) => e)
    expect(erro).not.toBeNull()
    const traduzido = traduzirErroDoBancoDeEstorno(erro)
    expect(traduzido).toMatchObject({ statusCode: 409, code: 'AMOUNT_EXCEEDS_REFUNDABLE' })
    expect(await reversoes(cartao.sessionId)).toHaveLength(0)
  })
})
