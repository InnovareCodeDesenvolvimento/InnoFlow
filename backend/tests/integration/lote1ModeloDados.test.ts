import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * Modelo de dados do LOTE 1 da F6 (migrations 20261005150000 + 20261005150100) contra Postgres REAL — Cronos, 05/10/2026.
 * Desenho e invariantes: docs/MODELO-DADOS-LOTE1.md.
 *
 * BANCO PRÓPRIO (`migrate deploy` DO ZERO, ou seja, prova também que a cadeia inteira de migrations aplica): este arquivo não importa código da aplicação,
 * só o Prisma Client apontado para o banco descartável. As garantias testadas são do BANCO (CHECK, trigger, índice único), independentes de quem escreve.
 *
 * MUTAÇÃO: `LOTE1_MUTACAO` (SQL) roda logo após o `migrate deploy` — o harness de mutação (ver doc §9) remove UMA garantia por vez e confere que o teste
 * correspondente FALHA. Sem a env, é a suíte normal.
 */

let banco: Awaited<ReturnType<typeof criarBancoProprio>>
let db: PrismaClient

const uid = () => randomUUID().replace(/-/g, '').slice(0, 12)
const SNAPSHOT: Prisma.InputJsonValue = { id: 'snap', model: 'PER_KWH', pricePerKwh: '1.00', windows: [] }
// Formato real do aesGcm.ts: v1:<kid 8 hex>:<base64>
const CIFRADO = 'v1:0a1b2c3d:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v'

interface Base {
  operatorId: string
  siteId: string
  chargePointId: string
  connectorId: string
  tariffId: string
  adminId: string
}
let base: Base

async function criarUsuario(role: 'DRIVER' | 'ADMIN', extra: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const id = uid()
  return db.user.create({ data: { role, name: `U ${id}`, email: `${role.toLowerCase()}-${id}@example.com`, passwordHash: 'x', ...extra } })
}

interface Cenario {
  driverId: string
  walletId: string
  sessionId: string
  intentId: string
}

/** Motorista + carteira + sessão STOPPED (total `totalCents`) + venda de cartão CAPTURED (`capturedCents`). */
async function cenario(totalCents: number | null = 1000, capturedCents = 1000): Promise<Cenario> {
  const driver = await criarUsuario('DRIVER')
  const wallet = await db.wallet.create({ data: { userId: driver.id } })
  const token = await db.authToken.create({ data: { idTag: `T${uid()}`.slice(0, 20), type: 'VIRTUAL', userId: driver.id } })
  const session = await db.chargingSession.create({
    data: {
      operatorId: base.operatorId,
      siteId: base.siteId,
      chargePointId: base.chargePointId,
      connectorId: base.connectorId,
      authTokenId: token.id,
      userId: driver.id,
      tariffId: base.tariffId,
      tariffSnapshot: SNAPSHOT,
      meterStartWh: 0,
      meterStopWh: 10000,
      energyDeliveredWh: 10000,
      startedAt: new Date(Date.now() - 3600_000),
      stoppedAt: new Date(),
      status: 'STOPPED',
      totalCostCents: totalCents,
    },
  })
  const intent = await db.paymentIntent.create({
    data: {
      purpose: 'SESSION_CARD_CAPTURE',
      provider: 'CIELO_CARD',
      userId: driver.id,
      chargingSessionId: session.id,
      status: 'CAPTURED',
      returnCode: '00',
      amountRequestedCents: capturedCents,
      amountAuthorizedCents: capturedCents,
      amountCapturedCents: capturedCents,
    },
  })
  return { driverId: driver.id, walletId: wallet.id, sessionId: session.id, intentId: intent.id }
}

async function entradaCarteira(walletId: string, type: Prisma.WalletEntryCreateManyInput['type'], amountCents: number, balanceAfter = 0) {
  return db.walletEntry.create({ data: { walletId, type, amountCents, balanceAfterCents: balanceAfter, referenceType: 'CHARGING_SESSION', referenceId: uid() } })
}

/** Espera o ERRO DO BANCO (mensagem do CHECK/trigger/índice) — nunca um sucesso. */
async function rejeita(p: Promise<unknown>, padrao: RegExp) {
  await expect(p).rejects.toThrow(padrao)
}

/** INSERT em PaymentReversal por SQL cru (parâmetros tipados). */
async function inserirEstorno(c: Cenario, o: Partial<{ id: string; userId: string; amount: number; destination: string; status: string; reason: string | null; walletEntryId: string | null; intentId: string | null; sessionId: string | null; portalReference: string | null; resolved: boolean; createdBy: string }> = {}) {
  const id = o.id ?? `rv${uid()}`
  const destination = o.destination ?? 'WALLET'
  // WALLET sem lançamento explícito: cria o REFUND na carteira (use walletEntryId: null para testar a ausência)
  if (destination === 'WALLET' && o.walletEntryId === undefined) o = { ...o, walletEntryId: (await entradaCarteira(c.walletId, 'REFUND', o.amount ?? 100, 1)).id }
  const status = o.status ?? (destination === 'WALLET' ? 'CONFIRMED' : 'PENDING_CONFIRMATION')
  const resolved = o.resolved ?? status === 'CONFIRMED'
  await db.$executeRaw`INSERT INTO "PaymentReversal" ("id","kind","status","destination","chargingSessionId","paymentIntentId","userId","amountCents","reason","portalReference","walletEntryId","createdByUserId","resolvedAt","updatedAt")
    VALUES (${id}, 'REFUND', ${status}::"PaymentReversalStatus", ${destination}::"RefundDestination", ${o.sessionId === undefined ? c.sessionId : o.sessionId}, ${o.intentId === undefined ? (destination === 'CARD_VIA_PORTAL' ? c.intentId : null) : o.intentId},
      ${o.userId ?? c.driverId}, ${o.amount ?? 100}, ${o.reason === undefined ? 'estorno de teste' : o.reason}, ${o.portalReference ?? null}, ${o.walletEntryId ?? null}, ${o.createdBy ?? base.adminId},
      ${resolved ? new Date() : null}, now())`
  return id
}

async function estornoCarteira(c: Cenario, amount: number) {
  const entry = await entradaCarteira(c.walletId, 'REFUND', amount, amount)
  return inserirEstorno(c, { amount, destination: 'WALLET', walletEntryId: entry.id })
}

