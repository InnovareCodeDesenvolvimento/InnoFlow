import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { createQueue } from '../../src/worker/queues'
import { vigiarPrazoChargebacks, MAX_AVISOS_POR_RODADA } from '../../src/services/estornos/vigiarPrazoChargebacks'
import { scheduleVigiarPrazoChargebacks, VIGIAR_PRAZO_CHARGEBACKS_QUEUE_NAME } from '../../src/worker/jobs/vigiarPrazoChargebacksJob'
import { sanitizarContexto } from '../../src/core/alertas/contexto'
import { severidadeDoEvento } from '../../src/core/alertas/severidade'
import { uniqueSuffix } from './helpers/fixtures'
import { SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { criarCenarioEstorno, type CenarioEstorno } from './helpers/estornoFixture'

/**
 * L1.8 — vigia diária do PRAZO DE RESPOSTA do chargeback. As suítes rodam em paralelo no MESMO banco e a vigia varre a tabela inteira: o teste só afirma sobre os chargebacks que ELE criou
 * (filtra pelo `chargebackId`). O relógio da vigia é injetado (`agora`). Postgres + Redis reais.
 */
describe('vigia do prazo de resposta do chargeback (L1.8)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const DIA = 24 * 3600_000
  const alertas: Array<Record<string, unknown>> = []

  beforeEach(() => {
    alertas.length = 0
    const original = logger.warn.bind(logger) as (...a: unknown[]) => void
    vi.spyOn(logger, 'warn').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'object' && args[0]) alertas.push(args[0] as Record<string, unknown>)
      original(...args)
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())
  // A vigia varre a tabela INTEIRA e tem teto de avisos por rodada: chargebacks OPEN com prazo próximo/vencido deixados por execuções anteriores (o banco do teste é reaproveitado)
  // empurrariam os desta suíte para fora do teto. Por isso a suíte ENCERRA os que criou (desfecho LOST pela própria API; sem dívida).
  const criados: Array<{ token: string; id: string }> = []
  afterAll(async () => {
    for (const { token, id } of criados) await request(app).patch(`/api/admin/chargebacks/${id}`).set(auth(token)).send({ outcome: 'LOST', currentPassword: SENHA_ADMIN_TESTE })
    await prisma.$disconnect()
    redis.disconnect()
  })

  /** Chargeback OPEN com o prazo dado (relativo ao relógio injetado `agora`). `notifiedAt` sempre antes do prazo (CHECK do banco). */
  async function chargebackComPrazo(label: string, prazo: Date | null, base?: CenarioEstorno): Promise<{ c: CenarioEstorno; id: string }> {
    const c = await criarCenarioEstorno(suffix, label, { paga: 'CARD', totalCents: 1000, tenant: base?.tenant, admin: base?.admin })
    const notifiedAt = new Date(Math.min(Date.now() - 3600_000, (prazo?.getTime() ?? Date.now()) - 3600_000))
    const res = await request(app)
      .post(`/api/admin/payments/${c.intentId}/chargebacks`)
      .set(auth(c.admin.token))
      .send({ amountCents: 1000, notifiedAt: notifiedAt.toISOString(), caseReference: `CASO-${label}-${suffix}`.slice(0, 120), ...(prazo ? { responseDeadline: prazo.toISOString() } : {}) })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    criados.push({ token: c.admin.token, id: res.body.chargebackId as string })
    return { c, id: res.body.chargebackId as string }
  }
  const meusAlertas = (ids: string[]) => alertas.filter((a) => typeof a.alert === 'string' && a.alert.startsWith('chargeback_response_deadline') && ids.includes(a.chargebackId as string))

  it('PRAZO PRÓXIMO (≤ 3 dias): chargeback_response_deadline_near com chargebackId, paymentIntentId e diasRestantes (arredondado PARA CIMA); fronteira de 3 dias inclusa, 3 dias + 1 min fora', async () => {
    const agora = new Date()
    const base = await criarCenarioEstorno(suffix, 'p-base', { paga: 'NENHUMA' })
    const em2h = await chargebackComPrazo('p-2h', new Date(agora.getTime() + 2 * 3600_000), base)
    const em2d = await chargebackComPrazo('p-2d', new Date(agora.getTime() + 2 * DIA), base)
    const em3d = await chargebackComPrazo('p-3d', new Date(agora.getTime() + 3 * DIA), base)
    const alem = await chargebackComPrazo('p-3d1m', new Date(agora.getTime() + 3 * DIA + 60_000), base)
    const longe = await chargebackComPrazo('p-10d', new Date(agora.getTime() + 10 * DIA), base)

    const r = await vigiarPrazoChargebacks(agora)
    expect(r.proximos).toBeGreaterThanOrEqual(3)
    const mine = meusAlertas([em2h.id, em2d.id, em3d.id, alem.id, longe.id])
    const por = (id: string) => mine.filter((a) => a.chargebackId === id)
    expect(por(em2h.id)).toHaveLength(1)
    expect(por(em2h.id)[0]).toMatchObject({ alert: 'chargeback_response_deadline_near', paymentIntentId: em2h.c.intentId, diasRestantes: 1 })
    expect(por(em2d.id)[0]).toMatchObject({ alert: 'chargeback_response_deadline_near', diasRestantes: 2 })
    expect(por(em3d.id)[0]).toMatchObject({ alert: 'chargeback_response_deadline_near', diasRestantes: 3 })
    expect(por(alem.id)).toHaveLength(0)
    expect(por(longe.id)).toHaveLength(0)
  })

  it('PRAZO VENCIDO: chargeback_response_deadline_overdue com diasDeAtraso (0 = venceu há menos de 24 h); nunca os dois alertas para o mesmo chargeback', async () => {
    const agora = new Date()
    const base = await criarCenarioEstorno(suffix, 'v-base', { paga: 'NENHUMA' })
    const ha1h = await chargebackComPrazo('v-1h', new Date(agora.getTime() - 3600_000), base)
    const ha2d = await chargebackComPrazo('v-2d', new Date(agora.getTime() - 2 * DIA - 3600_000), base)

    await vigiarPrazoChargebacks(agora)
    const mine = meusAlertas([ha1h.id, ha2d.id])
    expect(mine.filter((a) => a.chargebackId === ha1h.id)).toEqual([expect.objectContaining({ alert: 'chargeback_response_deadline_overdue', paymentIntentId: ha1h.c.intentId, diasDeAtraso: 0 })])
    expect(mine.filter((a) => a.chargebackId === ha2d.id)).toEqual([expect.objectContaining({ alert: 'chargeback_response_deadline_overdue', diasDeAtraso: 2 })])
  })

  it('NÃO avisa: chargeback SEM prazo cadastrado; chargeback JÁ RESOLVIDO (WON/LOST) com prazo próximo; o desfecho silencia o vencido', async () => {
    const agora = new Date()
    const base = await criarCenarioEstorno(suffix, 'n-base', { paga: 'NENHUMA' })
    const semPrazo = await chargebackComPrazo('n-sem', null, base)
    const ganho = await chargebackComPrazo('n-won', new Date(agora.getTime() + 1 * DIA), base)
    const vencidoDepoisResolvido = await chargebackComPrazo('n-lost', new Date(agora.getTime() - 1 * DIA), base)
    const aberto = await chargebackComPrazo('n-aberto', new Date(agora.getTime() + 1 * DIA), base)

    for (const [cb, outcome] of [[ganho, 'WON'], [vencidoDepoisResolvido, 'LOST']] as const) {
      const res = await request(app).patch(`/api/admin/chargebacks/${cb.id}`).set(auth(cb.c.admin.token)).send({ outcome, currentPassword: SENHA_ADMIN_TESTE })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    }

    await vigiarPrazoChargebacks(agora)
    const mine = meusAlertas([semPrazo.id, ganho.id, vencidoDepoisResolvido.id, aberto.id])
    expect(mine.map((a) => a.chargebackId)).toEqual([aberto.id]) // só o aberto
  })

  it('CONTEXTO sem PII: o alerta tem só ids opacos e a contagem de dias; passa pela allowlist do e-mail/WhatsApp com os campos úteis; severidade CRITICO nos dois', async () => {
    const agora = new Date()
    const { c, id } = await chargebackComPrazo('c-ctx', new Date(agora.getTime() + 1 * DIA))
    await vigiarPrazoChargebacks(agora)
    const [a] = meusAlertas([id])
    expect(Object.keys(a!).filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k)).sort()).toEqual(['alert', 'chargebackId', 'diasRestantes', 'paymentIntentId'])
    const dump = JSON.stringify(a)
    for (const pii of [c.driver.email, c.driver.name, c.driver.id, 'Titular']) expect(dump).not.toContain(pii)

    expect(sanitizarContexto(a)).toMatchObject({ chargebackId: id, paymentIntentId: c.intentId, diasRestantes: 1 })
    expect(sanitizarContexto({ alert: 'chargeback_response_deadline_overdue', chargebackId: id, diasDeAtraso: 4 })).toMatchObject({ diasDeAtraso: 4 })
    expect(severidadeDoEvento('chargeback_response_deadline_near', 40)).toBe('CRITICO')
    expect(severidadeDoEvento('chargeback_response_deadline_overdue', 40)).toBe('CRITICO')
  })

  it('só LÊ: rodar a vigia não altera nenhum chargeback; e rodar de novo no dia seguinte reavisa (a janela é diária, o desfecho é que silencia)', async () => {
    const agora = new Date()
    const { id } = await chargebackComPrazo('r-leitura', new Date(agora.getTime() + 2 * DIA))
    const antes = await prisma.paymentReversal.findUniqueOrThrow({ where: { id } })
    await vigiarPrazoChargebacks(agora)
    expect(await prisma.paymentReversal.findUniqueOrThrow({ where: { id } })).toEqual(antes)
    await vigiarPrazoChargebacks(new Date(agora.getTime() + DIA))
    expect(meusAlertas([id]).map((a) => a.diasRestantes)).toEqual([2, 1])
  })

  it('TETO por rodada (anti-tempestade): passou do teto, saem os MAIS URGENTES (prazo mais antigo) e 1 log de resumo avisa do corte; sem candidatos não lança', async () => {
    expect(MAX_AVISOS_POR_RODADA).toBeGreaterThanOrEqual(10)
    // Relógio em 2020: só os chargebacks DESTE teste (prazos em jan/2020) são candidatos, mesmo com o banco compartilhado.
    const agora = new Date('2020-01-01T12:00:00Z')
    const base = await criarCenarioEstorno(suffix, 't-base', { paga: 'NENHUMA' })
    const d4 = await chargebackComPrazo('t-d4', new Date('2020-01-04T00:00:00Z'), base)
    const d2 = await chargebackComPrazo('t-d2', new Date('2020-01-02T00:00:00Z'), base)
    const d3 = await chargebackComPrazo('t-d3', new Date('2020-01-03T00:00:00Z'), base)
    const r = await vigiarPrazoChargebacks(agora, { maxAvisos: 2 })
    expect(r).toEqual({ proximos: 2, vencidos: 0, avisosEmitidos: 2 })
    expect(meusAlertas([d2.id, d3.id, d4.id]).map((a) => a.chargebackId)).toEqual([d2.id, d3.id]) // do mais urgente para o menos, e o 3º ficou de fora
    expect(alertas.some((a) => a.alert === undefined && a.limite === 2 && a.avisosEmitidos === 2)).toBe(true)
    await expect(vigiarPrazoChargebacks(new Date('1990-01-01T00:00:00Z'))).resolves.toEqual({ proximos: 0, vencidos: 0, avisosEmitidos: 0 })
  })

  it('o job está AGENDADO 1x por dia (upsertJobScheduler, idempotente em reinícios) — a janela diária é o dedupe', async () => {
    await scheduleVigiarPrazoChargebacks()
    await scheduleVigiarPrazoChargebacks()
    const fila = createQueue(VIGIAR_PRAZO_CHARGEBACKS_QUEUE_NAME)
    try {
      const agendadores = await fila.getJobSchedulers()
      const meu = agendadores.filter((s) => s.key === 'vigiar-prazo-chargebacks-scan' || s.id === 'vigiar-prazo-chargebacks-scan')
      expect(meu).toHaveLength(1)
      expect(Number(meu[0]!.every)).toBe(86_400_000)
      await fila.removeJobScheduler('vigiar-prazo-chargebacks-scan')
    } finally {
      await fila.close()
    }
  })
})
