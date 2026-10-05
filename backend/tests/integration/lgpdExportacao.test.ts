import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { CHAVES_PROIBIDAS_NA_EXPORTACAO, LIMITE_LINHAS_POR_COLECAO } from '../../src/core/lgpd/exportacao'
import { chaveDaCotaDeExportacao, cotaDiariaDeExportacao } from '../../src/api/middleware/exportQuota'
import { createTenant, createUser, uniqueSuffix, waitFor, type TestTenant } from './helpers/fixtures'
import { criarMotoristaComSenha, criarSessao } from './helpers/lgpdFixture'

/**
 * L1.4 — `GET /api/me/data-export` contra Postgres + Redis REAIS. O que importa: o arquivo é do PRÓPRIO titular (IDOR), é lista branca (nenhum segredo/token/PAN, nem pelo nome da chave
 * nem pelo VALOR plantado no banco), é auditado, tem teto de tamanho e a cota de 3 por dia vale.
 */
describe('GET /api/me/data-export (L1.4)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let tenant: TestTenant

  const SEGREDOS = {
    hashSenha: 'hash-bcrypt-secreto-nao-sai',
    googleSub: `google-sub-secreto-${suffix}`,
    cartaoCiphertext: `v1:deadbeef:CIPHERTEXT-SECRETO-${suffix}`,
    pixQr: `00020126-PIX-COPIA-E-COLA-SECRETO-${suffix}`,
    cieloPaymentId: `cielo-payment-id-secreto-${suffix}`,
    cieloTid: `TID-SECRETO-${suffix}`.slice(0, 40),
  }

  beforeAll(async () => {
    tenant = await createTenant({ suffix, label: 'lgpdexp' })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  /** Motorista com um pouco de tudo: sessão (com IP/UA), extrato, Pix, cartão, token RFID, dívida, aceite e notificação. */
  async function motoristaCompleto(label: string) {
    const m = await criarMotoristaComSenha(suffix, label, { saldoCents: 5000, googleSub: `${SEGREDOS.googleSub}-${label}` })
    await prisma.user.update({ where: { id: m.id }, data: { passwordHash: SEGREDOS.hashSenha } })
    const sessao = await criarSessao(tenant, m.id, 'STOPPED', { startIp: '203.0.113.7', startUserAgent: 'Mozilla/5.0 (teste)', totalCostCents: 1234, idTag: `RFID${label}${suffix}`.slice(0, 20).toUpperCase() })
    await prisma.paymentMethod.create({
      data: { userId: m.id, cieloCardTokenCiphertext: SEGREDOS.cartaoCiphertext, brand: 'Visa', last4: '4242', holderName: 'TITULAR TESTE', expiryMonth: 7, expiryYear: 2031 },
    })
    await prisma.paymentIntent.create({
      data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: m.id, walletId: m.walletId, amountRequestedCents: 5000, status: 'PAID', pixQrCode: SEGREDOS.pixQr, cieloPaymentId: `${SEGREDOS.cieloPaymentId}-${label}`, cieloTid: SEGREDOS.cieloTid },
    })
    await prisma.debt.create({ data: { userId: m.id, operatorId: tenant.operatorId, chargingSessionId: sessao.id, amountCents: 77, status: 'SETTLED', reason: 'INSUFFICIENT_WALLET_BALANCE' } })
    await prisma.consentRecord.create({ data: { userId: m.id, kind: 'TERMS', version: 'termos-teste-1', source: 'REGISTER', ip: '203.0.113.7' } })
    await prisma.notificationLog.create({ data: { userId: m.id, type: 'SESSION_COMPLETED', entityId: sessao.id, status: 'SENT', sentAt: new Date() } })
    return { m, sessao }
  }

  it('devolve os dados do PRÓPRIO titular, em anexo JSON, sem nenhum dado de outro motorista', async () => {
    const a = await motoristaCompleto('exp-a')
    const b = await motoristaCompleto('exp-b')

    const res = await request(app).get('/api/me/data-export').set(a.m.auth)
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="innoflow-meus-dados-\d{8}\.json"$/)
    expect(res.headers['cache-control']).toBe('no-store')

    const d = res.body
    expect(d.profile).toMatchObject({ id: a.m.id, name: a.m.name, email: a.m.email, phone: '(11) 91234-5678', cpf: a.m.cpf }) // CPF INTEIRO: é do próprio titular
    expect(d.consents).toEqual([expect.objectContaining({ kind: 'TERMS', version: 'termos-teste-1' })])
    expect(d.sessions).toHaveLength(1)
    expect(d.sessions[0]).toMatchObject({ id: a.sessao.id, status: 'STOPPED', cost: expect.objectContaining({ totalCents: 1234 }), startIp: '203.0.113.7', startUserAgent: 'Mozilla/5.0 (teste)' })
    expect(d.walletEntries).toEqual([expect.objectContaining({ type: 'ADJUSTMENT_CREDIT', amountCents: 5000, balanceAfterCents: 5000 })])
    expect(d.topups).toEqual([expect.objectContaining({ status: 'PAID', amountCents: 5000 })])
    expect(d.paymentMethods).toEqual([expect.objectContaining({ brand: 'Visa', last4: '4242', expiry: '07/2031', holderName: 'TITULAR TESTE' })])
    expect(d.authTokens).toHaveLength(1) // só o token da sessão deste motorista (nada do outro)
    expect(d.debts).toEqual([expect.objectContaining({ amountCents: 77, status: 'SETTLED' })])
    expect(d.notifications).toEqual([expect.objectContaining({ type: 'SESSION_COMPLETED', status: 'SENT' })])
    expect(d.notificationPreferences).toEqual({ sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 })
    expect(d.limits.truncated).toEqual([])

    // IDOR: nada do motorista B (nem o id, nem o e-mail, nem a sessão dele) aparece no arquivo de A.
    const texto = JSON.stringify(d)
    expect(texto).not.toContain(b.m.id)
    expect(texto).not.toContain(b.m.email)
    expect(texto).not.toContain(b.sessao.id)
    expect(texto).not.toContain(b.m.cpf)
  })

  it('SEGREDOS: nenhuma chave proibida em NENHUM nível, e nenhum VALOR sensível plantado no banco (hash, googleSub, ciphertext, QR do Pix, ids da Cielo, idTag inteiro)', async () => {
    const a = await motoristaCompleto('exp-seg')
    const res = await request(app).get('/api/me/data-export').set(a.m.auth)
    expect(res.status).toBe(200)

    const chaves = new Set<string>()
    const varrer = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(varrer)
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          chaves.add(k)
          varrer(x)
        }
      }
    }
    varrer(res.body)
    for (const proibida of CHAVES_PROIBIDAS_NA_EXPORTACAO) expect(chaves.has(proibida), `chave proibida na exportação: ${proibida}`).toBe(false)

    const texto = res.text
    for (const [nome, valor] of Object.entries(SEGREDOS)) expect(texto, `valor sensível vazou: ${nome}`).not.toContain(valor)
    const idTagInteiro = (await prisma.authToken.findMany({ where: { userId: a.m.id }, select: { idTag: true } })).map((t) => t.idTag)
    for (const idTag of idTagInteiro) expect(texto, 'idTag inteiro vazou (deveria sair mascarado)').not.toContain(idTag)
    for (const t of res.body.authTokens as Array<{ idTagMasked: string }>) expect(t.idTagMasked).toMatch(/\*/)
  })

  it('o dono é SEMPRE o token: userId em query/cabeçalho é ignorado; sem token 401; ADMIN/OPERATOR 403', async () => {
    const a = await motoristaCompleto('exp-idor-a')
    const b = await motoristaCompleto('exp-idor-b')
    const res = await request(app).get(`/api/me/data-export?userId=${b.m.id}`).set(a.m.auth).set('x-user-id', b.m.id)
    expect(res.status).toBe(200)
    expect(res.body.profile.id).toBe(a.m.id)

    expect((await request(app).get('/api/me/data-export')).status).toBe(401)
    const admin = await createUser({ role: 'ADMIN', label: 'exp-admin', suffix })
    expect((await request(app).get('/api/me/data-export').set('Authorization', `Bearer ${admin.token}`)).status).toBe(403)
    expect((await request(app).get('/api/me/data-export').set('Authorization', `Bearer ${tenant.staff.token}`)).status).toBe(403)
  })

  it('é AUDITADA (EXPORT / data_export) com o ator certo', async () => {
    const a = await motoristaCompleto('exp-aud')
    expect((await request(app).get('/api/me/data-export').set(a.m.auth)).status).toBe(200)
    const linha = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: a.m.id, action: 'EXPORT' } }), { what: 'auditoria da exportação' })
    expect(linha).toMatchObject({ actionDetail: 'data_export', outcome: 'SUCCESS', entityType: 'User', entityId: a.m.id, path: '/api/me/data-export', method: 'GET', actorRole: 'DRIVER' })
  })

  it('COTA: 3 por dia por usuário (a 4ª é 429 RATE_LIMITED_EXPORT com Retry-After); outro usuário não é afetado', async () => {
    const a = await motoristaCompleto('exp-cota')
    const outro = await motoristaCompleto('exp-cota-outro')
    await redis.del(chaveDaCotaDeExportacao(a.m.id)) // banco/Redis persistem entre rodadas
    for (let i = 1; i <= 3; i++) expect((await request(app).get('/api/me/data-export').set(a.m.auth)).status, `exportação ${i}`).toBe(200)
    const quarta = await request(app).get('/api/me/data-export').set(a.m.auth)
    expect(quarta.status).toBe(429)
    expect(quarta.body.code).toBe('RATE_LIMITED_EXPORT')
    expect(Number(quarta.headers['retry-after'])).toBeGreaterThan(0)
    expect((await request(app).get('/api/me/data-export').set(outro.m.auth)).status).toBe(200)
  })

  it('COTA durável (Redis), isolada do limitador em memória: o middleware sozinho recusa a 4ª e a recusa carrega o Retry-After', async () => {
    const userId = `cota-direta-${suffix}`
    await redis.del(chaveDaCotaDeExportacao(userId))
    const chamar = () =>
      new Promise<unknown>((resolve) => {
        const headers: Record<string, string> = {}
        cotaDiariaDeExportacao({ user: { userId } } as never, { setHeader: (k: string, v: string) => (headers[k] = v) } as never, ((err?: unknown) => resolve({ err, headers })) as never)
      })
    for (let i = 1; i <= 3; i++) expect(((await chamar()) as { err?: unknown }).err, `exportação ${i}`).toBeUndefined()
    const quarta = (await chamar()) as { err: { statusCode: number; code: string }; headers: Record<string, string> }
    expect(quarta.err).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED_EXPORT' })
    expect(Number(quarta.headers['Retry-After'])).toBeGreaterThan(0)
  })

  it('TAMANHO: coleção acima do teto sai TRUNCADA (mais recentes primeiro) e `limits.truncated` diz qual', async () => {
    const a = await criarMotoristaComSenha(suffix, 'exp-trunc')
    const total = LIMITE_LINHAS_POR_COLECAO + 5
    await prisma.walletEntry.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        walletId: a.walletId,
        type: 'ADJUSTMENT_CREDIT' as const,
        amountCents: 1,
        balanceAfterCents: i + 1,
        referenceType: 'MANUAL',
        description: `lancamento ${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
      })),
    })
    await redis.del(chaveDaCotaDeExportacao(a.id))
    const res = await request(app).get('/api/me/data-export').set(a.auth)
    expect(res.status).toBe(200)
    expect(res.body.walletEntries).toHaveLength(LIMITE_LINHAS_POR_COLECAO)
    expect(res.body.limits).toEqual({ maxRowsPerCollection: LIMITE_LINHAS_POR_COLECAO, truncated: ['walletEntries'] })
    expect(res.body.walletEntries[0].description).toBe(`lancamento ${total}`) // o mais recente primeiro
  }, 60_000)
})
