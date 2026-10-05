import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// A rota NUNCA fala com a Cielo (DL8): o spy abaixo prova que `getPagamentoPort` não é chamado ao REGISTRAR/CANCELAR uma devolução. O job recebe um `port` falso por parâmetro.
const portSpy = vi.hoisted(() => ({ chamadas: 0 }))
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

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import type { PagamentoPort, ResultadoConsultaPagamento } from '../../src/core/pagamentos/porta'
import { confirmarEstornosPortal } from '../../src/services/estornos/confirmarEstornosPortal'
import { createQueue, CONFIRMAR_ESTORNOS_PORTAL_QUEUE_NAME } from '../../src/worker/queues'
import { scheduleConfirmarEstornosPortal } from '../../src/worker/jobs/confirmarEstornosPortalJob'
import { uniqueSuffix, waitFor } from './helpers/fixtures'
import { SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { criarCenarioEstorno, type CenarioEstorno } from './helpers/estornoFixture'

/**
 * L1.8, item 2 — devolução pelo PORTAL DA CIELO: registro assistido (`PENDING_CONFIRMATION`), cancelamento do registro e o job que reconsulta a venda.
 * As respostas da Cielo aqui são FIXTURES INVENTADOS (nunca vimos a consulta de um estorno parcial) — por isso o que se prova é a REGRA conservadora:
 * só confirma o inequívoco; o desconhecido é "não confirmado". Postgres + Redis reais.
 */
describe('devolução no portal da Cielo (L1.8)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const MOTIVO = 'Cobrança em duplicidade, devolvido no portal'
  const corpo = (over: Record<string, unknown> = {}) => ({ amountCents: 1000, reason: MOTIVO, destination: 'CARD_VIA_PORTAL', portalReference: 'PORTAL-ABC-1', currentPassword: SENHA_ADMIN_TESTE, ...over })
  const url = (sessionId: string) => `/api/admin/sessions/${sessionId}/refunds`
  const cancelUrl = (id: string) => `/api/admin/refunds/${id}/cancel`
  const alertas: Array<Record<string, unknown>> = []

  beforeEach(() => {
    portSpy.chamadas = 0
    alertas.length = 0
    const original = logger.warn.bind(logger) as (...a: unknown[]) => void
    vi.spyOn(logger, 'warn').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'object' && args[0]) alertas.push(args[0] as Record<string, unknown>)
      original(...args)
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const reversoes = (sessionId: string) => prisma.paymentReversal.findMany({ where: { chargingSessionId: sessionId, kind: 'REFUND' }, orderBy: { createdAt: 'asc' } })
  const intentDe = (c: CenarioEstorno) => prisma.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId! } })
  const alertasDe = (nome: string, intentId: string) => alertas.filter((a) => a.alert === nome && a.paymentIntentId === intentId)

  async function registrar(c: CenarioEstorno, over: Record<string, unknown> = {}) {
    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo(over))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.refundId as string
  }

  /** Porta falsa SÓ com `consultar` (leitura). Qualquer outro método que o job tentasse usar (void/captura) explode. */
  function portFalso(statusBruto: number | null, extra: Partial<ResultadoConsultaPagamento> = {}) {
    const consultar = vi.fn(async (providerPaymentId: string): Promise<ResultadoConsultaPagamento> => ({
      providerPaymentId,
      merchantOrderId: 'x',
      status: 'CAPTURED',
      returnCode: '00',
      amountAuthorizedCents: 1000,
      amountCapturedCents: 1000,
      identificadores: { tid: null, authorizationCode: null, proofOfSale: null },
      statusBruto,
      ...extra,
    }))
    const proibido = () => {
      throw new Error('o job NUNCA pode chamar isto (DL8: nenhuma API nossa devolve dinheiro)')
    }
    const port = new Proxy({ consultar }, { get: (alvo, prop) => (prop in alvo ? (alvo as never)[prop] : proibido) }) as unknown as PagamentoPort
    return { port, consultar }
  }

  it('REGISTRO: 201 PENDING_CONFIRMATION, vinculado à venda, referência do portal gravada, SEM resolvedAt e SEM tocar na Cielo nem na carteira nem em amountRefundedCents', async () => {
    const c = await criarCenarioEstorno(suffix, 'p-reg', { paga: 'CARD', totalCents: 1000 })
    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toEqual({ refundId: expect.any(String), status: 'PENDING_CONFIRMATION' })

    const [r] = await reversoes(c.sessionId)
    expect(r).toMatchObject({ status: 'PENDING_CONFIRMATION', destination: 'CARD_VIA_PORTAL', paymentIntentId: c.intentId, portalReference: 'PORTAL-ABC-1', amountCents: 1000, walletEntryId: null, resolvedAt: null, resolvedByUserId: null, userId: c.driver.id })
    expect((await intentDe(c)).amountRefundedCents).toBe(0) // só o que está CONFIRMADO conta
    expect(await prisma.walletEntry.count({ where: { walletId: c.walletId, type: 'REFUND' } })).toBe(0)
    expect(portSpy.chamadas).toBe(0)

    const linha = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: res.body.refundId, action: 'REFUND' } }))
    expect(linha).toMatchObject({ actionDetail: 'refund:card_via_portal', outcome: 'SUCCESS', actorUserId: c.admin.id })
  })

  it('o pendente SEGURA o teto: não dá para registrar de novo (nem na carteira) o que já está pendente; cancelar libera', async () => {
    const c = await criarCenarioEstorno(suffix, 'p-teto', { paga: 'CARD', totalCents: 1000 })
    const id = await registrar(c, { amountCents: 700 })
    const emCartao = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 400 }))
    expect(emCartao.status).toBe(409)
    expect(emCartao.body).toMatchObject({ code: 'AMOUNT_EXCEEDS_REFUNDABLE', details: { refundableCents: 300 } })
    const naCarteira = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 400, destination: 'WALLET', portalReference: undefined }))
    expect(naCarteira.status).toBe(409)
    expect(naCarteira.body).toMatchObject({ code: 'AMOUNT_EXCEEDS_REFUNDABLE', details: { refundableCents: 300 } }) // o pendente também conta no teto GERAL da sessão

    const cancelou = await request(app).post(cancelUrl(id)).set(auth(c.admin.token)).send({ currentPassword: SENHA_ADMIN_TESTE })
    expect(cancelou.status, JSON.stringify(cancelou.body)).toBe(200)
    expect(cancelou.body).toEqual({ refundId: id, status: 'CANCELLED' })
    expect((await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo({ amountCents: 1000 }))).status).toBe(201) // o teto voltou
  })

  it('devolução no cartão numa sessão paga com CARTEIRA -> 409 NO_CARD_PAYMENT (não há venda na Cielo); sem nada gravado', async () => {
    const c = await criarCenarioEstorno(suffix, 'p-semvenda', { paga: 'WALLET', totalCents: 1000 })
    const res = await request(app).post(url(c.sessionId)).set(auth(c.admin.token)).send(corpo())
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('NO_CARD_PAYMENT')
    expect(await reversoes(c.sessionId)).toHaveLength(0)
  })

  it('CANCELAR o registro: só o pendente no cartão; terminal/carteira -> 409 REFUND_NOT_CANCELLABLE; inexistente 404; senha errada 403; DRIVER/OPERATOR 403; auditoria REFUND', async () => {
    const c = await criarCenarioEstorno(suffix, 'p-cancel', { paga: 'CARD', totalCents: 1000 })
    const id = await registrar(c, { amountCents: 500 })

    expect((await request(app).post(cancelUrl(id)).set(auth(c.admin.token)).send({ currentPassword: 'SenhaErrada#Marcador-9f3a' })).status).toBe(403)
    expect((await request(app).post(cancelUrl(id)).set(auth(c.tenant.staff.token)).send({ currentPassword: SENHA_ADMIN_TESTE })).status).toBe(403)
    expect((await request(app).post(cancelUrl(id)).set(auth(c.driver.token)).send({ currentPassword: SENHA_ADMIN_TESTE })).status).toBe(403)
    expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')

    const ok = await request(app).post(cancelUrl(id)).set(auth(c.admin.token)).send({ currentPassword: SENHA_ADMIN_TESTE })
    expect(ok.status).toBe(200)
    const [r] = await reversoes(c.sessionId)
    expect(r).toMatchObject({ status: 'CANCELLED', resolvedByUserId: c.admin.id })
    expect(r!.resolvedAt).toBeInstanceOf(Date)

    const denovo = await request(app).post(cancelUrl(id)).set(auth(c.admin.token)).send({ currentPassword: SENHA_ADMIN_TESTE })
    expect(denovo.status).toBe(409)
    expect(denovo.body.code).toBe('REFUND_NOT_CANCELLABLE')
    expect((await request(app).post(cancelUrl('nao-existe')).set(auth(c.admin.token)).send({ currentPassword: SENHA_ADMIN_TESTE })).status).toBe(404)

    // estorno na CARTEIRA nunca é cancelável (o dinheiro já está no saldo)
    const w = await criarCenarioEstorno(suffix, 'p-cancel-w', { paga: 'WALLET', totalCents: 1000 })
    const idW = (await request(app).post(url(w.sessionId)).set(auth(w.admin.token)).send(corpo({ destination: 'WALLET', portalReference: undefined }))).body.refundId as string
    const wRes = await request(app).post(cancelUrl(idW)).set(auth(w.admin.token)).send({ currentPassword: SENHA_ADMIN_TESTE })
    expect(wRes.status).toBe(409)
    expect(wRes.body.code).toBe('REFUND_NOT_CANCELLABLE')

    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: id, action: 'REFUND', actionDetail: 'refund:cancelled' } }))
    expect(audit.outcome).toBe('SUCCESS')
    expect(portSpy.chamadas).toBe(0)
  })

  describe('job confirmarEstornosPortal (fixtures INVENTADOS da Cielo)', () => {
    it('Status 11 (Refunded) com o registro cobrindo o capturado -> CONFIRMED; o trigger sobe amountRefundedCents; auditoria SYSTEM; só LEITURA (consultar); idempotente', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-ok', { paga: 'CARD', totalCents: 1000 })
      const id = await registrar(c)
      const { port, consultar } = portFalso(11)

      const r1 = await confirmarEstornosPortal({ port })
      expect(r1).toMatchObject({ pulada: false })
      expect(r1.estornosConfirmados).toBeGreaterThanOrEqual(1)
      expect(consultar).toHaveBeenCalledWith((await intentDe(c)).cieloPaymentId)

      const [r] = await reversoes(c.sessionId)
      expect(r).toMatchObject({ id, status: 'CONFIRMED', resolvedByUserId: null })
      expect(r!.resolvedAt).toBeInstanceOf(Date)
      expect((await intentDe(c)).amountRefundedCents).toBe(1000)
      expect((await intentDe(c)).status).toBe('CAPTURED') // o status do intent NÃO muda (conciliação)

      const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: id, actionDetail: 'refund:auto_confirmed' } }))
      expect(audit).toMatchObject({ actorRole: 'SYSTEM', action: 'REFUND', outcome: 'SUCCESS' })

      // 2ª rodada: nada pendente desta venda -> não consulta de novo, nada muda
      consultar.mockClear()
      await confirmarEstornosPortal({ port })
      expect(consultar).not.toHaveBeenCalledWith((await intentDe(c)).cieloPaymentId)
      expect((await intentDe(c)).amountRefundedCents).toBe(1000)
    })

    it('Status 2 (ainda capturada) -> segue PENDENTE; amountRefundedCents intacto', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-ainda', { paga: 'CARD', totalCents: 1000 })
      await registrar(c)
      const { port } = portFalso(2)
      await confirmarEstornosPortal({ port })
      expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')
      expect((await intentDe(c)).amountRefundedCents).toBe(0)
    })

    it('ESTORNO PARCIAL registrado (400 de 1000) com a Cielo ainda em Status 2 -> NÃO confirma (a consulta de estorno parcial não é conhecida: o desconhecido nunca vira "confirmado")', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-parcial', { paga: 'CARD', totalCents: 1000 })
      await registrar(c, { amountCents: 400 })
      for (const status of [2, null, 99, 10, 1, 0, 12, 13, 3]) {
        const { port } = portFalso(status)
        await confirmarEstornosPortal({ port })
        expect((await reversoes(c.sessionId))[0]!.status, `status ${status}`).toBe('PENDING_CONFIRMATION')
      }
      expect((await intentDe(c)).amountRefundedCents).toBe(0)
    })

    it('Status 11 mas o ADMIN registrou só PARTE -> divergência: NÃO confirma e emite o alerta payment_refund_portal_status_mismatch', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-mismatch', { paga: 'CARD', totalCents: 1000 })
      await registrar(c, { amountCents: 400 })
      const { port } = portFalso(11)
      await confirmarEstornosPortal({ port })
      expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')
      expect(alertasDe('payment_refund_portal_status_mismatch', c.intentId!)).toHaveLength(1)
    })

    it('duas devoluções parciais que SOMAM o capturado + Status 11 -> confirma as duas', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-duas', { paga: 'CARD', totalCents: 1000 })
      await registrar(c, { amountCents: 400, portalReference: 'P-1' })
      await registrar(c, { amountCents: 600, portalReference: 'P-2' })
      await confirmarEstornosPortal({ port: portFalso(11).port })
      const todas = await reversoes(c.sessionId)
      expect(todas.map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED'])
      expect((await intentDe(c)).amountRefundedCents).toBe(1000)
    })

    it('falha da Cielo ao consultar (timeout/5xx) pula SÓ aquela venda: segue pendente, o job não lança, e conta a falha', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-falha', { paga: 'CARD', totalCents: 1000 })
      await registrar(c)
      const consultar = vi.fn(async () => {
        throw new Error('timeout simulado da Cielo')
      })
      const r = await confirmarEstornosPortal({ port: { consultar } as unknown as PagamentoPort })
      expect(r.falhasDeConsulta).toBeGreaterThanOrEqual(1)
      expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')
    })

    it('venda FORA da janela de consulta (~3 meses): NÃO reconsulta e alerta payment_refund_portal_pending_overdue (confirmação passa a ser humana)', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-janela', { paga: 'CARD', totalCents: 1000 })
      await prisma.paymentIntent.update({ where: { id: c.intentId! }, data: { capturedAt: new Date(Date.now() - 100 * 24 * 3600_000), authorizedAt: new Date(Date.now() - 100 * 24 * 3600_000) } })
      await registrar(c)
      const { port, consultar } = portFalso(11)
      await confirmarEstornosPortal({ port })
      expect(consultar).not.toHaveBeenCalledWith((await intentDe(c)).cieloPaymentId)
      expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')
      expect(alertasDe('payment_refund_portal_pending_overdue', c.intentId!)[0]).toMatchObject({ motivo: 'JANELA_DE_CONSULTA_EXPIRADA' })
    })

    it('pendente há mais que REFUND_PORTAL_PENDING_ALERT_HOURS e a Cielo ainda não mostra o estorno -> alerta AGUARDANDO_CONFIRMACAO (e mantém pendente)', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-overdue', { paga: 'CARD', totalCents: 1000 })
      await registrar(c)
      const cincoDiasDepois = new Date(Date.now() + 5 * 24 * 3600_000) // o relógio do job é injetável (createdAt é imutável no banco)
      const { port } = portFalso(2)
      await confirmarEstornosPortal({ port, agora: cincoDiasDepois })
      expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')
      expect(alertasDe('payment_refund_portal_pending_overdue', c.intentId!)[0]).toMatchObject({ motivo: 'AGUARDANDO_CONFIRMACAO' })
    })

    it('intent de OUTRO ambiente que o do gateway efetivo -> NÃO consulta (host errado)', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-amb', { paga: 'CARD', totalCents: 1000 })
      await prisma.paymentIntent.update({ where: { id: c.intentId! }, data: { environment: 'PRODUCTION' } })
      await registrar(c)
      const { port, consultar } = portFalso(11)
      await confirmarEstornosPortal({ port })
      expect(consultar).not.toHaveBeenCalledWith((await intentDe(c)).cieloPaymentId)
      expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')
    })

    it('CORRIDA: o ADMIN cancela o registro ENQUANTO o job consulta a Cielo -> o job NÃO sobrescreve (continua CANCELLED)', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-corrida', { paga: 'CARD', totalCents: 1000 })
      const id = await registrar(c)
      const { port, consultar } = portFalso(11)
      consultar.mockImplementationOnce(async (providerPaymentId: string) => {
        // durante a consulta de rede, o ADMIN cancela
        const cancelou = await request(app).post(cancelUrl(id)).set(auth(c.admin.token)).send({ currentPassword: SENHA_ADMIN_TESTE })
        expect(cancelou.status).toBe(200)
        return { providerPaymentId, merchantOrderId: 'x', status: 'CAPTURED', returnCode: '00', amountAuthorizedCents: 1000, amountCapturedCents: 1000, identificadores: { tid: null, authorizationCode: null, proofOfSale: null }, statusBruto: 11 }
      })
      await confirmarEstornosPortal({ port })
      expect((await reversoes(c.sessionId))[0]!.status).toBe('CANCELLED')
      expect((await intentDe(c)).amountRefundedCents).toBe(0)
    })

    it('INERTE sem credencial Cielo: sem `port` injetado (CI = Fake) a rodada é pulada, nada é lido da Cielo nem escrito, e não lança', async () => {
      const c = await criarCenarioEstorno(suffix, 'j-inerte', { paga: 'CARD', totalCents: 1000 })
      await registrar(c)
      const r = await confirmarEstornosPortal()
      expect(r.pulada).toBe(true)
      expect((await reversoes(c.sessionId))[0]!.status).toBe('PENDING_CONFIRMATION')
    })
  })

  it('o job está AGENDADO com baixa frequência (upsertJobScheduler, 30 min por padrão) — idempotente em reinícios', async () => {
    await scheduleConfirmarEstornosPortal()
    await scheduleConfirmarEstornosPortal()
    const fila = createQueue(CONFIRMAR_ESTORNOS_PORTAL_QUEUE_NAME)
    try {
      const agendadores = await fila.getJobSchedulers()
      const meu = agendadores.filter((s) => s.key === 'confirmar-estornos-portal-scan' || s.id === 'confirmar-estornos-portal-scan')
      expect(meu).toHaveLength(1)
      expect(Number(meu[0]!.every)).toBe(1_800_000)
      await fila.removeJobScheduler('confirmar-estornos-portal-scan')
    } finally {
      await fila.close()
    }
  })
})
