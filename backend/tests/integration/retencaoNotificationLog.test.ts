import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { aplicarRetencao, DIAS_MINIMOS_RETENCAO, type ConfigRetencao } from '../../src/services/manutencao/retencao'
import { executarManutencaoParticoes, type ConfigManutencao } from '../../src/services/manutencao/manutencaoParticoes'

/**
 * L1.6 / DL6 — retenção do `NotificationLog` (12 meses) dentro do job do N-11, contra Postgres REAL (banco próprio: apaga linhas em massa). Mesmas guardas do resto da retenção:
 * `RETENTION_ENABLED` desliga tudo, `DRY_RUN` só conta, piso de 30 dias, DELETE em lotes, e nada fora da allowlist é tocado.
 */
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('ret_nl')
})

const DIA = 86_400_000
const cfg = (extra: Partial<ConfigRetencao> = {}): ConfigRetencao => ({ habilitada: true, dryRun: false, ocppMessageDias: 365, meterSampleDias: 365, webhookEventDias: 180, notificationLogDias: 365, ...extra })

describe('retenção do NotificationLog (L1.6, DL6)', () => {
  let userId: string
  let seq = 0

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { role: 'DRIVER', name: 'Retencao NL', email: `ret-nl-${randomUUID().slice(0, 6)}@example.com` } })
    userId = u.id
  }, 60_000)
  afterAll(async () => {
    await prisma.$disconnect()
    await banco.descartar()
  })
  beforeEach(async () => {
    await prisma.notificationLog.deleteMany()
  })

  /** Insere `n` linhas com `createdAt` a `diasAtras` dias (SQL direto: `createdAt` não é editável pela API normal). */
  async function inserir(n: number, diasAtras: number, status: 'SENT' | 'PENDING' | 'FAILED' | 'SKIPPED' = 'SENT'): Promise<void> {
    const quando = new Date(Date.now() - diasAtras * DIA)
    const base = `ret-${++seq}-`
    const sentAt = status === 'SENT' ? quando : null
    const motivo = status === 'FAILED' || status === 'SKIPPED' ? 'MOTIVO_TESTE' : null
    await prisma.$executeRaw`
      INSERT INTO "NotificationLog" ("id","userId","type","channel","entityId","status","statusReason","sentAt","createdAt","updatedAt")
      SELECT ${base} || g, ${userId}, 'SESSION_COMPLETED'::"NotificationType", 'EMAIL'::"NotificationDeliveryChannel", ${base} || g, ${status}::"NotificationStatus", ${motivo}, ${sentAt}, ${quando}, ${quando}
        FROM generate_series(1, ${n}) AS g`
  }
  const total = () => prisma.notificationLog.count()

  it('DESLIGADA (padrão): nada é apagado, nem lido — o relatório volta vazio', async () => {
    await inserir(5, 400)
    const r = await aplicarRetencao(prisma, cfg({ habilitada: false }))
    expect(r).toMatchObject({ habilitada: false, acoes: [], erros: [] })
    expect(await total()).toBe(5)
  })

  it('DRY-RUN: conta o que sairia e NÃO apaga nada', async () => {
    await inserir(7, 400)
    await inserir(3, 10)
    const r = await aplicarRetencao(prisma, cfg({ dryRun: true }))
    expect(r.acoes.find((a) => a.tabela === 'NotificationLog')).toEqual({ tabela: 'NotificationLog', acao: 'dry_run_notification_log', linhas: 7 })
    expect(await total()).toBe(10)
  })

  it('LIGADA: apaga o que passou de 12 meses (qualquer estado) e preserva o resto; a fronteira de 365 dias vale ao dia', async () => {
    await inserir(4, 400, 'SENT')
    await inserir(2, 400, 'PENDING') // estado preso há mais de 12 meses também sai: é lixo, não um fato vivo
    await inserir(2, 400, 'FAILED')
    await inserir(1, 366, 'SKIPPED')
    await inserir(3, 364) // dentro do prazo
    await inserir(5, 1)
    const r = await aplicarRetencao(prisma, cfg())
    expect(r.erros).toEqual([])
    expect(r.acoes.find((a) => a.tabela === 'NotificationLog')).toEqual({ tabela: 'NotificationLog', acao: 'notification_log_deleted', linhas: 9 })
    expect(await total()).toBe(8)
    expect(await prisma.notificationLog.count({ where: { createdAt: { lt: new Date(Date.now() - 365 * DIA) } } })).toBe(0)
  })

  it('DELETE EM LOTES: mais de um lote (1000) numa rodada, e uma 2ª rodada seguida não dá erro nem apaga a mais', async () => {
    await inserir(2_500, 500)
    await inserir(6, 5)
    const r1 = await aplicarRetencao(prisma, cfg())
    expect(r1.erros).toEqual([])
    expect(r1.acoes.find((a) => a.tabela === 'NotificationLog')).toMatchObject({ acao: 'notification_log_deleted', linhas: 2_500 })
    expect(await total()).toBe(6)
    const r2 = await aplicarRetencao(prisma, cfg())
    expect(r2.erros).toEqual([])
    expect(r2.acoes.find((a) => a.tabela === 'NotificationLog')).toMatchObject({ acao: 'notification_log_deleted', linhas: 0 })
    expect(await total()).toBe(6)
  }, 60_000)

  it('PISO: prazo menor que 30 dias vira 30 (um 0/1 digitado errado não limpa a tabela)', async () => {
    expect(DIAS_MINIMOS_RETENCAO).toBe(30)
    await inserir(3, 10)
    await inserir(2, 40)
    const r = await aplicarRetencao(prisma, cfg({ notificationLogDias: 1 }))
    expect(r.acoes.find((a) => a.tabela === 'NotificationLog')).toMatchObject({ linhas: 2 })
    expect(await total()).toBe(3)
    await aplicarRetencao(prisma, cfg({ notificationLogDias: 0 }))
    expect(await total()).toBe(3)
  })

  it('config SEM o campo (instalação antiga) usa 365 dias — não 0, não NaN', async () => {
    await inserir(2, 400)
    await inserir(2, 100)
    const { notificationLogDias: _ignorado, ...semCampo } = cfg()
    const r = await aplicarRetencao(prisma, semCampo)
    expect(r.acoes.find((a) => a.tabela === 'NotificationLog')).toMatchObject({ linhas: 2 })
    expect(await total()).toBe(2)
  })

  it('só toca NotificationLog: preferências, usuário e as demais tabelas ficam intactas', async () => {
    await prisma.notificationPreference.upsert({ where: { userId }, create: { userId, lowBalanceEnabled: false }, update: { lowBalanceEnabled: false } })
    await inserir(3, 800)
    await aplicarRetencao(prisma, cfg())
    expect(await prisma.notificationPreference.count({ where: { userId } })).toBe(1)
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1)
  })

  it('pelo job inteiro (executarManutencaoParticoes): a etapa roda junto das outras, sob a MESMA guarda RETENTION_ENABLED', async () => {
    await inserir(3, 500)
    const manut = (habilitada: boolean): ConfigManutencao => ({ mesesAFrente: 3, retencao: cfg({ habilitada }) })
    await executarManutencaoParticoes(prisma, manut(false))
    expect(await total()).toBe(3) // desligada: nada
    const r = await executarManutencaoParticoes(prisma, manut(true))
    expect(r.retencao.acoes.some((a) => a.tabela === 'NotificationLog' && a.acao === 'notification_log_deleted')).toBe(true)
    expect(await total()).toBe(0)
  }, 60_000)
})
