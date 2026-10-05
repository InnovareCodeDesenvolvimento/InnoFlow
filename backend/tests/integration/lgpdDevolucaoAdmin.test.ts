import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { encryptPaymentSecret } from '../../src/lib/crypto/paymentSecrets'
import { excluirContaDoMotorista } from '../../src/services/lgpd/excluirConta'
import { resumirDevolucoesAtrasadas, vigiarDevolucoesAtrasadas } from '../../src/services/lgpd/devolucaoDeSaldo'
import { createTenant, createUser, uniqueSuffix, waitFor, type TestTenant, type TestUser } from './helpers/fixtures'
import { criarMotoristaComSenha, type Motorista } from './helpers/lgpdFixture'

/**
 * L1.4/DL2 — a fila do ADMIN para devolver por Pix o saldo de conta excluída: `GET/POST /api/admin/account-deletions` contra Postgres + Redis REAIS. A regra de estado/forma é do banco
 * (CHECKs/triggers de `AccountDeletionRequest`); aqui se prova o que o CÓDIGO decide: só ADMIN, step-up de senha, valor integral, 1:1 com o `TOPUP_REFUND`, chave Pix apagada,
 * concorrência e auditoria.
 */
describe('/api/admin/account-deletions (L1.4, DL2)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const SENHA_ADMIN = 'Admin-Senha-Forte-123'
  let tenant: TestTenant
  let admin: TestUser
  const authAdmin = () => ({ Authorization: `Bearer ${admin.token}` })

  beforeAll(async () => {
    tenant = await createTenant({ suffix, label: 'lgpddev' })
    admin = await createUser({ role: 'ADMIN', label: 'dev-admin', suffix, passwordHash: await bcrypt.hash(SENHA_ADMIN, 4) })
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  /** Motorista que EXCLUIU a conta com saldo (pelo serviço de verdade) e a linha do pedido. */
  async function contaExcluidaComSaldo(label: string, saldoCents = 2500, chavePix = '(11) 91234-5678') {
    const m = await criarMotoristaComSenha(suffix, label, { saldoCents })
    const r = await excluirContaDoMotorista({ userId: m.id, refundPixKey: chavePix })
    return { m, requestId: r.requestId }
  }
  /** O limite de 10/min por ADMIN é por usuário: testes com muitas chamadas usam um ADMIN próprio (`novoAdmin`). */
  const novoAdmin = async (label: string) => createUser({ role: 'ADMIN', label, suffix, passwordHash: await bcrypt.hash(SENHA_ADMIN, 4) })
  const reembolsar = (id: string, corpo: Record<string, unknown> = {}, como: TestUser = admin) =>
    request(app).post(`/api/admin/account-deletions/${id}/refund`).set('Authorization', `Bearer ${como.token}`).send({ amountCents: 2500, proofReference: 'E2E-comprovante-1', currentPassword: SENHA_ADMIN, ...corpo })

  /** Percorre a fila (paginada) até achar o pedido — o banco de teste acumula pedidos de outras rodadas/suítes. */
  async function acharNaFila(requestId: string, status = 'PENDING_REFUND') {
    for (let page = 1; page <= 50; page++) {
      const res = await request(app).get(`/api/admin/account-deletions?status=${status}&page=${page}&pageSize=100`).set(authAdmin())
      expect(res.status).toBe(200)
      const achado = (res.body.items as Array<{ id: string }>).find((i) => i.id === requestId)
      if (achado) return { item: achado as Record<string, unknown>, res }
      if (page >= res.body.meta.totalPages) break
    }
    return { item: undefined, res: undefined }
  }

  it('LISTA a fila para o ADMIN com a chave Pix DECIFRADA, idade e prazo; a leitura da chave é AUDITADA', async () => {
    const { m, requestId } = await contaExcluidaComSaldo('dev-lista', 2500, 'Fila.Teste@Example.com')
    const { item, res } = await acharNaFila(requestId)
    expect(item).toBeDefined()
    expect(item).toMatchObject({ id: requestId, userId: m.id, balanceCentsAtRequest: 2500, refundStatus: 'PENDING_REFUND', refundPixKey: 'fila.teste@example.com', refundedAt: null, refundedByUserId: null, ageDays: 0, overdue: false })
    expect(res!.headers['cache-control']).toBe('no-store')
    expect(res!.body.meta).toMatchObject({ page: expect.any(Number), pageSize: 100, total: expect.any(Number), totalPages: expect.any(Number) })

    const linha = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: admin.id, action: 'EXPORT', actionDetail: 'pix_refund_keys_viewed' } }), { what: 'auditoria da leitura das chaves' })
    expect(linha).toMatchObject({ entityType: 'AccountDeletionRequest', outcome: 'SUCCESS', actorRole: 'ADMIN' })
    expect(JSON.stringify(linha)).not.toContain('fila.teste')
  })

  it('só ADMIN: sem token 401; DRIVER e OPERATOR 403 (listar e reembolsar); paginação limitada a 100', async () => {
    const m = await criarMotoristaComSenha(suffix, 'dev-papeis')
    expect((await request(app).get('/api/admin/account-deletions')).status).toBe(401)
    for (const auth of [m.auth, { Authorization: `Bearer ${tenant.staff.token}` }]) {
      expect((await request(app).get('/api/admin/account-deletions').set(auth)).status).toBe(403)
      expect((await request(app).post('/api/admin/account-deletions/qualquer/refund').set(auth).send({ amountCents: 1, proofReference: 'x', currentPassword: 'y' })).status).toBe(403)
    }
    expect((await request(app).get('/api/admin/account-deletions?pageSize=101').set(authAdmin())).status).toBe(400)
    expect((await request(app).get('/api/admin/account-deletions?status=INVENTADO').set(authAdmin())).status).toBe(400)
  })

  it('REEMBOLSO: lança TOPUP_REFUND negativo 1:1, APAGA a chave Pix, grava o comprovante e a auditoria (sem chave) — e a carteira zera', async () => {
    const { m, requestId } = await contaExcluidaComSaldo('dev-ok')
    const res = await reembolsar(requestId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: requestId, userId: m.id, refundStatus: 'REFUNDED', refundPixKey: null, refundedByUserId: admin.id, ageDays: 0, overdue: false })
    expect(res.body.refundedAt).toEqual(expect.any(String))

    const pedido = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: requestId } })
    expect(pedido).toMatchObject({ refundStatus: 'REFUNDED', refundPixKeyCiphertext: null, refundedAmountCents: 2500, refundProofReference: 'E2E-comprovante-1', refundedByUserId: admin.id })
    expect(pedido.refundWalletEntryId).not.toBeNull()

    const lancamento = await prisma.walletEntry.findUniqueOrThrow({ where: { id: pedido.refundWalletEntryId! } })
    expect(lancamento).toMatchObject({ type: 'TOPUP_REFUND', amountCents: -2500, balanceAfterCents: 0, walletId: m.walletId, referenceType: 'ACCOUNT_DELETION', referenceId: requestId, createdBy: admin.id })

    const auditoria = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: admin.id, action: 'ACCOUNT_DELETION', entityId: requestId } }), { what: 'auditoria do reembolso' })
    expect(auditoria).toMatchObject({ actionDetail: 'refund_recorded', outcome: 'SUCCESS', actorRole: 'ADMIN', entityType: 'AccountDeletionRequest', method: 'POST', httpStatus: 200 })
    expect(JSON.stringify(auditoria)).not.toContain('91234')
    // o middleware genérico NÃO duplicou a linha (a do reembolso é fail-closed na transação)
    expect(await prisma.auditLog.count({ where: { actorUserId: admin.id, entityId: requestId } })).toBe(1)

    // na fila aparece como REFUNDED, sem chave
    const { item } = await acharNaFila(requestId, 'REFUNDED')
    expect(item).toMatchObject({ refundStatus: 'REFUNDED', refundPixKey: null })
  })

  it('REEMBOLSO: senha errada = 403 e NADA muda (a senha é conferida ANTES de procurar o pedido); valor ≠ saldo = 409; comprovante vazio = 400', async () => {
    const { requestId } = await contaExcluidaComSaldo('dev-recusas')
    const eu = await novoAdmin('dev-admin-recusas')
    const errada = await reembolsar(requestId, { currentPassword: 'Senha-Errada-1' }, eu)
    expect(errada.status).toBe(403)
    expect(errada.body.code).toBe('INVALID_CURRENT_PASSWORD')
    // pedido inexistente + senha errada = 403 (não vaza que o pedido não existe a quem não provou a senha)
    expect((await reembolsar('pedido-que-nao-existe', { currentPassword: 'Senha-Errada-2' }, eu)).status).toBe(403)

    const maior = await reembolsar(requestId, { amountCents: 2501 }, eu)
    expect(maior.status).toBe(409)
    expect(maior.body.code).toBe('AMOUNT_EXCEEDS_BALANCE')
    const parcial = await reembolsar(requestId, { amountCents: 1000 }, eu)
    expect(parcial.status).toBe(409)
    expect(parcial.body.code).toBe('PARTIAL_REFUND_NOT_ALLOWED')
    for (const corpo of [{ proofReference: '   ' }, { amountCents: 0 }, { amountCents: 12.5 }, { amountCents: '2500' }, { extra: 'campo estranho' }]) {
      const r = await reembolsar(requestId, corpo, eu)
      expect(r.status, JSON.stringify(corpo)).toBe(400)
      expect(r.body.code).toBe('VALIDATION_ERROR')
    }
    expect((await reembolsar('pedido-que-nao-existe', {}, eu)).status).toBe(404)

    const pedido = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: requestId } })
    expect(pedido).toMatchObject({ refundStatus: 'PENDING_REFUND', refundedAmountCents: null, refundWalletEntryId: null })
    expect(pedido.refundPixKeyCiphertext).not.toBeNull() // a chave só some quando a devolução é concluída
  })

  it('REEMBOLSO é terminal: o 2º é 409 ALREADY_REFUNDED e NÃO lança outro TOPUP_REFUND; pedido sem saldo é 409 REFUND_NOT_REQUIRED', async () => {
    const { m, requestId } = await contaExcluidaComSaldo('dev-terminal')
    const eu = await novoAdmin('dev-admin-terminal')
    expect((await reembolsar(requestId, {}, eu)).status).toBe(200)
    const segundo = await reembolsar(requestId, {}, eu)
    expect(segundo.status).toBe(409)
    expect(segundo.body.code).toBe('ALREADY_REFUNDED')
    expect(await prisma.walletEntry.count({ where: { walletId: m.walletId, type: 'TOPUP_REFUND' } })).toBe(1)

    const semSaldo = await criarMotoristaComSenha(suffix, 'dev-sem-saldo')
    const r = await excluirContaDoMotorista({ userId: semSaldo.id })
    const nr = await reembolsar(r.requestId, { amountCents: 100 }, eu)
    expect(nr.status).toBe(409)
    expect(nr.body.code).toBe('REFUND_NOT_REQUIRED')
  })

  it('CONCORRÊNCIA: dois reembolsos simultâneos do MESMO pedido = exatamente UM TOPUP_REFUND (o outro é 409 ALREADY_REFUNDED)', async () => {
    const { m, requestId } = await contaExcluidaComSaldo('dev-conc')
    const eu = await novoAdmin('dev-admin-conc')
    const rs = await Promise.all([reembolsar(requestId, {}, eu), reembolsar(requestId, {}, eu), reembolsar(requestId, {}, eu)])
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409])
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'ALREADY_REFUNDED')).toBe(true)
    expect(await prisma.walletEntry.count({ where: { walletId: m.walletId, type: 'TOPUP_REFUND' } })).toBe(1)
    const ultimo = await prisma.walletEntry.findFirstOrThrow({ where: { walletId: m.walletId }, orderBy: { createdAt: 'desc' } })
    expect(ultimo.balanceAfterCents).toBe(0)
  })

  it('o saldo ATUAL também precisa cobrir o valor: carteira com menos do que o pedido registrou = 409 AMOUNT_EXCEEDS_BALANCE', async () => {
    const { m, requestId } = await contaExcluidaComSaldo('dev-saldo-menor')
    // alguém (ex.: ajuste manual) tirou saldo depois do pedido
    await prisma.walletEntry.create({ data: { walletId: m.walletId, type: 'ADJUSTMENT_DEBIT', amountCents: -500, balanceAfterCents: 2000, referenceType: 'MANUAL', description: 'ajuste de teste' } })
    const r = await reembolsar(requestId, {}, await novoAdmin('dev-admin-saldo'))
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('AMOUNT_EXCEEDS_BALANCE')
    expect(await prisma.walletEntry.count({ where: { walletId: m.walletId, type: 'TOPUP_REFUND' } })).toBe(0)
  })

  it('step-up: erros de senha do ADMIN TRANCAM (429 RATE_LIMITED_ACCOUNT_DELETION + Retry-After) e nenhum reembolso acontece', async () => {
    const adminTemp = await createUser({ role: 'ADMIN', label: 'dev-admin-tranca', suffix, passwordHash: await bcrypt.hash(SENHA_ADMIN, 4) })
    const { requestId } = await contaExcluidaComSaldo('dev-tranca')
    const tentar = (senha: string) => request(app).post(`/api/admin/account-deletions/${requestId}/refund`).set('Authorization', `Bearer ${adminTemp.token}`).send({ amountCents: 2500, proofReference: 'x', currentPassword: senha })
    for (let i = 1; i <= 5; i++) expect((await tentar(`Errada-${i}-aaaaaa`)).status).toBe(403)
    const trancado = await tentar(SENHA_ADMIN)
    expect(trancado.status).toBe(429)
    expect(trancado.body.code).toBe('RATE_LIMITED_ACCOUNT_DELETION')
    expect(Number(trancado.headers['retry-after'])).toBeGreaterThan(0)
    expect((await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: requestId } })).refundStatus).toBe('PENDING_REFUND')
  })

  describe('prazo de 30 dias (P4) e chave ilegível', () => {
    /** Pedido PENDING_REFUND antigo (`requestedAt` é gravado no INSERT; depois é imutável por trigger). */
    async function pedidoAntigo(label: string, dias: number, ciphertext?: string) {
      const m: Motorista = await criarMotoristaComSenha(suffix, label, { saldoCents: 1000 })
      const pedido = await prisma.accountDeletionRequest.create({
        data: { userId: m.id, requestedAt: new Date(Date.now() - dias * 86_400_000), balanceCentsAtRequest: 1000, refundStatus: 'PENDING_REFUND', refundPixKeyCiphertext: ciphertext ?? encryptPaymentSecret('antigo@example.com') },
      })
      return pedido
    }

    it('pedido pendente há mais de 30 dias aparece como atrasado na fila e dispara o alerta `payment_refund_pending_overdue` (sem id de titular nem chave no log)', async () => {
      const antigo = await pedidoAntigo('dev-antigo', 45)
      const recente = await pedidoAntigo('dev-recente', 5)
      const { item: a } = await acharNaFila(antigo.id)
      const { item: r } = await acharNaFila(recente.id)
      expect(a).toMatchObject({ ageDays: 45, overdue: true, refundPixKey: 'antigo@example.com' })
      expect(r).toMatchObject({ ageDays: 5, overdue: false })

      const resumo = await resumirDevolucoesAtrasadas()
      expect(resumo.total).toBeGreaterThanOrEqual(1)
      expect(resumo.maisAntigaDias).toBeGreaterThanOrEqual(45)

      const aviso = vi.spyOn(logger, 'warn')
      await vigiarDevolucoesAtrasadas()
      const chamadas = aviso.mock.calls.filter(([obj]) => typeof obj === 'object' && obj !== null && (obj as { alert?: string }).alert === 'payment_refund_pending_overdue')
      const texto = JSON.stringify(aviso.mock.calls)
      aviso.mockRestore()
      expect(chamadas).toHaveLength(1)
      expect((chamadas[0]![0] as { pendentesAtrasadas: number }).pendentesAtrasadas).toBeGreaterThanOrEqual(1)
      expect(texto).not.toContain('antigo@example.com')
      expect(texto).not.toContain(antigo.userId)
    })

    it('chave que não decifra (chave de cifragem trocada/perdida) sai `refundPixKey: null` + `refundPixKeyUnreadable: true` — o ADMIN sabe que precisa falar com o titular', async () => {
      const ilegivel = await pedidoAntigo('dev-ilegivel', 2, 'v1:00000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      const { item } = await acharNaFila(ilegivel.id)
      expect(item).toMatchObject({ refundPixKey: null, refundPixKeyUnreadable: true, refundStatus: 'PENDING_REFUND' })
    })
  })
})
