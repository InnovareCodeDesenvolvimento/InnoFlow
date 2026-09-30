import { afterAll, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * Garantias de BANCO do `AuditLog` (migration 20260917150000): append-only
 * por trigger, retenção de 24 meses para DELETE, colunas NOT NULL. Nunca
 * tinham rodado contra um Postgres real antes de 2026-09-19.
 *
 * Isolamento: cada teste cria a PRÓPRIA linha (actorUserId único) e só mexe
 * nela. Linhas RECENTES de auditoria são imortais por desenho (nem o afterAll
 * apaga) — só as com `occurredAt` > 24 meses são removíveis.
 */
describe('AuditLog — garantias de banco (trigger append-only + retenção 24 meses)', () => {
  const suffix = uniqueSuffix()
  const monthsAgo = (months: number, extraDays = 0) => {
    const d = new Date()
    d.setMonth(d.getMonth() - months)
    d.setDate(d.getDate() - extraDays)
    return d
  }
  const oldRowIds: string[] = []

  async function insertRow(label: string, occurredAt: Date = new Date()): Promise<string> {
    const row = await prisma.auditLog.create({
      data: {
        occurredAt,
        actorUserId: `audit-db-${suffix}-${label}`,
        actorRole: 'ADMIN',
        actorEmail: `audit-db-${suffix}-${label}@example.com`,
        actorName: `Audit DB ${label}`,
        action: 'OTHER',
        outcome: 'SUCCESS',
        httpStatus: 200,
        method: 'GET',
        path: '/teste',
      },
    })
    if (occurredAt.getTime() < monthsAgo(24).getTime()) oldRowIds.push(row.id)
    return row.id
  }

  afterAll(async () => {
    // Só as linhas > 24 meses podem ser apagadas (é justamente o que o trigger permite).
    await prisma.auditLog.deleteMany({ where: { id: { in: oldRowIds } } }).catch(() => undefined)
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('UPDATE é bloqueado — linha recente', async () => {
    const id = await insertRow('upd-recent')
    await expect(prisma.auditLog.update({ where: { id }, data: { httpStatus: 500 } })).rejects.toThrow(/append-only/)
    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id } })
    expect(after.httpStatus).toBe(200)
  })

  it('UPDATE é bloqueado SEMPRE — inclusive em linha já fora do piso de retenção (> 24 meses)', async () => {
    const id = await insertRow('upd-old', monthsAgo(30))
    await expect(prisma.auditLog.update({ where: { id }, data: { actorName: 'adulterado' } })).rejects.toThrow(/append-only/)
    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id } })
    expect(after.actorName).toBe('Audit DB upd-old')
  })

  it('DELETE de linha recente (agora) é bloqueado — dentro do piso de 24 meses', async () => {
    const id = await insertRow('del-now')
    await expect(prisma.auditLog.delete({ where: { id } })).rejects.toThrow(/piso de retenção/)
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1)
  })

  it('DELETE de linha com 23 meses (ainda dentro do piso) é bloqueado', async () => {
    const id = await insertRow('del-23m', monthsAgo(23))
    await expect(prisma.auditLog.delete({ where: { id } })).rejects.toThrow(/piso de retenção/)
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1)
  })

  it('DELETE de linha com mais de 24 meses é PERMITIDO (expurgo de retenção/LGPD)', async () => {
    const id = await insertRow('del-25m', monthsAgo(25))
    await prisma.auditLog.delete({ where: { id } })
    expect(await prisma.auditLog.count({ where: { id } })).toBe(0)
  })

  it('deleteMany misturando linha velha e recente: o comando inteiro falha (nada é apagado pela metade)', async () => {
    const oldId = await insertRow('mix-old', monthsAgo(26))
    const recentId = await insertRow('mix-recent')
    await expect(prisma.auditLog.deleteMany({ where: { id: { in: [oldId, recentId] } } })).rejects.toThrow(/piso de retenção/)
    // A transação do comando reverte tudo — a linha velha continua lá.
    expect(await prisma.auditLog.count({ where: { id: { in: [oldId, recentId] } } })).toBe(2)
  })

  describe('colunas NOT NULL (o banco recusa, não só o TypeScript)', () => {
    // INSERT cru: o Prisma nem deixaria omitir/`null`ar estes campos no client
    // tipado, então a garantia de BANCO só se prova por SQL direto.
    //
    // REGRESSÃO fechada (Íris, 30/09/2026, achada rodando contra Postgres real
    // pela 1ª vez desde a F5.1/Cronos): `httpStatus`/`method`/`path` SAÍRAM
    // desta lista — a migration `20260930120100_payment_gateway_foundation`
    // (F5, ator SYSTEM) tornou as 3 colunas ANULÁVEIS de propósito
    // (`DROP NOT NULL`) e passou a exigi-las só condicionalmente, via CHECK
    // `audit_log_http_fields_required_unless_system` (NULL só é aceito quando
    // `actorRole = 'SYSTEM'`). Testar "= NULL é rejeitado (23502)" para essas
    // 3 colunas não é mais verdade no nível de coluna — o teste original
    // (escrito antes da F5) quebrava aqui. A garantia de banco correta agora é
    // a CHECK, coberta nos 2 testes logo abaixo deste describe.
    const NOT_NULL_COLUMNS = ['occurredAt', 'actorUserId', 'actorRole', 'actorEmail', 'actorName', 'action', 'outcome'] as const

    for (const column of NOT_NULL_COLUMNS) {
      it(`${column} = NULL é rejeitado (23502 not_null_violation)`, async () => {
  const values: Record<(typeof NOT_NULL_COLUMNS)[number], unknown> = {
          occurredAt: new Date(),
          actorUserId: `audit-db-${suffix}-nn-${column}`,
          actorRole: 'ADMIN',
          actorEmail: 'nn@example.com',
          actorName: 'NN',
          action: 'OTHER',
          outcome: 'SUCCESS',
        }
        values[column] = null

        // httpStatus/method/path preenchidos (não são o alvo deste teste) —
        // sem eles o INSERT falharia pela CHECK, não pela coluna NOT NULL que
        // este teste está verificando.
        const attempt = prisma.$executeRaw(Prisma.sql`
          INSERT INTO "AuditLog" ("id", "occurredAt", "actorUserId", "actorRole", "actorEmail", "actorName", "action", "outcome", "httpStatus", "method", "path")
          VALUES (${`nn-${suffix}-${column}`}, ${values.occurredAt}::timestamptz, ${values.actorUserId}, ${values.actorRole}::"AuditActorRole", ${values.actorEmail}, ${values.actorName},
                  ${values.action}::"AuditAction", ${values.outcome}::"AuditOutcome", 200, 'GET', '/nn')
        `)
        await expect(attempt).rejects.toThrow(/23502|null value|not-null|violates not-null/i)
        expect(await prisma.auditLog.count({ where: { id: `nn-${suffix}-${column}` } })).toBe(0)
      })
    }

    it('controle: com todas as colunas preenchidas o mesmo INSERT cru é aceito (o teste acima falha pelo NULL, não por sintaxe)', async () => {
      const id = `nn-${suffix}-controle`
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "AuditLog" ("id", "occurredAt", "actorUserId", "actorRole", "actorEmail", "actorName", "action", "outcome", "httpStatus", "method", "path")
        VALUES (${id}, now(), ${`audit-db-${suffix}-controle`}, 'ADMIN'::"AuditActorRole", 'c@example.com', 'C', 'OTHER'::"AuditAction", 'SUCCESS'::"AuditOutcome", 200, 'GET', '/c')
      `)
      expect(await prisma.auditLog.count({ where: { id } })).toBe(1)
    })

    it('ator ADMIN com httpStatus/method/path NULL é rejeitado pela CHECK audit_log_http_fields_required_unless_system (23514)', async () => {
      const id = `nn-${suffix}-check-admin-no-http`
      const attempt = prisma.$executeRaw(Prisma.sql`
        INSERT INTO "AuditLog" ("id", "occurredAt", "actorUserId", "actorRole", "actorEmail", "actorName", "action", "outcome", "httpStatus", "method", "path")
        VALUES (${id}, now(), ${`audit-db-${suffix}-check-admin`}, 'ADMIN'::"AuditActorRole", 'c@example.com', 'C', 'OTHER'::"AuditAction", 'SUCCESS'::"AuditOutcome", NULL, NULL, NULL)
      `)
      await expect(attempt).rejects.toThrow(/23514|violates check constraint|audit_log_http_fields_required_unless_system/i)
      expect(await prisma.auditLog.count({ where: { id } })).toBe(0)
    })

    it('ator SYSTEM com httpStatus/method/path NULL é ACEITO pela mesma CHECK (evento automático sem requisição HTTP por trás)', async () => {
      const id = `nn-${suffix}-check-system-no-http`
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "AuditLog" ("id", "occurredAt", "actorUserId", "actorRole", "actorEmail", "actorName", "action", "outcome", "httpStatus", "method", "path")
        VALUES (${id}, now(), ${`audit-db-${suffix}-check-system`}, 'SYSTEM'::"AuditActorRole", 'system@innoelektron.local', 'Sistema', 'PAYMENT_CREDIT'::"AuditAction", 'SUCCESS'::"AuditOutcome", NULL, NULL, NULL)
      `)
      expect(await prisma.auditLog.count({ where: { id } })).toBe(1)
    })
  })

  /**
   * ACHADO E FECHADO (Íris achou em 2026-09-19; Órion A4 / migration
   * `20260919170000_audit_hardening` fechou no mesmo dia): os triggers
   * originais eram `FOR EACH ROW` e o Postgres NÃO dispara trigger de linha em
   * `TRUNCATE` — quem tinha o privilégio TRUNCATE (o dono; em produção a
   * aplicação conecta como dono) apagava o log inteiro sem erro. Este teste
   * descreve o comportamento correto (TRUNCATE recusado) e era `it.fails`
   * enquanto o furo existia; agora é `it` normal e trava a regressão.
   *
   * O TRUNCATE roda dentro de uma transação que é DESFEITA no final — nenhuma
   * linha de auditoria de outras suítes que rodam em paralelo é perdida.
   */
  it('TRUNCATE "AuditLog" é recusado ao papel da aplicação (trigger de statement, Órion A4)', async () => {
    class Rollback extends Error {
      constructor(public rowsAfterTruncate: number) {
        super('rollback proposital')
      }
    }

    const recentId = await insertRow('truncate-victim')
    let truncateAccepted = false
    let rowsAfter = -1
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')
        truncateAccepted = true // chegou aqui = o Postgres NÃO barrou
        throw new Rollback(await tx.auditLog.count())
      })
    } catch (err) {
      if (err instanceof Rollback) rowsAfter = err.rowsAfterTruncate
      else {
        // Foi recusado de verdade (é o comportamento desejado).
        truncateAccepted = false
      }
    }

    // A linha recente da vítima sobreviveu (a transação foi desfeita) — o teste não estraga o banco.
    expect(await prisma.auditLog.count({ where: { id: recentId } })).toBe(1)
    // Comportamento DESEJADO: o TRUNCATE não pode ter sido aceito.
    expect(truncateAccepted, `TRUNCATE foi aceito e esvaziou a tabela (linhas após o TRUNCATE: ${rowsAfter}) — falta o trigger BEFORE TRUNCATE`).toBe(false)
  })
})
