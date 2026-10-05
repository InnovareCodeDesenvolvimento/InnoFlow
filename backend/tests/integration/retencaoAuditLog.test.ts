import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { logger } from '../../src/lib/logger'
import * as escritorAuditoria from '../../src/services/auditoria/writeAuditLog'
import { CHAVE_LOCK_MANUTENCAO } from '../../src/services/manutencao/particoes'
import { aplicarRetencao, AUDIT_LOG_DIAS_PADRAO, DIAS_MINIMOS_AUDIT_LOG, prazoAuditLogEfetivo, type ConfigRetencao } from '../../src/services/manutencao/retencao'
import { executarManutencaoParticoes, type ConfigManutencao } from '../../src/services/manutencao/manutencaoParticoes'

/**
 * Retenção do `AuditLog` (decisão do dono, 05/10/2026: 24 MESES, purga automática) dentro do job do N-11, contra Postgres REAL e em banco PRÓPRIO (apaga linhas em massa; as outras suítes
 * criam linhas de auditoria "velhas" no banco compartilhado e não podem ser varridas no meio do teste). O trigger append-only NÃO foi alterado — alguns testes abaixo existem só para provar isso.
 */
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('ret_al')
})

const DIA = 86_400_000
const cfg = (extra: Partial<ConfigRetencao> = {}): ConfigRetencao => ({ habilitada: true, dryRun: false, ocppMessageDias: 365, meterSampleDias: 365, webhookEventDias: 180, notificationLogDias: 365, auditLogDias: 730, ...extra })
const PII_EMAIL = 'motorista-pii-ral@example.com'
const PII_IP = '203.0.113.77'

