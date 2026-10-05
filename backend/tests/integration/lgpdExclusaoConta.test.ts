import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { decryptPaymentSecret } from '../../src/lib/crypto/paymentSecrets'
import { excluirContaDoMotorista } from '../../src/services/lgpd/excluirConta'
import { confirmarIdentidadeDoTitular } from '../../src/services/lgpd/confirmarIdentidadeDoTitular'
import { AppError } from '../../src/api/middleware/errorHandler'
import { createTenant, createUser, uniqueSuffix, waitFor, type TestTenant } from './helpers/fixtures'
import { criarMotoristaComSenha, criarSessao, gerarCpf, SENHA_DO_MOTORISTA, type Motorista } from './helpers/lgpdFixture'
import { TERMOS_VIGENTES } from './helpers/termos'

/**
 * L1.4 — `POST /api/me/account/deletion` contra Postgres + Redis REAIS. A exclusão é ANONIMIZAÇÃO: o banco impõe o estado final (CHECK `user_deleted_is_anonymized`), então o que se prova
 * aqui é o que o CÓDIGO decide: reautenticação, DL2 (saldo -> Pix manual), DL3 (dívida bloqueia), sessão/pagamento em andamento, e que tudo acontece numa transação só (a recusa não deixa
 * NADA para trás).
 */