async function inserirChargeback(c: Cenario, o: Partial<{ id: string; amount: number; dossier: unknown; intentId: string; status: string; resolvedBy: string | null; debtId: string | null }> = {}) {
  const id = o.id ?? `cb${uid()}`
  const status = o.status ?? 'OPEN'
  const resolved = status !== 'OPEN'
  const dossier = o.dossier === undefined ? { identityVerified: true, accountAgeDays: 40 } : o.dossier
  await db.$executeRaw`INSERT INTO "PaymentReversal" ("id","kind","status","paymentIntentId","userId","amountCents","caseReference","notifiedAt","dossierSnapshot","debtId","createdByUserId","resolvedAt","resolvedByUserId","updatedAt")
    VALUES (${id}, 'CHARGEBACK', ${status}::"PaymentReversalStatus", ${o.intentId ?? c.intentId}, ${c.driverId}, ${o.amount ?? 1000}, 'CASE-1', now(), ${dossier === null ? null : JSON.stringify(dossier)}::jsonb, ${o.debtId ?? null},
      ${base.adminId}, ${resolved ? new Date() : null}, ${resolved ? (o.resolvedBy === undefined ? base.adminId : o.resolvedBy) : null}, now())`
  return id
}

const bloqueadoPorChargeback = async (userId: string) =>
  (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "PaymentReversal" WHERE "userId" = ${userId} AND "kind" = 'CHARGEBACK' AND "status" IN ('OPEN','LOST','ACCEPTED')`)[0]!.n > 0

beforeAll(async () => {
  banco = await criarBancoProprio('lote1')
  db = new PrismaClient({ datasources: { db: { url: banco.url } } })
  if (process.env.LOTE1_MUTACAO) {
    for (const stmt of process.env.LOTE1_MUTACAO.split('@@')) await db.$executeRawUnsafe(stmt)
  }
  const operator = await db.operator.create({ data: { name: `Op ${uid()}`, email: `op-${uid()}@example.com` } })
  const site = await db.site.create({ data: { operatorId: operator.id, name: 'S', addressLine: 'R', city: 'C', state: 'SP', postalCode: '00000-000', latitude: -23.5, longitude: -46.6 } })
  const cp = await db.chargePoint.create({ data: { operatorId: operator.id, siteId: site.id, ocppIdentity: `cp-${uid()}`, basicAuthSecretHash: 'x' } })
  const connector = await db.connector.create({ data: { operatorId: operator.id, chargePointId: cp.id, connectorId: 1, type: 'AC_TYPE2' } })
  const tariff = await db.tariff.create({ data: { operatorId: operator.id, name: `T ${uid()}`, model: 'PER_KWH', pricePerKwh: '1.00' } })
  const admin = await criarUsuario('ADMIN')
  base = { operatorId: operator.id, siteId: site.id, chargePointId: cp.id, connectorId: connector.id, tariffId: tariff.id, adminId: admin.id }
}, 180_000)

afterAll(async () => {
  await db?.$disconnect()
  await banco?.descartar()
}, 60_000)

// ============================================================================================================================================================
describe('migrate deploy do zero', () => {
  it('aplicou as duas migrations do lote 1 e criou as 5 tabelas', async () => {
    const mig = await db.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name LIKE '20261005150%' ORDER BY 1`
    expect(mig.map((m) => m.migration_name)).toEqual(['20261005150000_lote1_audit_action_values', '20261005150100_lote1_lgpd_notificacoes_estorno_termos'])
    const t = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('AccountDeletionRequest','NotificationPreference','NotificationLog','ConsentRecord','PaymentReversal')`
    expect(t[0]!.n).toBe(5)
  })

  it('AuditAction ganhou os 4 valores e eles gravam em AuditLog', async () => {
    for (const action of ['PASSWORD_RESET', 'ACCOUNT_DELETION', 'REFUND', 'CHARGEBACK'] as const) {
      const row = await db.auditLog.create({ data: { actorUserId: `aud-${uid()}`, actorRole: 'ADMIN', actorEmail: 'a@example.com', actorName: 'A', action, outcome: 'SUCCESS', httpStatus: 200, method: 'POST', path: '/x' } })
      expect(row.action).toBe(action)
    }
  })
})

// ============================================================================================================================================================
describe('LGPD — anonimização libera os únicos e o banco garante o estado', () => {
  async function anonimizar(id: string, extra: Record<string, unknown> = {}) {
    // O que o fluxo do Vega faz num UPDATE só.
    await db.$executeRaw`UPDATE "User" SET "name" = 'Conta excluída', "email" = ${'excluido+' + id + '@anon.invalid'}, "phone" = NULL, "cpf" = NULL, "googleSub" = NULL, "passwordHash" = NULL,
      "active" = false, "sessionsValidAfter" = now(), "deletedAt" = now() WHERE "id" = ${id}`
    void extra
  }

  it('o e-mail, o googleSub e o CPF originais ficam LIVRES para uma conta nova (unique tombstone)', async () => {
    const s = uid()
    const email = `titular-${s}@example.com`
    const cpf = String(Math.floor(10000000000 + Math.random() * 89999999999))
    const antigo = await db.user.create({ data: { role: 'DRIVER', name: 'Titular', email, phone: '11999990000', cpf, googleSub: `g-${s}`, passwordHash: 'h' } })
    await anonimizar(antigo.id)
    const novo = await db.user.create({ data: { role: 'DRIVER', name: 'Mesma pessoa, conta nova', email, cpf, googleSub: `g-${s}`, passwordHash: 'h2' } })
    expect(novo.id).not.toBe(antigo.id)
    const velho = await db.user.findUniqueOrThrow({ where: { id: antigo.id } })
    expect(velho).toMatchObject({ name: 'Conta excluída', email: `excluido+${antigo.id}@anon.invalid`, phone: null, cpf: null, googleSub: null, passwordHash: null, active: false })
    expect(velho.deletedAt).not.toBeNull()
  })

  it('várias contas anonimizadas convivem (o tombstone é único por id)', async () => {
    const a = await criarUsuario('DRIVER')
    const b = await criarUsuario('DRIVER')
    await anonimizar(a.id)
    await anonimizar(b.id)
    expect(await db.user.count({ where: { id: { in: [a.id, b.id] }, deletedAt: { not: null } } })).toBe(2)
  })

  const restos: Array<[string, string]> = [
    ['passwordHash sobrando', `"passwordHash" = 'h'`],
    ['googleSub sobrando', `"googleSub" = 'g-resto'`],
    ['cpf sobrando', `"cpf" = '12345678901'`],
    ['phone sobrando', `"phone" = '11999990000'`],
    ['nome real', `"name" = 'Fulano de Tal'`],
    ['conta ainda ativa', `"active" = true`],
    ['sem revogar as sessões', `"sessionsValidAfter" = NULL`],
    ['e-mail real', `"email" = 'fulano@example.com'`],
    ['e-mail de tombstone de OUTRO id', `"email" = 'excluido+outro-id@anon.invalid'`],
  ]
  for (const [rotulo, set] of restos) {
    it(`o banco RECUSA deletedAt com PII/credencial restante: ${rotulo}`, async () => {
      const u = await criarUsuario('DRIVER')
      const base = `"name" = 'Conta excluída', "email" = '${'excluido+' + u.id + '@anon.invalid'}', "phone" = NULL, "cpf" = NULL, "googleSub" = NULL, "passwordHash" = NULL, "active" = false, "sessionsValidAfter" = now(), "deletedAt" = now()`
      // aplica o "resto" por cima (a última atribuição vence: reconstruímos a lista trocando a coluna)
      const col = set.split('=')[0]!.trim()
      const sql = base.split(', ').filter((p) => !p.startsWith(col)).concat(set).join(', ')
      await rejeita(db.$executeRawUnsafe(`UPDATE "User" SET ${sql} WHERE "id" = '${u.id}'`), /user_deleted_is_anonymized/)
      expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).deletedAt).toBeNull()
    })
  }

  it('só DRIVER é excluível por este fluxo (staff não)', async () => {
    const op = await db.user.create({ data: { role: 'OPERATOR', operatorId: base.operatorId, name: 'Staff', email: `staff-${uid()}@example.com`, passwordHash: 'h' } })
    await rejeita(
      db.$executeRaw`UPDATE "User" SET "name"='Conta excluída', "email"=${'excluido+' + op.id + '@anon.invalid'}, "passwordHash"=NULL, "active"=false, "sessionsValidAfter"=now(), "deletedAt"=now() WHERE id=${op.id}`,
      /user_deleted_is_anonymized/,
    )
  })

  it('não há como "ressuscitar": zerar o deletedAt é recusado, com ou sem restaurar a PII', async () => {
    const u = await criarUsuario('DRIVER')
    await anonimizar(u.id)
    await rejeita(db.$executeRaw`UPDATE "User" SET "deletedAt" = NULL WHERE id = ${u.id}`, /não há como desfazer/)
    await rejeita(db.$executeRaw`UPDATE "User" SET "deletedAt" = NULL, "email" = 'volta@example.com', "passwordHash" = 'h', "active" = true, "name" = 'Volta' WHERE id = ${u.id}`, /não há como desfazer/)
    await rejeita(db.$executeRaw`UPDATE "User" SET "passwordHash" = 'h' WHERE id = ${u.id}`, /user_deleted_is_anonymized/)
  })

  it('o histórico financeiro sobrevive: DELETE de User é impossível (Restrict) e saldo/sessão continuam ligados ao id pseudônimo', async () => {
    const c = await cenario(1000, 1000)
    await entradaCarteira(c.walletId, 'TOPUP_PIX', 5000, 5000)
    await anonimizar(c.driverId)
    await rejeita(db.$executeRaw`DELETE FROM "User" WHERE id = ${c.driverId}`, /foreign key|violates/i)
    expect(await db.walletEntry.count({ where: { walletId: c.walletId } })).toBe(1)
    expect((await db.chargingSession.findUniqueOrThrow({ where: { id: c.sessionId } })).userId).toBe(c.driverId)
  })

  it('cartão destruído: o marcador DESTROYED só vale com o cartão inativo e fora de "padrão"', async () => {
    const u = await criarUsuario('DRIVER')
    const pm = await db.paymentMethod.create({ data: { userId: u.id, cieloCardTokenCiphertext: 'v1:0a1b2c3d:AAAA', brand: 'Visa', last4: '1111', isDefault: true } })
    await rejeita(db.$executeRaw`UPDATE "PaymentMethod" SET "cieloCardTokenCiphertext" = 'DESTROYED' WHERE id = ${pm.id}`, /payment_method_destroyed_token_inactive/)
    await rejeita(db.$executeRaw`UPDATE "PaymentMethod" SET "cieloCardTokenCiphertext" = 'DESTROYED', "active" = false WHERE id = ${pm.id}`, /payment_method_destroyed_token_inactive/) // ainda "padrão"
    await db.$executeRaw`UPDATE "PaymentMethod" SET "cieloCardTokenCiphertext" = 'DESTROYED', "active" = false, "isDefault" = false, "holderName" = NULL WHERE id = ${pm.id}`
    expect((await db.paymentMethod.findUniqueOrThrow({ where: { id: pm.id } })).cieloCardTokenCiphertext).toBe('DESTROYED')
  })
})

// ============================================================================================================================================================
describe('append-only existente continua intacto + sinais do WalletEntry', () => {
  it('WalletEntry: UPDATE e DELETE continuam bloqueados por trigger', async () => {
    const c = await cenario()
    const e = await entradaCarteira(c.walletId, 'TOPUP_PIX', 100, 100)
    await rejeita(db.$executeRaw`UPDATE "WalletEntry" SET "amountCents" = 1 WHERE id = ${e.id}`, /append-only/i)
    await rejeita(db.$executeRaw`DELETE FROM "WalletEntry" WHERE id = ${e.id}`, /append-only/i)
  })

  it('AuditLog: UPDATE continua bloqueado e DELETE recente também (linhas dos valores novos incluídas)', async () => {
    const row = await db.auditLog.create({ data: { actorUserId: `aud-${uid()}`, actorRole: 'DRIVER', actorEmail: 'a@example.com', actorName: 'A', action: 'ACCOUNT_DELETION', outcome: 'SUCCESS', httpStatus: 200, method: 'POST', path: '/x' } })
    await rejeita(db.$executeRaw`UPDATE "AuditLog" SET "actorEmail" = 'anonimo@anon.invalid' WHERE id = ${row.id}`, /append-only/i)
    await rejeita(db.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${row.id}`, /piso de retenção/)
  })

  it('REFUND só positivo e TOPUP_REFUND só negativo; os ajustes seguem livres (decisão da Nova)', async () => {
    const c = await cenario()
    await rejeita(entradaCarteira(c.walletId, 'REFUND', -100), /wallet_entry_refund_sign/)
    await rejeita(entradaCarteira(c.walletId, 'TOPUP_REFUND', 100), /wallet_entry_refund_sign/)
    await entradaCarteira(c.walletId, 'REFUND', 100, 100)
    await entradaCarteira(c.walletId, 'TOPUP_REFUND', -100, 0)
    await entradaCarteira(c.walletId, 'ADJUSTMENT_DEBIT', -999, -899) // saldo negativo por correção contábil continua permitido
    await entradaCarteira(c.walletId, 'ADJUSTMENT_CREDIT', 5, -894)
  })
})