describe('retenção do AuditLog (24 meses, purga automática)', () => {
  let seq = 0
  let userId: string

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { role: 'DRIVER', name: 'Retencao AL', email: `ret-al-${Math.random().toString(36).slice(2, 8)}@example.com` } })
    userId = u.id
  }, 60_000)
  afterAll(async () => {
    await prisma.$disconnect()
    await banco.descartar()
  })
  beforeEach(async () => {
    await limparAuditoria()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Limpeza de teste, e SÓ aqui: o trigger bloqueia o DELETE de linha recente (é o objeto do teste), então a faxina entre casos desliga o trigger de DELETE DENTRO de uma transação
   * (DDL transacional: se algo falhar, o trigger volta sozinho) num banco descartável. O comportamento do trigger é provado nos testes de "trigger intacto", com o trigger ligado.
   */
  async function limparAuditoria(): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_restrict_delete')
      await tx.$executeRawUnsafe('DELETE FROM "AuditLog"')
      await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_restrict_delete')
    })
  }

  /** `n` linhas com `occurredAt = quando + g ms` (SQL cru: o Prisma aceitaria, mas queremos expressões relativas ao `now()` do BANCO, o mesmo relógio do trigger). */
  async function inserir(n: number, quando: Prisma.Sql, tag: string): Promise<void> {
    const base = `ral-${++seq}-`
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "AuditLog" ("id","occurredAt","actorUserId","actorRole","actorEmail","actorName","action","outcome","httpStatus","method","path","ipAddress")
      SELECT ${base} || g, ${quando} + (g * interval '1 millisecond'), ${tag}, 'ADMIN'::"AuditActorRole", ${PII_EMAIL}, 'Nome Pessoal Motorista', 'OTHER'::"AuditAction", 'SUCCESS'::"AuditOutcome", 200, 'GET', '/teste', ${PII_IP}
        FROM generate_series(1, ${n}) AS g`)
  }
  const mesesAtras = (m: number) => Prisma.sql`now() - (${m}::int * interval '1 month')`
  const cont = (tag: string) => prisma.auditLog.count({ where: { actorUserId: tag } })
  const total = () => prisma.auditLog.count()
  const linhasDaPurga = () => prisma.auditLog.findMany({ where: { actorRole: 'SYSTEM', actionDetail: 'retention:audit_log_purged' } })
  const acaoAudit = (r: Awaited<ReturnType<typeof aplicarRetencao>>) => r.acoes.find((a) => a.tabela === 'AuditLog')

  it('DESLIGADA (padrão): não apaga nada, não lê, não grava linha — o relatório volta vazio', async () => {
    await inserir(5, mesesAtras(30), 'velha')
    const r = await aplicarRetencao(prisma, cfg({ habilitada: false }))
    expect(r).toMatchObject({ habilitada: false, acoes: [], erros: [] })
    expect(await total()).toBe(5)
  })

  it('DRY-RUN: só conta o que sairia; não apaga e NÃO grava a linha da purga', async () => {
    await inserir(7, mesesAtras(30), 'velha')
    await inserir(3, mesesAtras(12), 'recente')
    const r = await aplicarRetencao(prisma, cfg({ dryRun: true }))
    expect(r.erros).toEqual([])
    expect(acaoAudit(r)).toEqual({ tabela: 'AuditLog', acao: 'dry_run_audit_log', linhas: 7 })
    expect(await total()).toBe(10)
    expect(await linhasDaPurga()).toHaveLength(0)
  })

  it('LIGADA: apaga só o que passou de 24 meses; preserva as recentes e os dois lados da fronteira exata (±1 min do corte do banco)', async () => {
    await inserir(4, mesesAtras(30), 'velha')
    await inserir(2, Prisma.sql`now() - interval '24 months' - interval '1 minute'`, 'logo-alem') // 1 min mais velha que o corte: sai
    await inserir(3, Prisma.sql`now() - interval '24 months' + interval '1 minute'`, 'logo-dentro') // 1 min mais nova: fica
    await inserir(5, mesesAtras(12), 'recente')
    await inserir(4, Prisma.sql`now()`, 'agora')
    const r = await aplicarRetencao(prisma, cfg())
    expect(r.erros).toEqual([])
    expect(acaoAudit(r)).toEqual({ tabela: 'AuditLog', acao: 'audit_log_deleted', linhas: 6 })
    expect(await cont('velha')).toBe(0)
    expect(await cont('logo-alem')).toBe(0)
    expect(await cont('logo-dentro')).toBe(3)
    expect(await cont('recente')).toBe(5)
    expect(await cont('agora')).toBe(4)
  })

  it('a purga se registra: UMA linha SYSTEM/OTHER com contagem, intervalo e corte — sem PII, mais nova que o piso (não é apagada na mesma rodada) e idempotente na 2ª rodada', async () => {
    await inserir(6, mesesAtras(30), 'velha')
    await inserir(2, mesesAtras(3), 'recente')
    const r1 = await aplicarRetencao(prisma, cfg())
    expect(acaoAudit(r1)).toMatchObject({ acao: 'audit_log_deleted', linhas: 6 })
    const registros = await linhasDaPurga()
    expect(registros).toHaveLength(1)
    const reg = registros[0]
    expect(reg).toMatchObject({ actorRole: 'SYSTEM', action: 'OTHER', outcome: 'SUCCESS', entityType: 'AuditLog', actionDetail: 'retention:audit_log_purged' })
    const ch = reg.changes as Record<string, { to: unknown }>
    expect(ch.deletedCount.to).toBe(6)
    expect(ch.batches.to).toBe(1)
    expect(ch.retentionDays.to).toBe(730)
    expect(new Date(ch.oldestDeletedAt.to as string).getTime()).toBeLessThanOrEqual(new Date(ch.newestDeletedAt.to as string).getTime())
    expect(new Date(ch.newestDeletedAt.to as string).getTime()).toBeLessThan(new Date(ch.cutoff.to as string).getTime())
    // sem PII: nem o e-mail, nem o nome, nem o IP das linhas apagadas aparecem na linha da purga
    const texto = JSON.stringify(reg)
    expect(texto).not.toContain(PII_EMAIL)
    expect(texto).not.toContain('Nome Pessoal')
    expect(texto).not.toContain(PII_IP)
    // mais nova que o piso => sobrevive a qualquer rodada de agora
    expect(reg.occurredAt.getTime()).toBeGreaterThan(Date.now() - 60_000)

    // 2ª rodada seguida: nada a apagar, NENHUMA linha nova (não vira "uma linha por dia dizendo 0"), e a linha da purga anterior continua lá
    const r2 = await aplicarRetencao(prisma, cfg())
    expect(r2.erros).toEqual([])
    expect(acaoAudit(r2)).toEqual({ tabela: 'AuditLog', acao: 'audit_log_deleted', linhas: 0 })
    expect(await linhasDaPurga()).toHaveLength(1)
    expect(await total()).toBe(2 + 1)
  })

  it('log estruturado `retention_audit_deleted` com a contagem — e o conteúdo apagado NUNCA vai para o log', async () => {
    await inserir(4, mesesAtras(30), 'velha')
    const info = vi.spyOn(logger, 'info')
    await aplicarRetencao(prisma, cfg())
    const chamadas = info.mock.calls.map((c) => c[0] as Record<string, unknown>)
    const evento = chamadas.find((o) => o && typeof o === 'object' && o.event === 'retention_audit_deleted')
    expect(evento).toMatchObject({ tabela: 'AuditLog', linhas: 4, lotes: 1, dias: 730, limitadaPorRodada: false })
    const tudo = JSON.stringify(info.mock.calls)
    expect(tudo).not.toContain(PII_EMAIL)
    expect(tudo).not.toContain('Nome Pessoal')
    expect(tudo).not.toContain(PII_IP)
  })

  it('EM LOTES: 2.500 linhas velhas saem em 3 lotes (1000+1000+500) numa rodada; as 6 recentes ficam; a 2ª rodada não apaga a mais', async () => {
    await inserir(2_500, mesesAtras(30), 'velha')
    await inserir(6, mesesAtras(5), 'recente')
    const r1 = await aplicarRetencao(prisma, cfg())
    expect(r1.erros).toEqual([])
    expect(acaoAudit(r1)).toMatchObject({ acao: 'audit_log_deleted', linhas: 2_500 })
    expect(((await linhasDaPurga())[0].changes as Record<string, { to: unknown }>).batches.to).toBe(3)
    expect(await cont('velha')).toBe(0)
    expect(await cont('recente')).toBe(6)
    const r2 = await aplicarRetencao(prisma, cfg())
    expect(acaoAudit(r2)).toMatchObject({ linhas: 0 })
    expect(await total()).toBe(6 + 1)
  }, 60_000)

  it('TETO de lotes por rodada (aqui 2 lotes = 2.000 linhas; em produção 200 lotes): apaga as MAIS ANTIGAS primeiro, avisa `limitadaPorRodada` e a rodada seguinte termina o serviço', async () => {
    await inserir(2_300, mesesAtras(30), 'velha')
    const info = vi.spyOn(logger, 'info')
    const r1 = await aplicarRetencao(prisma, cfg({ auditLogMaxLotes: 2 }))
    expect(r1.erros).toEqual([])
    expect(acaoAudit(r1)).toMatchObject({ acao: 'audit_log_deleted', linhas: 2_000 })
    expect(info.mock.calls.map((c) => c[0] as Record<string, unknown>).find((o) => o?.event === 'retention_audit_deleted')).toMatchObject({ limitadaPorRodada: true, lotes: 2 })
    expect(await cont('velha')).toBe(300)
    // ORDER BY occurredAt: o que sobrou é estritamente mais novo que tudo o que saiu
    const ch = (await linhasDaPurga())[0].changes as Record<string, { to: unknown }>
    const [{ minimo }] = await prisma.$queryRaw<{ minimo: Date }[]>(Prisma.sql`SELECT min("occurredAt") AS "minimo" FROM "AuditLog" WHERE "actorUserId" = 'velha'`)
    expect(minimo.getTime()).toBeGreaterThan(new Date(ch.newestDeletedAt.to as string).getTime())

    const r2 = await aplicarRetencao(prisma, cfg({ auditLogMaxLotes: 2 }))
    expect(acaoAudit(r2)).toMatchObject({ acao: 'audit_log_deleted', linhas: 300 })
    expect(await cont('velha')).toBe(0)
    expect(await linhasDaPurga()).toHaveLength(2) // uma por execução que apagou algo
  })

  it('prazo MAIOR que 24 meses é respeitado (1095 dias): 30 meses ficam, 40 meses saem', async () => {
    await inserir(3, mesesAtras(30), 'trinta')
    await inserir(2, mesesAtras(40), 'quarenta')
    const r = await aplicarRetencao(prisma, cfg({ auditLogDias: 1095 }))
    expect(acaoAudit(r)).toMatchObject({ linhas: 2 })
    expect(await cont('trinta')).toBe(3)
    expect(await cont('quarenta')).toBe(0)
  })

  it('PISO: prazo configurado abaixo de 24 meses (30, 1, 0, NaN, ausente) NUNCA apaga linha dentro do piso — e não dá erro', async () => {
    await inserir(3, mesesAtras(18), 'dezoito')
    await inserir(2, mesesAtras(25), 'vinte-e-cinco')
    for (const dias of [30, 1, 0, Number.NaN, -5, undefined]) {
      const r = await aplicarRetencao(prisma, cfg({ auditLogDias: dias }))
      expect(r.erros, `auditLogDias=${String(dias)}`).toEqual([])
      expect(await cont('dezoito')).toBe(3)
    }
    expect(await cont('vinte-e-cinco')).toBe(0) // o piso (24 meses) vale; o que passou dele sai
  })

  it('prazoAuditLogEfetivo: nunca abaixo de 730, inválido cai no padrão', () => {
    expect(DIAS_MINIMOS_AUDIT_LOG).toBe(730)
    expect(AUDIT_LOG_DIAS_PADRAO).toBe(730)
    expect(prazoAuditLogEfetivo(undefined)).toBe(730)
    expect(prazoAuditLogEfetivo(Number.NaN)).toBe(730)
    expect(prazoAuditLogEfetivo(Number.POSITIVE_INFINITY)).toBe(730)
    expect(prazoAuditLogEfetivo(0)).toBe(730)
    expect(prazoAuditLogEfetivo(-100)).toBe(730)
    expect(prazoAuditLogEfetivo(729)).toBe(730)
    expect(prazoAuditLogEfetivo(730)).toBe(730)
    expect(prazoAuditLogEfetivo(1095.9)).toBe(1095)
  })

  it('janela com 29/02 (24 meses = 731 dias): o corte é limitado ao do BANCO — nenhuma linha dentro do piso entra no DELETE (senão o trigger derrubaria o lote)', async () => {
    // Simula a janela bissexta de forma determinística: `agora` 5 dias à frente faz "agora - 730 dias" ficar 5 dias MAIS NOVO que `now() - 24 months` do banco,
    // exatamente o que acontece quando um 29/02 cai na janela (730 d no código x 731 d no calendário). Sem o LEAST, a linha de 24 meses - 2 dias entraria no lote e o trigger recusaria.
    await inserir(3, Prisma.sql`now() - interval '24 months' + interval '2 days'`, 'dentro-do-piso')
    await inserir(2, Prisma.sql`now() - interval '24 months' + interval '12 hours'`, 'dentro-do-piso')
    await inserir(2, Prisma.sql`now() - interval '24 months' + interval '1 minute'`, 'dentro-do-piso')
    await inserir(2, mesesAtras(30), 'velha')
    const r = await aplicarRetencao(prisma, cfg(), new Date(Date.now() + 5 * DIA))
    expect(r.erros).toEqual([])
    expect(acaoAudit(r)).toMatchObject({ acao: 'audit_log_deleted', linhas: 2 })
    expect(await cont('dentro-do-piso')).toBe(7)
    expect(await cont('velha')).toBe(0)
  })

  it('tabelas vizinhas intactas: WalletEntry (inclusive antiga), PaymentIntent, User, Wallet e NotificationLog não são tocados', async () => {
    const wallet = await prisma.wallet.create({ data: { userId } })
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "WalletEntry" ("id","walletId","type","amountCents","balanceAfterCents","referenceType","description","createdAt")
      VALUES ('ral-we-antiga', ${wallet.id}, 'ADJUSTMENT_CREDIT'::"WalletEntryType", 500, 500, 'MANUAL', 'antiga', now() - interval '40 months'),
             ('ral-we-nova', ${wallet.id}, 'ADJUSTMENT_CREDIT'::"WalletEntryType", 500, 1000, 'MANUAL', 'nova', now())`)
    await prisma.paymentIntent.create({ data: { purpose: 'WALLET_TOPUP_PIX', userId, amountRequestedCents: 1000, status: 'CREATED', provider: 'CIELO_PIX', walletId: wallet.id } })
    await inserir(5, mesesAtras(40), 'velha')
    const antes = await Promise.all([prisma.walletEntry.count(), prisma.paymentIntent.count(), prisma.user.count(), prisma.wallet.count(), prisma.notificationLog.count(), prisma.debt.count(), prisma.chargingSession.count()])
    const r = await aplicarRetencao(prisma, cfg())
    expect(r.erros).toEqual([])
    expect(acaoAudit(r)).toMatchObject({ linhas: 5 })
    const depois = await Promise.all([prisma.walletEntry.count(), prisma.paymentIntent.count(), prisma.user.count(), prisma.wallet.count(), prisma.notificationLog.count(), prisma.debt.count(), prisma.chargingSession.count()])
    expect(depois).toEqual(antes)
    expect(antes[0]).toBe(2)
    expect(await prisma.walletEntry.count({ where: { id: 'ral-we-antiga' } })).toBe(1)
  })

  it('ATOMICIDADE: se o registro da purga falhar, NADA é apagado (a transação inteira volta) e o erro aparece no relatório', async () => {
    await inserir(5, mesesAtras(30), 'velha')
    vi.spyOn(escritorAuditoria, 'writeAuditLog').mockRejectedValueOnce(new Error('falha simulada ao gravar a auditoria'))
    const r = await aplicarRetencao(prisma, cfg())
    expect(r.erros.some((e) => e.startsWith('AuditLog:'))).toBe(true)
    expect(await cont('velha')).toBe(5)
    expect(await linhasDaPurga()).toHaveLength(0)
    // a rodada seguinte (sem a falha) conclui normalmente
    const r2 = await aplicarRetencao(prisma, cfg())
    expect(r2.erros).toEqual([])
    expect(await cont('velha')).toBe(0)
    expect(await linhasDaPurga()).toHaveLength(1)
  })

  it('ATOMICIDADE (como): a linha da purga é gravada com o cliente DA TRANSAÇÃO do DELETE, não com o cliente global (que a deixaria commitada mesmo se o DELETE voltasse)', async () => {
    await inserir(3, mesesAtras(30), 'velha')
    const real = escritorAuditoria.writeAuditLog
    let cliente: unknown
    vi.spyOn(escritorAuditoria, 'writeAuditLog').mockImplementation(async (input, tx) => {
      cliente = tx
      return real(input, tx)
    })
    await aplicarRetencao(prisma, cfg())
    expect(cliente).toBeDefined()
    expect(cliente).not.toBe(prisma)
    expect(await linhasDaPurga()).toHaveLength(1)
  })

  it('LOCK consultivo: com outra execução segurando o lock da manutenção, a etapa PULA (nada apagado, nada registrado)', async () => {
    await inserir(4, mesesAtras(30), 'velha')
    let liberar!: () => void
    const segurando = new Promise<void>((r) => (liberar = r))
    let travou!: () => void
    const pronto = new Promise<void>((r) => (travou = r))
    const outra = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${CHAVE_LOCK_MANUTENCAO}))`)
        travou()
        await segurando
      },
      { timeout: 60_000 },
    )
    await pronto
    try {
      const r = await aplicarRetencao(prisma, cfg())
      expect(r.erros).toEqual([])
      expect(acaoAudit(r)).toMatchObject({ acao: 'audit_log_skipped', motivo: 'sem_lock' })
      expect(await cont('velha')).toBe(4)
      expect(await linhasDaPurga()).toHaveLength(0)
    } finally {
      liberar()
      await outra
    }
    const r2 = await aplicarRetencao(prisma, cfg())
    expect(acaoAudit(r2)).toMatchObject({ acao: 'audit_log_deleted', linhas: 4 })
  })

  it('pelo job inteiro (executarManutencaoParticoes): desligada não toca; ligada purga, sob a MESMA guarda RETENTION_ENABLED', async () => {
    await inserir(3, mesesAtras(30), 'velha')
    const manut = (habilitada: boolean): ConfigManutencao => ({ mesesAFrente: 3, retencao: cfg({ habilitada }) })
    await executarManutencaoParticoes(prisma, manut(false))
    expect(await cont('velha')).toBe(3)
    const r = await executarManutencaoParticoes(prisma, manut(true))
    expect(r.retencao.acoes.some((a) => a.tabela === 'AuditLog' && a.acao === 'audit_log_deleted')).toBe(true)
    expect(await cont('velha')).toBe(0)
  }, 60_000)

  describe('o trigger append-only NÃO foi afrouxado (provado com o trigger ligado)', () => {
    it('DELETE de linha recente ou dentro do piso continua bloqueado — inclusive ±1 min da fronteira e em lote misto (o comando inteiro volta)', async () => {
      await inserir(2, Prisma.sql`now()`, 'agora')
      await inserir(2, Prisma.sql`now() - interval '24 months' + interval '1 minute'`, 'logo-dentro')
      await inserir(2, mesesAtras(30), 'velha')
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "actorUserId" = 'agora'`)).rejects.toThrow(/piso de retenção/)
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "actorUserId" = 'logo-dentro'`)).rejects.toThrow(/piso de retenção/)
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "actorUserId" IN ('velha','agora')`)).rejects.toThrow(/piso de retenção/)
      expect(await total()).toBe(6)
    })

    it('UPDATE continua bloqueado SEMPRE (recente e velha) e TRUNCATE também', async () => {
      await inserir(1, Prisma.sql`now()`, 'agora')
      await inserir(1, mesesAtras(30), 'velha')
      await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "actorName" = 'x' WHERE "actorUserId" = 'agora'`)).rejects.toThrow(/append-only/)
      await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "actorName" = 'x' WHERE "actorUserId" = 'velha'`)).rejects.toThrow(/append-only/)
      await expect(prisma.$executeRawUnsafe('TRUNCATE "AuditLog"')).rejects.toThrow(/append-only/)
      expect(await total()).toBe(2)
    })

    it('a função do trigger segue com a regra original (`>= now() - interval \'24 months\'`) e os 3 triggers continuam habilitados', async () => {
      const [f] = await prisma.$queryRaw<{ def: string }[]>(Prisma.sql`SELECT pg_get_functiondef('audit_log_append_only'::regproc) AS "def"`)
      expect(f.def).toContain(`OLD."occurredAt" >= now() - interval '24 months'`)
      expect(f.def).toContain("TG_OP = 'UPDATE'")
      const trg = await prisma.$queryRaw<{ tgname: string; tgenabled: string }[]>(Prisma.sql`
        SELECT tgname::text AS "tgname", tgenabled::text AS "tgenabled" FROM pg_trigger WHERE tgrelid = '"AuditLog"'::regclass AND NOT tgisinternal ORDER BY 1`)
      expect(trg).toEqual([
        { tgname: 'audit_log_no_truncate', tgenabled: 'O' },
        { tgname: 'audit_log_no_update', tgenabled: 'O' },
        { tgname: 'audit_log_restrict_delete', tgenabled: 'O' },
      ])
    })
  })
})