describe('POST /api/me/account/deletion (L1.4)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let tenant: TestTenant

  const excluir = (m: Motorista, corpo: Record<string, unknown> = {}) => request(app).post('/api/me/account/deletion').set(m.auth).send({ confirmation: 'EXCLUIR', currentPassword: SENHA_DO_MOTORISTA, ...corpo })

  beforeAll(async () => {
    tenant = await createTenant({ suffix, label: 'lgpddel' })
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function estadoDoUsuario(id: string) {
    return prisma.user.findUniqueOrThrow({ where: { id } })
  }
  async function naoMudouNada(m: Motorista) {
    const u = await estadoDoUsuario(m.id)
    expect(u.deletedAt, 'a recusa não pode ter excluído a conta').toBeNull()
    expect(u).toMatchObject({ name: m.name, email: m.email, cpf: m.cpf, active: true })
    expect(await prisma.accountDeletionRequest.count({ where: { userId: m.id } }), 'a recusa não pode deixar pedido de exclusão').toBe(0)
  }

  it('SEM SALDO: anonimiza exatamente o que o CHECK exige, derruba o token, e o e-mail/CPF ficam livres para uma conta nova', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-basico')
    const sessao = await criarSessao(tenant, m.id, 'STOPPED', { startIp: '198.51.100.9', startUserAgent: 'UA do titular', totalCostCents: 500 })
    const cartao = await prisma.paymentMethod.create({ data: { userId: m.id, cieloCardTokenCiphertext: 'v1:aaaaaaaa:segredo', brand: 'Visa', last4: '4242', holderName: 'TITULAR', isDefault: true } })
    await prisma.consentRecord.create({ data: { userId: m.id, kind: 'TERMS', version: 'v-del', source: 'REGISTER', ip: '198.51.100.9' } })

    const res = await excluir(m)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ status: 'DELETED' })

    // 1) o estado exato do tombstone
    const u = await estadoDoUsuario(m.id)
    expect(u).toMatchObject({ name: 'Conta excluída', email: `excluido+${m.id}@anon.invalid`, phone: null, cpf: null, googleSub: null, passwordHash: null, active: false })
    expect(u.deletedAt).toBeInstanceOf(Date)
    expect(u.sessionsValidAfter).toBeInstanceOf(Date)

    // 2) pedido NOT_REQUIRED, sem chave
    const pedido = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { userId: m.id } })
    expect(pedido).toMatchObject({ refundStatus: 'NOT_REQUIRED', balanceCentsAtRequest: 0, refundPixKeyCiphertext: null })

    // 3) cartão destruído, token de autorização bloqueado, IP/UA zerados; a sessão (fato contábil) fica
    expect(await prisma.paymentMethod.findUniqueOrThrow({ where: { id: cartao.id } })).toMatchObject({ active: false, isDefault: false, holderName: null, cieloCardTokenCiphertext: 'DESTROYED' })
    expect((await prisma.authToken.findMany({ where: { userId: m.id } })).every((t) => t.status === 'BLOCKED')).toBe(true)
    expect((await prisma.consentRecord.findMany({ where: { userId: m.id } })).every((c) => c.ip === null)).toBe(true)
    expect(await prisma.chargingSession.findUniqueOrThrow({ where: { id: sessao.id } })).toMatchObject({ startIp: null, startUserAgent: null, totalCostCents: 500, status: 'STOPPED', userId: m.id })

    // 4) o token atual deixou de valer e a senha antiga não entra mais
    expect((await request(app).get('/api/me/profile').set(m.auth)).status).toBe(401)
    expect((await request(app).post('/api/auth/login').send({ email: m.email, password: SENHA_DO_MOTORISTA })).status).toBe(401)

    // 5) o e-mail e o CPF originais ficam LIVRES: cadastro novo (conta nova, não ressuscita a anonimizada)
    const novo = await request(app).post('/api/auth/register').send({ name: 'Mesma Pessoa', email: m.email, password: 'Outra-Senha-456', acceptedTermsVersion: TERMOS_VIGENTES })
    expect(novo.status, JSON.stringify(novo.body)).toBe(201)
    expect(novo.body.user.id).not.toBe(m.id)
    await prisma.user.update({ where: { id: novo.body.user.id }, data: { cpf: m.cpf } }) // não viola o índice único de CPF
  })

  it('AUDITORIA: uma linha ACCOUNT_DELETION com o ator JÁ ANONIMIZADO (sem e-mail/nome/CPF reais, sem IP nem user-agent)', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-audit')
    expect((await excluir(m)).status).toBe(200)
    const linhas = await prisma.auditLog.findMany({ where: { actorUserId: m.id } })
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({
      action: 'ACCOUNT_DELETION',
      actionDetail: 'account_deleted:NOT_REQUIRED',
      outcome: 'SUCCESS',
      actorRole: 'DRIVER',
      actorEmail: `excluido+${m.id}@anon.invalid`,
      actorName: 'Conta excluída',
      entityType: 'User',
      entityId: m.id,
      ipAddress: null,
      userAgent: null,
    })
    const texto = JSON.stringify(linhas)
    for (const pii of [m.email, m.name, m.cpf, '91234-5678']) expect(texto, `PII na auditoria: ${pii}`).not.toContain(pii)
  })

  it('DL2 — COM SALDO: sem chave Pix é 400 REFUND_PIX_KEY_REQUIRED (nada muda); chave inválida é 400 VALIDATION_ERROR; com chave válida: DELETED_PENDING_REFUND, chave CIFRADA e saldo intacto', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-saldo', { saldoCents: 2500 })

    const semChave = await excluir(m)
    expect(semChave.status).toBe(400)
    expect(semChave.body.code).toBe('REFUND_PIX_KEY_REQUIRED')
    await naoMudouNada(m)

    const invalida = await excluir(m, { refundPixKey: 'isto não é uma chave pix' })
    expect(invalida.status).toBe(400)
    expect(invalida.body.code).toBe('VALIDATION_ERROR')
    await naoMudouNada(m)

    const espiao = (['info', 'warn', 'error', 'debug'] as const).map((nivel) => vi.spyOn(logger, nivel))
    const ok = await excluir(m, { refundPixKey: '(11) 91234-5678' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toEqual({ status: 'DELETED_PENDING_REFUND' })

    const pedido = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { userId: m.id } })
    expect(pedido).toMatchObject({ refundStatus: 'PENDING_REFUND', balanceCentsAtRequest: 2500 })
    expect(pedido.refundPixKeyCiphertext).toMatch(/^v1:[0-9a-f]{8}:/) // CIFRADA, no formato do núcleo AES-GCM
    expect(pedido.refundPixKeyCiphertext).not.toContain('91234')
    expect(decryptPaymentSecret(pedido.refundPixKeyCiphertext!)).toBe('+5511912345678') // forma canônica

    // a chave Pix e a senha nunca foram para log (nenhum nível)
    const tudoQueFoiLogado = JSON.stringify(espiao.flatMap((e) => e.mock.calls))
    espiao.forEach((e) => e.mockRestore())
    for (const segredo of ['91234-5678', '+5511912345678', '5511912345678', SENHA_DO_MOTORISTA]) expect(tudoQueFoiLogado, `vazou no log: ${segredo}`).not.toContain(segredo)

    // o saldo continua na carteira (o ADMIN devolve por Pix e registra depois)
    const ultimo = await prisma.walletEntry.findFirstOrThrow({ where: { walletId: m.walletId }, orderBy: { createdAt: 'desc' } })
    expect(ultimo.balanceAfterCents).toBe(2500)
  })

  it('SEM SALDO a chave Pix informada é DESCARTADA (nunca gravada)', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-sem-saldo-com-chave')
    expect((await excluir(m, { refundPixKey: '(11) 91234-5678' })).status).toBe(200)
    expect(await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { userId: m.id } })).toMatchObject({ refundStatus: 'NOT_REQUIRED', refundPixKeyCiphertext: null })
  })

  it('DL3 — dívida ABERTA bloqueia (409 OPEN_DEBT) e nada muda; quitada, a exclusão passa', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-divida')
    const divida = await prisma.debt.create({ data: { userId: m.id, operatorId: tenant.operatorId, amountCents: 300, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE' } })
    const r = await excluir(m)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('OPEN_DEBT')
    await naoMudouNada(m)

    await prisma.debt.update({ where: { id: divida.id }, data: { status: 'SETTLED', settledAt: new Date() } })
    expect((await excluir(m)).status).toBe(200)
  })

  it('sessão em andamento (inclusive STOP_UNCONFIRMED) bloqueia com 409 ACTIVE_SESSION; sessão encerrada não', async () => {
    for (const status of ['STARTED', 'CHARGING', 'FINISHING', 'FAULTED', 'STOP_UNCONFIRMED'] as const) {
      const m = await criarMotoristaComSenha(suffix, `del-sessao-${status.toLowerCase()}`)
      await criarSessao(tenant, m.id, status)
      const r = await excluir(m)
      expect(r.status, status).toBe(409)
      expect(r.body.code, status).toBe('ACTIVE_SESSION')
      await naoMudouNada(m)
    }
    const m = await criarMotoristaComSenha(suffix, 'del-sessao-stopped')
    await criarSessao(tenant, m.id, 'STOPPED')
    expect((await excluir(m)).status).toBe(200)
  })

  it('pagamento em andamento (cartão autorizado, captura pendente, Pix pendente, intent recém-criado) bloqueia com 409 PAYMENT_IN_PROGRESS; intent CREATED esquecido há dias não', async () => {
    const casos: Array<{ nome: string; criar: (m: Motorista) => Promise<unknown>; bloqueia: boolean }> = [
      { nome: 'Pix PENDING', bloqueia: true, criar: (m) => prisma.paymentIntent.create({ data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: m.id, walletId: m.walletId, amountRequestedCents: 2000, status: 'PENDING' } }) },
      { nome: 'cartão AUTHORIZED', bloqueia: true, criar: (m) => prisma.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.id, amountRequestedCents: 5000, status: 'AUTHORIZED', returnCode: '4' } }) },
      { nome: 'CREATED recente', bloqueia: true, criar: (m) => prisma.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.id, amountRequestedCents: 5000, status: 'CREATED' } }) },
      { nome: 'CREATED esquecido há 2 dias', bloqueia: false, criar: (m) => prisma.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.id, amountRequestedCents: 5000, status: 'CREATED', createdAt: new Date(Date.now() - 2 * 86_400_000) } }) },
      { nome: 'Pix PAID (já creditado)', bloqueia: false, criar: (m) => prisma.paymentIntent.create({ data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: m.id, walletId: m.walletId, amountRequestedCents: 2000, status: 'PAID' } }) },
    ]
    for (const [i, caso] of casos.entries()) {
      const m = await criarMotoristaComSenha(suffix, `del-pag-${i}`)
      await caso.criar(m)
      const r = await excluir(m)
      if (caso.bloqueia) {
        expect(r.status, caso.nome).toBe(409)
        expect(r.body.code, caso.nome).toBe('PAYMENT_IN_PROGRESS')
        await naoMudouNada(m)
      } else {
        expect(r.status, caso.nome).toBe(200)
      }
    }
  })

  it('REAUTENTICAÇÃO: senha errada = 403 INVALID_CURRENT_PASSWORD; sem senha = 400 CURRENT_PASSWORD_REQUIRED; sem "EXCLUIR" ou com campo estranho = 400 — e NADA muda', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-reauth')
    const errada = await excluir(m, { currentPassword: 'Senha-Errada-999' })
    expect(errada.status).toBe(403)
    expect(errada.body.code).toBe('INVALID_CURRENT_PASSWORD')

    const sem = await request(app).post('/api/me/account/deletion').set(m.auth).send({ confirmation: 'EXCLUIR' })
    expect(sem.status).toBe(400)
    expect(sem.body.code).toBe('CURRENT_PASSWORD_REQUIRED')

    for (const corpo of [{ confirmation: 'excluir', currentPassword: SENHA_DO_MOTORISTA }, { currentPassword: SENHA_DO_MOTORISTA }, { confirmation: 'EXCLUIR', currentPassword: SENHA_DO_MOTORISTA, userId: 'outra-conta' }]) {
      const r = await request(app).post('/api/me/account/deletion').set(m.auth).send(corpo)
      expect(r.status, JSON.stringify(corpo)).toBe(400)
      expect(r.body.code).toBe('VALIDATION_ERROR')
    }
    await naoMudouNada(m)
  })

  it('REAUTENTICAÇÃO: erros de senha TRANCAM (5 erradas -> 429 RATE_LIMITED_ACCOUNT_DELETION com Retry-After, mesmo com a senha certa) e a conta fica intacta', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-tranca')
    await redis.keys('*').then(() => undefined) // só para garantir a conexão
    for (let i = 1; i <= 5; i++) expect((await excluir(m, { currentPassword: `Errada-${i}-xxxxx` })).status, `tentativa ${i}`).toBe(403)
    const trancada = await excluir(m) // senha CERTA, mas trancado
    expect(trancada.status).toBe(429)
    expect(trancada.body.code).toBe('RATE_LIMITED_ACCOUNT_DELETION')
    expect(Number(trancada.headers['retry-after'])).toBeGreaterThan(0)
    await naoMudouNada(m)
  })

  it('papéis: sem token 401; ADMIN e OPERATOR 403 (só o motorista exclui a PRÓPRIA conta)', async () => {
    expect((await request(app).post('/api/me/account/deletion').send({ confirmation: 'EXCLUIR', currentPassword: 'x' })).status).toBe(401)
    const admin = await createUser({ role: 'ADMIN', label: 'del-admin', suffix })
    for (const token of [admin.token, tenant.staff.token]) {
      const r = await request(app).post('/api/me/account/deletion').set('Authorization', `Bearer ${token}`).send({ confirmation: 'EXCLUIR', currentPassword: 'x' })
      expect(r.status).toBe(403)
    }
  })

  it('IDEMPOTÊNCIA/CONCORRÊNCIA: duas exclusões simultâneas = UM pedido e UMA auditoria; a 2ª devolve o MESMO resultado (200), nunca 500', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-conc', { saldoCents: 1000 })
    const [a, b] = await Promise.all([excluirContaDoMotorista({ userId: m.id, refundPixKey: 'maria@example.com' }), excluirContaDoMotorista({ userId: m.id, refundPixKey: 'maria@example.com' })])
    expect([a.status, b.status]).toEqual(['DELETED_PENDING_REFUND', 'DELETED_PENDING_REFUND'])
    expect([a.jaExcluida, b.jaExcluida].sort()).toEqual([false, true]) // só uma fez o trabalho
    expect(a.requestId).toBe(b.requestId)
    expect([a.notificar, b.notificar].filter((n) => n !== null)).toHaveLength(1) // o aviso só nasce uma vez
    expect(await prisma.accountDeletionRequest.count({ where: { userId: m.id } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { actorUserId: m.id, action: 'ACCOUNT_DELETION' } })).toBe(1)

    // pelo HTTP: duas requisições ao mesmo tempo — cada uma é 200 (venceu/idempotente) ou 401 (token já revogado), nunca 5xx; e continua UM pedido
    const m2 = await criarMotoristaComSenha(suffix, 'del-conc-http')
    const rs = await Promise.all([excluir(m2), excluir(m2)])
    for (const r of rs) expect([200, 401], JSON.stringify(r.body)).toContain(r.status)
    expect(rs.some((r) => r.status === 200)).toBe(true)
    expect(await prisma.accountDeletionRequest.count({ where: { userId: m2.id } })).toBe(1)
    // 2ª chamada DEPOIS: o token já não vale (401) — a ação irreversível não "quebra", só informa que a sessão acabou
    expect((await excluir(m2)).status).toBe(401)
  })

  it('o aviso ACCOUNT_DELETED recebe o e-mail/nome de ANTES da anonimização (e só em memória)', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-notificar')
    const r = await excluirContaDoMotorista({ userId: m.id })
    expect(r.notificar).toEqual({ email: m.email, nome: m.name })
    expect((await estadoDoUsuario(m.id)).email).toBe(`excluido+${m.id}@anon.invalid`)
  })

  it('o registro financeiro SOBREVIVE: sessões, extrato e dívidas quitadas seguem ligados ao id pseudônimo, com os mesmos valores', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-contabil', { saldoCents: 0 })
    const s1 = await criarSessao(tenant, m.id, 'STOPPED', { totalCostCents: 700 })
    await prisma.walletEntry.create({ data: { walletId: m.walletId, type: 'CHARGE_DEBIT', amountCents: -0, balanceAfterCents: 0, referenceType: 'CHARGING_SESSION', referenceId: s1.id } }).catch(() => undefined)
    const antes = { sessoes: await prisma.chargingSession.aggregate({ where: { userId: m.id }, _sum: { totalCostCents: true }, _count: true }), extrato: await prisma.walletEntry.count({ where: { walletId: m.walletId } }) }
    expect((await excluir(m)).status).toBe(200)
    const depois = { sessoes: await prisma.chargingSession.aggregate({ where: { userId: m.id }, _sum: { totalCostCents: true }, _count: true }), extrato: await prisma.walletEntry.count({ where: { walletId: m.walletId } }) }
    expect(depois).toEqual(antes)
    expect(antes.sessoes._sum.totalCostCents).toBe(700)
  })

  it('o conteúdo do corpo nunca é logado nem volta na resposta de erro (senha/chave Pix)', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-semlog', { saldoCents: 800 })
    const espiao = (['info', 'warn', 'error'] as const).map((nivel) => vi.spyOn(logger, nivel))
    const r = await excluir(m, { currentPassword: 'Senha-Errada-SEGREDO-777', refundPixKey: 'segredo.pix@example.com' })
    const tudo = JSON.stringify(espiao.flatMap((e) => e.mock.calls)) + JSON.stringify(r.body)
    espiao.forEach((e) => e.mockRestore())
    expect(r.status).toBe(403)
    expect(tudo).not.toContain('Senha-Errada-SEGREDO-777')
    expect(tudo).not.toContain('segredo.pix@example.com')
    await waitFor(async () => true)
  })

  it('CPF reutilizável: gerarCpf produz CPFs distintos por motorista (sanidade do fixture)', () => {
    expect(new Set(Array.from({ length: 20 }, gerarCpf)).size).toBeGreaterThan(15)
  })
})