// ============================================================================================================================================================
describe('AccountDeletionRequest — máquina de estados e chave Pix cifrada', () => {
  async function pedido(status: 'NOT_REQUIRED' | 'PENDING_REFUND', balance: number, chave: string | null) {
    const u = await criarUsuario('DRIVER')
    const id = `ad${uid()}`
    await db.$executeRaw`INSERT INTO "AccountDeletionRequest" ("id","userId","balanceCentsAtRequest","refundStatus","refundPixKeyCiphertext","updatedAt") VALUES (${id}, ${u.id}, ${balance}, ${status}::"AccountDeletionRefundStatus", ${chave}, now())`
    return { id, userId: u.id }
  }

  it('estados válidos entram: sem saldo (NOT_REQUIRED) e com saldo + chave cifrada (PENDING_REFUND)', async () => {
    await pedido('NOT_REQUIRED', 0, null)
    await pedido('PENDING_REFUND', 2500, CIFRADO)
  })

  it('chave Pix em TEXTO ABERTO é recusada (CPF, telefone, e-mail, chave aleatória)', async () => {
    for (const aberto of ['12345678901', '+5511999990000', 'fulano@example.com', '123e4567-e89b-12d3-a456-426614174000']) {
      await rejeita(pedido('PENDING_REFUND', 100, aberto), /account_deletion_pix_key_is_ciphertext/)
    }
  })

  it('combinações impossíveis são recusadas', async () => {
    await rejeita(pedido('NOT_REQUIRED', 500, null), /account_deletion_status_consistency/) // diz que não deve nada mas há saldo
    await rejeita(pedido('NOT_REQUIRED', 0, CIFRADO), /account_deletion_status_consistency/) // guardou chave sem precisar
    await rejeita(pedido('PENDING_REFUND', 0, CIFRADO), /account_deletion_status_consistency/) // pendente sem saldo
    await rejeita(pedido('PENDING_REFUND', 500, null), /account_deletion_status_consistency/) // pendente sem chave
    await rejeita(pedido('PENDING_REFUND', -1, CIFRADO), /account_deletion_(balance_non_negative|status_consistency)/)
  })

  it('um pedido por conta (userId único)', async () => {
    const p = await pedido('NOT_REQUIRED', 0, null)
    await rejeita(db.$executeRaw`INSERT INTO "AccountDeletionRequest" ("id","userId","balanceCentsAtRequest","refundStatus","updatedAt") VALUES (${'ad' + uid()}, ${p.userId}, 0, 'NOT_REQUIRED', now())`, /23505|already exists/i)
  })

  it('PENDING_REFUND -> REFUNDED: exige TOPUP_REFUND, comprovante, ADMIN, valor <= saldo e APAGA a chave', async () => {
    const p = await pedido('PENDING_REFUND', 2500, CIFRADO)
    const wallet = await db.wallet.create({ data: { userId: p.userId } })
    const entry = await entradaCarteira(wallet.id, 'TOPUP_REFUND', -2500, 0)
    const passar = (set: string) => db.$executeRawUnsafe(`UPDATE "AccountDeletionRequest" SET ${set}, "updatedAt" = now() WHERE id = '${p.id}'`)
    const ok = `"refundStatus" = 'REFUNDED', "refundPixKeyCiphertext" = NULL, "refundedAmountCents" = 2500, "refundProofReference" = 'E2E123', "refundedAt" = now(), "refundedByUserId" = '${base.adminId}', "refundWalletEntryId" = '${entry.id}'`
    await rejeita(passar(ok.replace('"refundPixKeyCiphertext" = NULL', `"refundPixKeyCiphertext" = '${CIFRADO}'`)), /account_deletion_status_consistency/) // não apagou a chave
    await rejeita(passar(ok.replace('"refundedAmountCents" = 2500', '"refundedAmountCents" = 2501')), /account_deletion_status_consistency/) // acima do saldo
    await rejeita(passar(ok.replace('"refundedAmountCents" = 2500', '"refundedAmountCents" = 0')), /account_deletion_status_consistency/)
    await rejeita(passar(ok.replace("'E2E123'", "'   '")), /account_deletion_status_consistency/) // comprovante vazio
    await rejeita(passar(ok.replace(`"refundedByUserId" = '${base.adminId}'`, '"refundedByUserId" = NULL')), /account_deletion_status_consistency/)
    await passar(ok)
    const r = await db.accountDeletionRequest.findUniqueOrThrow({ where: { id: p.id } })
    expect(r.refundPixKeyCiphertext).toBeNull()
    expect(r.refundStatus).toBe('REFUNDED')
  })

  it('REFUNDED é terminal, o saldo do pedido é imutável e a linha nunca é apagada; o mesmo TOPUP_REFUND não serve a dois pedidos', async () => {
    const p = await pedido('PENDING_REFUND', 1000, CIFRADO)
    const wallet = await db.wallet.create({ data: { userId: p.userId } })
    const entry = await entradaCarteira(wallet.id, 'TOPUP_REFUND', -1000, 0)
    await rejeita(db.$executeRaw`UPDATE "AccountDeletionRequest" SET "balanceCentsAtRequest" = 9999 WHERE id = ${p.id}`, /imutáveis/)
    await db.$executeRaw`UPDATE "AccountDeletionRequest" SET "refundStatus"='REFUNDED', "refundPixKeyCiphertext"=NULL, "refundedAmountCents"=1000, "refundProofReference"='P', "refundedAt"=now(), "refundedByUserId"=${base.adminId}, "refundWalletEntryId"=${entry.id}, "updatedAt"=now() WHERE id=${p.id}`
    await rejeita(db.$executeRaw`UPDATE "AccountDeletionRequest" SET "refundProofReference" = 'adulterado' WHERE id = ${p.id}`, /terminal/)
    await rejeita(db.$executeRaw`DELETE FROM "AccountDeletionRequest" WHERE id = ${p.id}`, /DELETE não é permitido/)
    const outro = await pedido('PENDING_REFUND', 1000, CIFRADO)
    await rejeita(
      db.$executeRaw`UPDATE "AccountDeletionRequest" SET "refundStatus"='REFUNDED', "refundPixKeyCiphertext"=NULL, "refundedAmountCents"=1000, "refundProofReference"='P', "refundedAt"=now(), "refundedByUserId"=${base.adminId}, "refundWalletEntryId"=${entry.id}, "updatedAt"=now() WHERE id=${outro.id}`,
      /23505|already exists/i,
    )
  })
})

