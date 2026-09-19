import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { createTenant, createUser, settle, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Endurecimento do log de auditoria contra Postgres REAL (Órion A4 + M4 parcial, 2026-09-19):
 * teto de tamanho (aplicação + CHECK), DENIED só para quem usa o painel e TRUNCATE recusado.
 */
describe('log de auditoria — endurecimento (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()

  afterAll(async () => {
    redis.disconnect()
  })

  it('DRIVER batendo em /api/admin/* leva 403 e NÃO gera linha DENIED; OPERATOR na mesma situação continua gerando', async () => {
    const tenant = await createTenant({ suffix, label: 'hard-a' })
    const driver = await createUser({ role: 'DRIVER', label: 'hard-driver', suffix })

    // MUTAÇÃO de propósito: GET comum nunca é auditado, então só um POST/PATCH/DELETE 403 exercita a regra.
    const res = await request(app).post('/api/admin/sites').set('Authorization', `Bearer ${driver.token}`).send({ name: 'x' })
    expect(res.status).toBe(403)

    // Sentinela: OPERATOR em rota ADMIN-only (auth-tokens) -> 403 + linha DENIED. Quando ela aparece, a do DRIVER (se existisse) já teria aparecido.
    const sentinel = await request(app).post('/api/admin/auth-tokens').set('Authorization', `Bearer ${tenant.staff.token}`).send({ idTag: 'X', type: 'RFID' })
    expect(sentinel.status).toBe(403)
    const denied = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: tenant.staff.id, outcome: 'DENIED' } }), { what: 'linha DENIED do OPERATOR' })
    expect(denied.httpStatus).toBe(403)

    await settle()
    expect(await prisma.auditLog.count({ where: { actorUserId: driver.id } })).toBe(0)
  })

  it('User-Agent gigante e path enorme são TRUNCADOS na aplicação (512/255) — o CHECK do banco nunca dispara', async () => {
    const admin = await createUser({ role: 'ADMIN', label: 'hard-admin', suffix })
    const idGigante = 'x'.repeat(400)

    const res = await request(app)
      .patch(`/api/admin/sites/${idGigante}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('User-Agent', 'U'.repeat(4_000))
      .send({ name: 'qualquer' })
    expect(res.status).toBe(404) // ADMIN + recurso inexistente -> DENIED gravado

    const row = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: admin.id, outcome: 'DENIED' } }), { what: 'linha DENIED do ADMIN' })
    expect(row.path).toHaveLength(255)
    expect(row.userAgent).toHaveLength(512)
    expect(row.entityId?.length ?? 0).toBeLessThanOrEqual(128) // o `:id` gigante também foi cortado
  })

  it('o banco recusa (CHECK) um INSERT direto com campo acima do teto — a rede de segurança existe mesmo se a aplicação esquecer de truncar', async () => {
    const insert = (path: string, userAgent: string | null, entityId: string | null) =>
      prisma.auditLog.create({
        data: { actorUserId: `hard-${suffix}`, actorRole: 'ADMIN', actorEmail: 'h@example.com', actorName: 'H', action: 'OTHER', outcome: 'SUCCESS', httpStatus: 200, method: 'GET', path, userAgent, entityId },
      })

    await expect(insert('p'.repeat(256), null, null)).rejects.toThrow(/audit_log_path_max_len/)
    await expect(insert('/x', 'u'.repeat(513), null)).rejects.toThrow(/audit_log_user_agent_max_len/)
    await expect(insert('/x', null, 'e'.repeat(129))).rejects.toThrow(/audit_log_entity_id_max_len/)
    await expect(insert('p'.repeat(255), 'u'.repeat(512), 'e'.repeat(128))).resolves.toBeTruthy() // no limite exato passa
  })

  describe('TRUNCATE (M4 parcial)', () => {
    /** Dentro de uma transação SEMPRE desfeita: se um dia o guard sumir, o TRUNCATE não chega a ser commitado e não apaga linhas de outras suítes. */
    async function tryTruncate(table: 'AuditLog' | 'WalletEntry'): Promise<'aceito' | string> {
      class Rollback extends Error {}
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)
          throw new Rollback('desfeito')
        })
        return 'aceito'
      } catch (err) {
        return err instanceof Rollback ? 'aceito' : String((err as Error).message)
      }
    }

    it('TRUNCATE "AuditLog" é recusado pelo trigger de statement', async () => {
      expect(await tryTruncate('AuditLog')).toMatch(/append-only.*TRUNCATE não é permitido/s)
    })

    it('TRUNCATE "WalletEntry" é recusado pelo trigger de statement', async () => {
      expect(await tryTruncate('WalletEntry')).toMatch(/append-only.*TRUNCATE não é permitido/s)
    })
  })
})