describe('reautenticação do titular — conta só-Google (L1.4)', () => {
  const suffix = uniqueSuffix()
  const ok = (sub: string, over: Record<string, unknown> = {}) => async () => ({ sub, email: 'x@example.com', emailVerified: true, name: 'X', ...over })
  const portas = (verificar: (c: string) => Promise<{ sub: string; email: string; emailVerified: boolean; name: string | null }>) => ({
    exigirSenha: async () => {
      throw new Error('a senha não deveria ser usada numa conta só-Google')
    },
    verificarIdTokenDoGoogle: verificar,
  })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('ID token do MESMO sub passa; outro sub, e-mail não verificado ou token inválido são 401 INVALID_GOOGLE_TOKEN; sem credencial é 400', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-google', { semSenha: true, googleSub: `g-sub-${suffix}` })
    await expect(confirmarIdentidadeDoTitular(m.id, { googleCredential: 'jwt' }, portas(ok(`g-sub-${suffix}`)))).resolves.toBeUndefined()

    const falhas: Array<[string, Parameters<typeof portas>[0]]> = [
      ['outro sub', ok('sub-de-outra-pessoa')],
      ['e-mail não verificado', ok(`g-sub-${suffix}`, { emailVerified: false })],
      [
        'token inválido (a lib embute o JWT na mensagem)',
        async () => {
          throw new Error('Wrong number of segments in token: JWT-SECRETO.AAA.BBB')
        },
      ],
    ]
    for (const [nome, verificar] of falhas) {
      const erro = await confirmarIdentidadeDoTitular(m.id, { googleCredential: 'JWT-SECRETO.AAA.BBB' }, portas(verificar)).catch((e: unknown) => e)
      expect(erro, nome).toBeInstanceOf(AppError)
      expect(erro, nome).toMatchObject({ statusCode: 401, code: 'INVALID_GOOGLE_TOKEN' })
      expect(JSON.stringify(erro), `${nome}: o erro não pode carregar o JWT`).not.toContain('JWT-SECRETO')
    }

    const semCredencial = await confirmarIdentidadeDoTitular(m.id, {}, portas(ok(`g-sub-${suffix}`))).catch((e: unknown) => e)
    expect(semCredencial).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' })
  })

  it('conta COM senha não aceita só o Google (CURRENT_PASSWORD_REQUIRED) — a prova mais forte e com tranca é a senha', async () => {
    const m = await criarMotoristaComSenha(suffix, 'del-google-e-senha', { googleSub: `g-sub2-${suffix}` })
    const erro = await confirmarIdentidadeDoTitular(m.id, { googleCredential: 'jwt' }, portas(ok(`g-sub2-${suffix}`))).catch((e: unknown) => e)
    expect(erro).toMatchObject({ statusCode: 400, code: 'CURRENT_PASSWORD_REQUIRED' })
  })
})