// ============================================================================================================================================================
describe('NotificationPreference e NotificationLog', () => {
  it('defaults do contrato no banco: recibo ligado, saldo baixo ligado, limiar R$ 20,00', async () => {
    const u = await criarUsuario('DRIVER')
    const p = await db.notificationPreference.create({ data: { userId: u.id } })
    expect(p).toMatchObject({ sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 })
  })

  it('limiar só entre 500 e 50000 (inclusive); uma linha por usuário', async () => {
    const u = await criarUsuario('DRIVER')
    for (const v of [499, 50001, 0, -1]) await rejeita(db.notificationPreference.create({ data: { userId: u.id, lowBalanceThresholdCents: v } }), /notification_preference_threshold_range/)
    for (const [i, v] of [500, 50000].entries()) {
      const x = await criarUsuario('DRIVER')
      expect((await db.notificationPreference.create({ data: { userId: x.id, lowBalanceThresholdCents: v } })).lowBalanceThresholdCents).toBe(v)
      void i
    }
    await db.notificationPreference.create({ data: { userId: u.id } })
    await rejeita(db.notificationPreference.create({ data: { userId: u.id } }), /Unique constraint|unique/i)
  })

  it('não existe coluna para desligar segurança/cobrança (DL5: o opt-out nem é persistível)', async () => {
    const cols = await db.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'NotificationPreference' ORDER BY 1`
    expect(cols.map((c) => c.column_name)).toEqual(['createdAt', 'lowBalanceEnabled', 'lowBalanceThresholdCents', 'sessionReceiptEmail', 'updatedAt', 'userId'])
  })

  it('idempotência: o MESMO fato (usuário, tipo, canal, entidade) nunca vira duas linhas — nem sob 20 reservas concorrentes', async () => {
    const u = await criarUsuario('DRIVER')
    const entidade = `sess-${uid()}`
    const reservar = () =>
      db.$executeRaw`INSERT INTO "NotificationLog" ("id","userId","type","entityId","updatedAt") VALUES (${'nl' + uid()}, ${u.id}, 'SESSION_COMPLETED', ${entidade}, now()) ON CONFLICT ("userId","type","channel","entityId") DO NOTHING`
    const r = await Promise.all(Array.from({ length: 20 }, reservar))
    expect(r.reduce((a, b) => a + b, 0)).toBe(1) // exatamente UMA reserva ganhou
    expect(await db.notificationLog.count({ where: { userId: u.id } })).toBe(1)
    // outro tipo, outra entidade ou outro usuário NÃO colidem
    await db.notificationLog.create({ data: { userId: u.id, type: 'LOW_BALANCE', entityId: entidade } })
    await db.notificationLog.create({ data: { userId: u.id, type: 'SESSION_COMPLETED', entityId: `${entidade}-2` } })
    const u2 = await criarUsuario('DRIVER')
    await db.notificationLog.create({ data: { userId: u2.id, type: 'SESSION_COMPLETED', entityId: entidade } })
    await rejeita(db.notificationLog.create({ data: { userId: u.id, type: 'SESSION_COMPLETED', entityId: entidade } }), /Unique constraint|unique/i)
  })

  it('SEM PII: statusReason só aceita código (e-mail, frase e mensagem de SMTP são recusados)', async () => {
    const u = await criarUsuario('DRIVER')
    const falhar = (reason: string, i: number) =>
      db.$executeRaw`INSERT INTO "NotificationLog" ("id","userId","type","entityId","status","statusReason","updatedAt") VALUES (${'nl' + uid()}, ${u.id}, 'TOPUP_CREDITED', ${'e' + i}, 'FAILED', ${reason}, now())`
    for (const [i, ruim] of ['550 5.1.1 <fulano@example.com>: Recipient rejected', 'fulano@example.com', 'erro de conexao', 'a b'].entries()) {
      await rejeita(falhar(ruim, i), /notification_log_status_reason_is_code/)
    }
    for (const [i, bom] of ['SMTP_550', 'ETIMEDOUT', 'PREFERENCE_OFF', 'smtp.451-temp'].entries()) await falhar(bom, 10 + i)
  })

  it('consistência de estado: SENT <=> sentAt; FAILED/SKIPPED exigem motivo; chave e terminais imutáveis; FAILED volta a PENDING', async () => {
    const u = await criarUsuario('DRIVER')
    const ins = (status: string, sentAt: Date | null, reason: string | null, e: string) =>
      db.$executeRaw`INSERT INTO "NotificationLog" ("id","userId","type","entityId","status","sentAt","statusReason","updatedAt") VALUES (${'nl' + uid()}, ${u.id}, 'PASSWORD_CHANGED', ${e}, ${status}::"NotificationStatus", ${sentAt}, ${reason}, now())`
    await rejeita(ins('SENT', null, null, 'a'), /notification_log_status_consistency/)
    await rejeita(ins('PENDING', new Date(), null, 'b'), /notification_log_status_consistency/)
    await rejeita(ins('FAILED', null, null, 'c'), /notification_log_status_consistency/)
    await rejeita(ins('SKIPPED', null, null, 'd'), /notification_log_status_consistency/)
    await ins('SKIPPED', null, 'PREFERENCE_OFF', 'e')

    const enviado = await db.notificationLog.create({ data: { userId: u.id, type: 'ACCOUNT_DELETED', entityId: 'z', status: 'SENT', sentAt: new Date() } })
    await rejeita(db.$executeRaw`UPDATE "NotificationLog" SET "status" = 'PENDING', "sentAt" = NULL WHERE id = ${enviado.id}`, /terminal/)
    await rejeita(db.$executeRaw`UPDATE "NotificationLog" SET "entityId" = 'outro' WHERE id = ${enviado.id}`, /imutável/)
    const falhou = await db.notificationLog.create({ data: { userId: u.id, type: 'ACCOUNT_DELETED', entityId: 'y', status: 'FAILED', statusReason: 'ETIMEDOUT', attempts: 5 } })
    await db.$executeRaw`UPDATE "NotificationLog" SET "status" = 'PENDING', "updatedAt" = now() WHERE id = ${falhou.id}`
    await rejeita(db.$executeRaw`UPDATE "NotificationLog" SET "attempts" = -1 WHERE id = ${falhou.id}`, /notification_log_attempts_non_negative/)
  })
})

// ============================================================================================================================================================
describe('ConsentRecord — prova do aceite', () => {
  it('uma linha por (usuário, documento, versão); documentos e versões diferentes coexistem', async () => {
    const u = await criarUsuario('DRIVER')
    await db.consentRecord.create({ data: { userId: u.id, kind: 'TERMS', version: '2026-10', source: 'REGISTER', ip: '203.0.113.7' } })
    await db.consentRecord.create({ data: { userId: u.id, kind: 'PRIVACY', version: '2026-10', source: 'REGISTER' } })
    await db.consentRecord.create({ data: { userId: u.id, kind: 'TERMS', version: '2026-12', source: 'REACCEPT' } })
    await rejeita(db.consentRecord.create({ data: { userId: u.id, kind: 'TERMS', version: '2026-10', source: 'REACCEPT' } }), /Unique constraint|unique/i)
    await rejeita(db.consentRecord.create({ data: { userId: u.id, kind: 'TERMS', version: '  ', source: 'REACCEPT' } }), /consent_record_version_not_blank/)
  })

  it('append-only: nada muda e nada some — exceto zerar o ip (anonimização)', async () => {
    const u = await criarUsuario('DRIVER')
    const c = await db.consentRecord.create({ data: { userId: u.id, kind: 'TERMS', version: 'v1', source: 'GOOGLE_SIGNUP', ip: '198.51.100.9' } })
    await rejeita(db.$executeRaw`UPDATE "ConsentRecord" SET "version" = 'v2' WHERE id = ${c.id}`, /append-only/)
    await rejeita(db.$executeRaw`UPDATE "ConsentRecord" SET "acceptedAt" = now() + interval '1 day' WHERE id = ${c.id}`, /append-only/)
    await rejeita(db.$executeRaw`UPDATE "ConsentRecord" SET "ip" = '10.0.0.1' WHERE id = ${c.id}`, /só pode ser zerado/)
    await rejeita(db.$executeRaw`DELETE FROM "ConsentRecord" WHERE id = ${c.id}`, /DELETE não é permitido/)
    await db.$executeRaw`UPDATE "ConsentRecord" SET "ip" = NULL WHERE id = ${c.id}`
    expect((await db.consentRecord.findUniqueOrThrow({ where: { id: c.id } })).ip).toBeNull()
  })
})

// ============================================================================================================================================================
describe('ChargingSession.startIp/startUserAgent', () => {
  it('aceita IP (v4/v6) e UA; nulos continuam valendo (legado e sessões de RFID)', async () => {
    const c = await cenario()
    await db.chargingSession.update({ where: { id: c.sessionId }, data: { startIp: '2001:db8::ff00:42:8329', startUserAgent: 'Mozilla/5.0 (X11)' } })
    const s = await db.chargingSession.findUniqueOrThrow({ where: { id: c.sessionId } })
    expect(s.startIp).toBe('2001:db8::ff00:42:8329')
    const outro = await cenario()
    expect((await db.chargingSession.findUniqueOrThrow({ where: { id: outro.sessionId } })).startIp).toBeNull()
  })

  it('UA acima de 512 estoura: a APLICAÇÃO deve truncar antes de gravar (o INSERT da sessão nunca pode falhar por campo de prova)', async () => {
    const c = await cenario()
    await rejeita(db.chargingSession.update({ where: { id: c.sessionId }, data: { startUserAgent: 'x'.repeat(513) } }), /too long|value too long|longer/i)
  })
})

// ============================================================================================================================================================
describe('PaymentReversal — estorno', () => {
  it('estorno para a carteira: nasce CONFIRMED com o WalletEntry REFUND; o pagador é copiado pelo BANCO (userId errado do app é sobrescrito)', async () => {
    const c = await cenario(1000, 1000)
    const errado = await criarUsuario('DRIVER')
    const entry = await entradaCarteira(c.walletId, 'REFUND', 400, 400)
    const id = await inserirEstorno(c, { amount: 400, destination: 'WALLET', walletEntryId: entry.id, userId: errado.id })
    const r = await db.paymentReversal.findUniqueOrThrow({ where: { id } })
    expect(r.userId).toBe(c.driverId)
    expect(r).toMatchObject({ kind: 'REFUND', status: 'CONFIRMED', destination: 'WALLET', walletEntryId: entry.id })
    // estorno em carteira NÃO mexe no informativo do cartão
    expect((await db.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId } })).amountRefundedCents).toBe(0)
  })

  it('formas inválidas são recusadas (tipo x campos x estado)', async () => {
    const c = await cenario()
    const entry = await entradaCarteira(c.walletId, 'REFUND', 100, 100)
    await rejeita(inserirEstorno(c, { reason: null }), /payment_reversal_shape/) // sem motivo
    await rejeita(inserirEstorno(c, { reason: '   ' }), /payment_reversal_shape/)
    await rejeita(inserirEstorno(c, { sessionId: null }), /payment_reversal_shape/) // sem sessão
    await rejeita(inserirEstorno(c, { amount: 0, walletEntryId: entry.id }), /payment_reversal_amount_positive/)
    await rejeita(inserirEstorno(c, { amount: -5, walletEntryId: entry.id }), /payment_reversal_amount_positive/)
    await rejeita(inserirEstorno(c, { destination: 'WALLET', walletEntryId: null }), /payment_reversal_destination_rules/) // carteira CONFIRMED sem lançamento
    await rejeita(inserirEstorno(c, { destination: 'WALLET', walletEntryId: entry.id, status: 'PENDING_CONFIRMATION', resolved: false }), /payment_reversal_destination_rules/) // carteira nunca fica pendente
    await rejeita(inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', intentId: null }), /payment_reversal_destination_rules/) // cartão sem a venda
    await rejeita(inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', walletEntryId: entry.id }), /payment_reversal_destination_rules/) // cartão não lança na carteira
    await rejeita(inserirEstorno(c, { destination: 'WALLET', walletEntryId: entry.id, portalReference: 'P1' }), /payment_reversal_destination_rules/) // portal só em CARD_VIA_PORTAL
    await rejeita(inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', status: 'PENDING_CONFIRMATION', resolved: true }), /payment_reversal_resolution/) // pendente já "resolvido"
    await rejeita(inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', status: 'CONFIRMED', resolved: false }), /payment_reversal_resolution/) // confirmado sem resolvedAt
  })

  it('teto: Σ estornos vivos <= total da sessão; sessão sem total => SESSION_NOT_BILLED; o cancelado libera o teto', async () => {
    const c = await cenario(1000, 1000)
    await estornoCarteira(c, 600)
    await rejeita(estornoCarteira(c, 401), /AMOUNT_EXCEEDS_REFUNDABLE/)
    await estornoCarteira(c, 400) // fecha exatamente 1000
    await rejeita(estornoCarteira(c, 1), /AMOUNT_EXCEEDS_REFUNDABLE/)

    const d = await cenario(1000, 1000)
    const pend = await inserirEstorno(d, { destination: 'CARD_VIA_PORTAL', amount: 700 })
    await rejeita(estornoCarteira(d, 301), /AMOUNT_EXCEEDS_REFUNDABLE/)
    await db.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'CANCELLED', "resolvedAt" = now(), "updatedAt" = now() WHERE id = ${pend}`
    await estornoCarteira(d, 1000) // o cancelado não conta mais

    const sem = await cenario(null, 0)
    await rejeita(estornoCarteira(sem, 10), /SESSION_NOT_BILLED/)
  })

  it('teto do cartão: devoluções via portal <= capturado da venda', async () => {
    const c = await cenario(1000, 800) // sessão 1000, mas só 800 foram capturados no cartão
    await inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', amount: 500 })
    await rejeita(inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', amount: 301 }), /AMOUNT_EXCEEDS_REFUNDABLE/)
    await inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', amount: 300 })
  })

  it('CONCORRÊNCIA: 10 estornos simultâneos de 300 numa sessão de 1000 => exatamente 3 entram (lock na sessão)', async () => {
    const c = await cenario(1000, 1000)
    const entries = await Promise.all(Array.from({ length: 10 }, () => entradaCarteira(c.walletId, 'REFUND', 300, 300)))
    const r = await Promise.allSettled(entries.map((e) => inserirEstorno(c, { amount: 300, destination: 'WALLET', walletEntryId: e.id })))
    const ok = r.filter((x) => x.status === 'fulfilled').length
    expect(ok).toBe(3)
    const soma = await db.paymentReversal.aggregate({ where: { chargingSessionId: c.sessionId }, _sum: { amountCents: true } })
    expect(soma._sum.amountCents).toBe(900)
    for (const x of r.filter((y) => y.status === 'rejected')) expect(String((x as PromiseRejectedResult).reason)).toMatch(/AMOUNT_EXCEEDS_REFUNDABLE/)
  })

  it('coerência venda x sessão x pagador; só venda de cartão tem estorno', async () => {
    const a = await cenario()
    const b = await cenario()
    await rejeita(inserirEstorno(a, { destination: 'CARD_VIA_PORTAL', intentId: b.intentId }), /não pertence à sessão/)
    // Pix não tem estorno por aqui
    const pix = await db.paymentIntent.create({ data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: a.driverId, walletId: a.walletId, status: 'PAID', amountRequestedCents: 100 } })
    await rejeita(inserirEstorno(a, { destination: 'CARD_VIA_PORTAL', intentId: pix.id }), /só venda de cartão/)
  })

  it('devolução no portal: PENDING não mexe no intent; CONFIRMED passa a somar em amountRefundedCents (por TRIGGER); CANCELLED não conta; o status continua CAPTURED', async () => {
    const c = await cenario(1000, 1000)
    const a = await inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', amount: 300, portalReference: 'PORTAL-1' })
    const intent = () => db.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId } })
    expect((await intent()).amountRefundedCents).toBe(0)
    const confirmar = (id: string) => db.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'CONFIRMED', "resolvedAt" = now(), "updatedAt" = now() WHERE id = ${id}`
    await confirmar(a)
    expect((await intent()).amountRefundedCents).toBe(300)
    const b = await inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', amount: 200 })
    expect((await intent()).amountRefundedCents).toBe(300)
    await confirmar(b)
    const final = await intent()
    expect(final.amountRefundedCents).toBe(500)
    expect(final.status).toBe('CAPTURED') // conciliação não muda
    const cancelado = await inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', amount: 100 })
    await db.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'CANCELLED', "resolvedAt" = now(), "updatedAt" = now() WHERE id = ${cancelado}`
    expect((await intent()).amountRefundedCents).toBe(500)
  })

  it('terminal não muda, o fato registrado é imutável e a linha não se apaga', async () => {
    const c = await cenario()
    const id = await inserirEstorno(c, { destination: 'CARD_VIA_PORTAL', amount: 100 })
    await rejeita(db.$executeRaw`UPDATE "PaymentReversal" SET "amountCents" = 999 WHERE id = ${id}`, /imutáveis/)
    await rejeita(db.$executeRaw`UPDATE "PaymentReversal" SET "reason" = 'outro motivo' WHERE id = ${id}`, /imutáveis/)
    await rejeita(db.$executeRaw`UPDATE "PaymentReversal" SET "userId" = ${base.adminId} WHERE id = ${id}`, /imutáveis/)
    await db.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'CONFIRMED', "resolvedAt" = now(), "updatedAt" = now() WHERE id = ${id}`
    await rejeita(db.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'CANCELLED' WHERE id = ${id}`, /terminal/)
    await rejeita(db.$executeRaw`DELETE FROM "PaymentReversal" WHERE id = ${id}`, /DELETE não é permitido/)
  })
})

// ============================================================================================================================================================
describe('PaymentReversal — chargeback e bloqueio do modo cartão (derivado)', () => {
  it('registrar: nasce OPEN, grava chargebackAt no intent (trigger) e BLOQUEIA o cartão; status do intent segue CAPTURED', async () => {
    const c = await cenario()
    expect(await bloqueadoPorChargeback(c.driverId)).toBe(false)
    const id = await inserirChargeback(c)
    expect(await bloqueadoPorChargeback(c.driverId)).toBe(true)
    const pi = await db.paymentIntent.findUniqueOrThrow({ where: { id: c.intentId } })
    expect(pi.chargebackAt).not.toBeNull()
    expect(pi.status).toBe('CAPTURED')
    const cb = await db.paymentReversal.findUniqueOrThrow({ where: { id } })
    expect(cb).toMatchObject({ userId: c.driverId, chargingSessionId: c.sessionId, status: 'OPEN' }) // sessão e pagador derivados do intent
  })

  it('desfecho: WON devolve o modo cartão; LOST e ACCEPTED mantêm o bloqueio (DL7)', async () => {
    for (const [desfecho, bloqueado] of [['WON', false], ['LOST', true], ['ACCEPTED', true]] as const) {
      const c = await cenario()
      const id = await inserirChargeback(c)
      await db.$executeRawUnsafe(`UPDATE "PaymentReversal" SET "status" = '${desfecho}', "resolvedAt" = now(), "resolvedByUserId" = '${base.adminId}', "updatedAt" = now() WHERE id = '${id}'`)
      expect(await bloqueadoPorChargeback(c.driverId)).toBe(bloqueado)
    }
  })

  it('só UM chargeback por venda — inclusive em corrida (5 registros simultâneos)', async () => {
    const c = await cenario()
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => inserirChargeback(c)))
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    for (const x of r.filter((y) => y.status === 'rejected')) expect(String((x as PromiseRejectedResult).reason)).toMatch(/23505|already exists/i)
  })

  it('regras de forma: dossiê obrigatório e OBJETO; valor <= capturado; desfecho exige o ADMIN; dívida só em LOST/ACCEPTED; Pix não tem chargeback', async () => {
    const c = await cenario(1000, 1000)
    await rejeita(inserirChargeback(c, { dossier: null }), /payment_reversal_shape/)
    await rejeita(inserirChargeback(c, { dossier: [1, 2] }), /payment_reversal_shape/)
    await rejeita(inserirChargeback(c, { dossier: 'texto' }), /payment_reversal_shape/)
    await rejeita(inserirChargeback(c, { amount: 1001 }), /excede o capturado/)
    await rejeita(inserirChargeback(c, { amount: 0 }), /payment_reversal_amount_positive/)
    await rejeita(inserirChargeback(c, { status: 'LOST', resolvedBy: null }), /payment_reversal_resolution/)
    const divida = await db.debt.create({ data: { userId: c.driverId, amountCents: 1000 } })
    await rejeita(inserirChargeback(c, { debtId: divida.id }), /payment_reversal_resolution/) // OPEN com dívida
    await inserirChargeback(c, { status: 'LOST', debtId: divida.id }) // perdido + ADMIN decidiu criar dívida
    const pix = await db.paymentIntent.create({ data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: c.driverId, walletId: c.walletId, status: 'PAID', amountRequestedCents: 100, amountCapturedCents: 100 } })
    await rejeita(inserirChargeback(c, { intentId: pix.id, amount: 100 }), /só venda de cartão/)
  })

  it('dossiê: imutável depois de registrado, limitado a 4 MiB, e SOBREVIVE ao expurgo (é snapshot na própria linha)', async () => {
    const c = await cenario()
    const id = await inserirChargeback(c, { dossier: { curva: [1, 2, 3], tid: 'T1' } })
    await rejeita(db.$executeRaw`UPDATE "PaymentReversal" SET "dossierSnapshot" = '{"adulterado":true}'::jsonb WHERE id = ${id}`, /imutáveis/)
    const grande = { blob: 'x'.repeat(4_300_000) }
    await rejeita(inserirChargeback(await cenario(), { dossier: grande }), /payment_reversal_dossier_size/)
    // apagar a sessão não é possível (Restrict); o dossiê não depende dela: é lido da própria linha
    const lido = await db.paymentReversal.findUniqueOrThrow({ where: { id } })
    expect(lido.dossierSnapshot).toEqual({ curva: [1, 2, 3], tid: 'T1' })
    await rejeita(db.$executeRaw`DELETE FROM "ChargingSession" WHERE id = ${c.sessionId}`, /foreign key|violates/i)
  })

  it('terminal congela: depois de LOST nada muda; o chargeback não se apaga', async () => {
    const c = await cenario()
    const id = await inserirChargeback(c)
    await db.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'LOST', "resolvedAt" = now(), "resolvedByUserId" = ${base.adminId}, "updatedAt" = now() WHERE id = ${id}`
    await rejeita(db.$executeRaw`UPDATE "PaymentReversal" SET "status" = 'WON' WHERE id = ${id}`, /terminal/)
    await rejeita(db.$executeRaw`DELETE FROM "PaymentReversal" WHERE id = ${id}`, /DELETE não é permitido/)
  })
})

// ============================================================================================================================================================
describe('índices parciais servem às consultas de fila (plano real)', () => {
  async function plano(sql: string) {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`)
      return rows.map((r) => r['QUERY PLAN']).join('\n')
    })
  }
  it('bloqueio de cartão, fila de confirmação, fila de reembolso e outbox pendente', async () => {
    expect(await plano(`SELECT 1 FROM "PaymentReversal" WHERE "userId" = 'u' AND "kind" = 'CHARGEBACK' AND "status" IN ('OPEN','LOST','ACCEPTED')`)).toMatch(/ix_payment_reversal_card_block/)
    expect(await plano(`SELECT id FROM "PaymentReversal" WHERE "status" = 'PENDING_CONFIRMATION' ORDER BY "createdAt"`)).toMatch(/ix_payment_reversal_pending_confirmation/)
    expect(await plano(`SELECT id FROM "AccountDeletionRequest" WHERE "refundStatus" = 'PENDING_REFUND' ORDER BY "requestedAt"`)).toMatch(/ix_account_deletion_pending/)
    expect(await plano(`SELECT id FROM "NotificationLog" WHERE "status" = 'PENDING' ORDER BY "createdAt"`)).toMatch(/ix_notification_log_pending/)
    expect(await plano(`SELECT id FROM "NotificationLog" WHERE "createdAt" < now() - interval '365 days'`)).toMatch(/NotificationLog_createdAt_idx/)
  })
})
