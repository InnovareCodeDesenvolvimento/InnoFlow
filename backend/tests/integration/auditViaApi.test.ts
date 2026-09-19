import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { createTenant, createUser, makeIdTag, settle, uniqueSuffix, waitFor, type TestTenant, type TestUser } from './helpers/fixtures'

/**
 * Auditoria de ponta a ponta (HTTP -> middleware `auditTrail` -> `AuditLog`
 * no Postgres real). A gravação genérica é fire-and-forget (`res.on
 * ('finish')`): a linha aparece DEPOIS da resposta, por isso as afirmações de
 * "existe" usam `waitFor` e as de "NÃO existe" só valem depois de uma linha
 * SENTINELA do mesmo ator ter aparecido (ver `settle` em helpers/fixtures.ts).
 */
describe('Auditoria via API (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()

  let tenantA: TestTenant
  let tenantB: TestTenant
  let admin: TestUser
  const driverIds: string[] = []
  const cleanup = { siteIds: [] as string[], chargePointIds: [] as string[] }

  const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` })
  const rowsOf = (where: Record<string, unknown>) => prisma.auditLog.findMany({ where, orderBy: { occurredAt: 'asc' } })

  beforeAll(async () => {
    tenantA = await createTenant({ suffix, label: 'audA' })
    tenantB = await createTenant({ suffix, label: 'audB' })
    admin = await createUser({ role: 'ADMIN', label: 'admin-aud', suffix })
  })

  afterAll(async () => {
    // Best-effort: linhas de AuditLog recentes são imortais por desenho; o resto é removível.
    await prisma.chargePoint.deleteMany({ where: { id: { in: cleanup.chargePointIds } } }).catch(() => undefined)
    await prisma.site.deleteMany({ where: { id: { in: cleanup.siteIds } } }).catch(() => undefined)
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('mutação bem-sucedida', () => {
    it('ADMIN criando um Site grava exatamente 1 linha SUCCESS, com ator/entidade/diff corretos', async () => {
      const res = await request(app)
        .post('/api/admin/sites')
        .set(auth(admin))
        .send({ operatorId: tenantA.operatorId, name: `Site Auditado ${suffix}`, addressLine: 'Rua X, 1', city: 'Santos', state: 'SP', postalCode: '11000-000', latitude: -23.9, longitude: -46.3 })
      expect(res.status).toBe(201)
      cleanup.siteIds.push(res.body.id)

      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: res.body.id } }), { what: 'linha de auditoria do POST /sites' })
      await settle()
      const all = await rowsOf({ entityId: res.body.id })

      expect(all).toHaveLength(1)
      expect(row).toMatchObject({
        outcome: 'SUCCESS',
        action: 'CREATE',
        entityType: 'Site',
        httpStatus: 201,
        method: 'POST',
        path: '/api/admin/sites',
        actorUserId: admin.id,
        actorRole: 'ADMIN',
        actorEmail: admin.email,
        actorName: admin.name,
        targetOperatorId: tenantA.operatorId,
      })
      // Bug real corrigido em 17/09: `req.id` do pino-http é NÚMERO — tem que sair como string.
      expect(typeof row.requestId).toBe('string')
      expect((row.changes as Record<string, { to: unknown }>).name.to).toBe(`Site Auditado ${suffix}`)
    })

    it('OPERATOR editando site do PRÓPRIO tenant grava 1 linha SUCCESS/UPDATE só com o campo que mudou', async () => {
      const res = await request(app).patch(`/api/admin/sites/${tenantA.siteId}`).set(auth(tenantA.staff)).send({ city: 'Campinas' })
      expect(res.status).toBe(200)

      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: tenantA.siteId, actorUserId: tenantA.staff.id, outcome: 'SUCCESS' } }))
      expect(row).toMatchObject({ action: 'UPDATE', entityType: 'Site', httpStatus: 200, actorRole: 'OPERATOR', actorOperatorId: tenantA.operatorId, targetOperatorId: tenantA.operatorId })
      expect(row.changes).toEqual({ city: { from: 'São Paulo', to: 'Campinas' } })
    })
  })

  describe('acesso negado vira sinal de segurança (DENIED)', () => {
    it('OPERATOR em rota ADMIN-only (POST /auth-tokens) -> 403 e exatamente 1 linha DENIED', async () => {
      const idTag = makeIdTag()
      const res = await request(app).post('/api/admin/auth-tokens').set(auth(tenantA.staff)).send({ idTag, type: 'RFID' })
      expect(res.status).toBe(403)

      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: tenantA.staff.id, path: '/api/admin/auth-tokens' } }))
      await settle()
      expect(await rowsOf({ actorUserId: tenantA.staff.id, path: '/api/admin/auth-tokens' })).toHaveLength(1)
      expect(row).toMatchObject({ outcome: 'DENIED', httpStatus: 403, action: 'CREATE', entityType: 'AuthToken', method: 'POST', actorRole: 'OPERATOR', targetOperatorId: tenantA.operatorId })
      // O idTag COMPLETO da tentativa nunca pode ter ido parar no log.
      expect(JSON.stringify(row)).not.toContain(idTag)
    })

    it('OPERATOR tentando editar recurso de OUTRO tenant -> 404 e 1 linha DENIED apontando o recurso', async () => {
      const res = await request(app).patch(`/api/admin/sites/${tenantB.siteId}`).set(auth(tenantA.staff)).send({ name: 'invasão' })
      expect(res.status).toBe(404)

      // Achado por PATH, não por `entityId`: em linha DENIED o `entityId` vem NULL (ver o `it.fails` logo abaixo).
      const siteBPath = `/api/admin/sites/${tenantB.siteId}`
      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { path: siteBPath, actorUserId: tenantA.staff.id } }))
      await settle()
      expect(await rowsOf({ path: siteBPath, actorUserId: tenantA.staff.id })).toHaveLength(1)
      expect(row).toMatchObject({ outcome: 'DENIED', httpStatus: 404, action: 'UPDATE', entityType: 'Site', actorOperatorId: tenantA.operatorId })
      // E o site do tenant B continua intacto.
      expect((await prisma.site.findUniqueOrThrow({ where: { id: tenantB.siteId } })).name).toBe(`Site audB ${suffix}`)
    })

    /**
     * BUG (Íris, 2026-09-19): em linha DENIED/FAILED cujo request morreu ANTES
     * de a rota chamar `.describe()` (todo 403/404), `entityId` grava NULL. O
     * middleware tenta `req.params.id`, mas ele é montado em `/api/admin` e o
     * listener roda em `res.on('finish')` — nessa altura `req.params` já não é o
     * do router filho (vem `{}`). O id só sobrevive dentro de `path`. Efeito: a
     * consulta "histórico desta entidade" (índice entityType+entityId) NUNCA
     * enxerga as tentativas negadas contra ela — justamente as mais úteis para
     * segurança. `it.fails` = comportamento DESEJADO descrito; quando o Vega
     * corrigir (ex.: extrair o id do `pathname`), o Vitest avisa e o `.fails`
     * sai. Não corrigi: escolher COMO extrair (por prefixo do PATH_ENTITY_MAP,
     * ou capturar `req.params` num `res.locals` pelas rotas) é decisão de desenho.
     */
    it.fails('linha DENIED de recurso de outro tenant deveria trazer entityId (FURO CONHECIDO: hoje vem NULL)', async () => {
      await request(app).patch(`/api/admin/sites/${tenantB.siteId}`).set(auth(tenantA.staff)).send({ name: 'invasão 2' }).expect(404)
      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { path: `/api/admin/sites/${tenantB.siteId}`, actorUserId: tenantA.staff.id }, orderBy: { occurredAt: 'desc' } }))
      expect(row.entityId).toBe(tenantB.siteId)
    })

    it('exportação CSV negada (OPERATOR em /audit-logs?format=csv) -> 403 e linha DENIED/EXPORT', async () => {
      const res = await request(app).get('/api/admin/audit-logs').query({ format: 'csv' }).set(auth(tenantA.staff))
      expect(res.status).toBe(403)

      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: tenantA.staff.id, action: 'EXPORT' } }))
      expect(row).toMatchObject({ outcome: 'DENIED', httpStatus: 403, entityType: 'AuditLog', method: 'GET' })
    })

    /**
     * OBSERVAÇÃO (Íris, 2026-09-19): a hipótese de que "OPERATOR em rota
     * ADMIN-only -> 403 grava DENIED" só vale para MUTAÇÃO e CSV. Um GET
     * comum negado (ex.: OPERATOR abrindo a tela de auditoria ou listando
     * tokens) NÃO grava nada — é a regra documentada do middleware ("GET
     * comum não audita"). Este teste TRAVA o comportamento atual; se o dono
     * decidir que tentativa de leitura proibida também é sinal de segurança,
     * é uma mudança de desenho (Nova/Vega) e este teste deve ser invertido.
     */
    it('leitura (GET) negada NÃO grava linha — decisão atual do middleware (só mutação/CSV/forceAudit)', async () => {
      const marker = `audit-logs-get-${suffix}`
      const getRes = await request(app).get('/api/admin/audit-logs').query({ q: marker }).set(auth(tenantA.staff))
      const tokensRes = await request(app).get('/api/admin/auth-tokens').set(auth(tenantA.staff))
      expect(getRes.status).toBe(403)
      expect(tokensRes.status).toBe(403)

      // Sentinela: uma mutação negada do MESMO ator, feita DEPOIS (rota diferente), já tem que estar gravada.
      const sentinelPath = `/api/admin/charge-points/${tenantB.chargePointId}`
      await request(app).patch(sentinelPath).set(auth(tenantA.staff)).send({ vendor: 'sentinela' }).expect(404)
      await waitFor(() => prisma.auditLog.findFirst({ where: { path: sentinelPath, actorUserId: tenantA.staff.id } }), { what: 'sentinela' })
      await settle()

      const gets = await rowsOf({ actorUserId: tenantA.staff.id, method: 'GET', action: { not: 'EXPORT' } })
      expect(gets).toHaveLength(0)
    })
  })

  describe('o que NUNCA grava', () => {
    it('400 de validação (Zod) não grava linha', async () => {
      const bad = await request(app).patch(`/api/admin/sites/${tenantA.siteId}`).set(auth(admin)).send({ latitude: 'não-é-número' })
      expect(bad.status).toBe(400)

      // Sentinela do mesmo ator/entidade: um PATCH válido logo depois.
      const good = await request(app).patch(`/api/admin/sites/${tenantA.siteId}`).set(auth(admin)).send({ state: 'RJ' })
      expect(good.status).toBe(200)
      await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: tenantA.siteId, actorUserId: admin.id } }), { what: 'sentinela do 400' })
      await settle()

      const rows = await rowsOf({ entityId: tenantA.siteId, actorUserId: admin.id })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ outcome: 'SUCCESS', httpStatus: 200 })
      expect(rows.some((r) => r.httpStatus === 400)).toBe(false)
    })

    it('401 (sem token / token inválido) não grava linha', async () => {
      const marker = `sem-token-${suffix}`
      const noToken = await request(app).patch(`/api/admin/sites/${marker}`).send({ name: 'x' })
      const badToken = await request(app).patch(`/api/admin/sites/${marker}-2`).set({ Authorization: 'Bearer token.invalido.aqui' }).send({ name: 'x' })
      expect(noToken.status).toBe(401)
      expect(badToken.status).toBe(401)

      // Sentinela: mutação válida de um ator conhecido, depois.
      const sentinel = await request(app).patch(`/api/admin/sites/${tenantA.siteId}`).set(auth(admin)).send({ postalCode: '22222-222' })
      expect(sentinel.status).toBe(200)
      await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: tenantA.siteId, actorUserId: admin.id, changes: { path: ['postalCode', 'to'], equals: '22222-222' } } }), { what: 'sentinela do 401' })
      await settle()

      expect(await prisma.auditLog.count({ where: { path: { contains: marker } } })).toBe(0)
    })
  })

  describe('ajuste manual de saldo (WALLET_ADJUSTMENT) — fail-closed', () => {
    async function newDriver(label: string): Promise<TestUser> {
      const driver = await createUser({ role: 'DRIVER', label, suffix })
      driverIds.push(driver.id)
      return driver
    }

    it('ADMIN crédito manual: 201, 1 linha WALLET_ADJUSTMENT (sem duplicar com o middleware genérico) e o WalletEntry persiste', async () => {
      const driver = await newDriver('drv-adj-ok')
      const res = await request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set(auth(admin)).send({ amountCents: 5000, description: `Crédito de teste ${suffix}` })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body).toMatchObject({ type: 'ADJUSTMENT_CREDIT', amountCents: 5000, balanceAfterCents: 5000 })

      await waitFor(() => prisma.auditLog.findFirst({ where: { action: 'WALLET_ADJUSTMENT', entityId: driver.id } }))
      await settle()
      const rows = await rowsOf({ entityId: driver.id, action: 'WALLET_ADJUSTMENT' })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ outcome: 'SUCCESS', httpStatus: 201, entityType: 'Wallet', actorUserId: admin.id, method: 'POST' })
      expect(rows[0].changes).toEqual({ amountCents: { to: 5000 }, description: { to: `Crédito de teste ${suffix}` } })

      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: driver.id } })
      expect(await prisma.walletEntry.count({ where: { walletId: wallet.id } })).toBe(1)
    })

    it('débito acima do saldo -> 409 sem WalletEntry novo (a linha de auditoria registrada é FAILED, não SUCCESS)', async () => {
      const driver = await newDriver('drv-adj-409')
      await request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set(auth(admin)).send({ amountCents: 1000, description: 'crédito inicial' }).expect(201)
      const res = await request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set(auth(admin)).send({ amountCents: -5000, description: 'débito maior que o saldo' })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('INSUFFICIENT_BALANCE')

      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: driver.id } })
      expect(await prisma.walletEntry.count({ where: { walletId: wallet.id } })).toBe(1)

      // Por PATH: a linha FAILED (409) não tem `entityId` (mesmo furo do DENIED).
      const walletPath = `/api/admin/drivers/${driver.id}/wallet/entries`
      await waitFor(async () => (await rowsOf({ path: walletPath, action: 'WALLET_ADJUSTMENT' })).length >= 2, { what: 'linha do 409' })
      await settle()
      const rows = await rowsOf({ path: walletPath, action: 'WALLET_ADJUSTMENT' })
      expect(rows.map((r) => r.outcome).sort()).toEqual(['FAILED', 'SUCCESS'])
      expect(rows.find((r) => r.outcome === 'FAILED')).toMatchObject({ httpStatus: 409, actorUserId: admin.id })
    })

    it('OPERATOR tentando ajustar saldo -> 403, nenhum WalletEntry e linha DENIED', async () => {
      const driver = await newDriver('drv-adj-403')
      const res = await request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set(auth(tenantA.staff)).send({ amountCents: 5000, description: 'tentativa de fraude' })
      expect(res.status).toBe(403)

      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { path: `/api/admin/drivers/${driver.id}/wallet/entries`, action: 'WALLET_ADJUSTMENT' } }))
      expect(row).toMatchObject({ outcome: 'DENIED', httpStatus: 403, actorUserId: tenantA.staff.id })
      expect(await prisma.wallet.count({ where: { userId: driver.id } })).toBe(0)
    })

    describe('falha da auditoria derruba o ajuste junto (mesma transação)', () => {
      const failTrigger = `zz_test_audit_fail_${suffix}`
      let saboteur: TestUser

      beforeAll(async () => {
        // Falha REAL de INSERT no banco (não mock): o trigger recusa qualquer
        // linha cujo ator tenha o marcador no nome. Só o ator "saboteur" cai
        // nele — as demais suítes (em paralelo) nunca usam esse nome.
        await prisma.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION ${failTrigger}() RETURNS trigger AS $fn$
          BEGIN
            IF NEW."actorName" LIKE 'FORCE_AUDIT_FAIL%' THEN
              RAISE EXCEPTION 'falha forçada pelo teste (${suffix})';
            END IF;
            RETURN NEW;
          END;
          $fn$ LANGUAGE plpgsql`)
        await prisma.$executeRawUnsafe(`CREATE TRIGGER ${failTrigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${failTrigger}()`)
        saboteur = await createUser({ role: 'ADMIN', label: `FORCE_AUDIT_FAIL-${suffix}`, suffix })
      })

      afterAll(async () => {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${failTrigger} ON "AuditLog"`)
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${failTrigger}()`)
      })

      it('INSERT da auditoria falha -> 500 e NADA do ajuste persiste (nem WalletEntry, nem a Wallet criada na mesma transação)', async () => {
        const driver = await newDriver('drv-adj-failclosed')
        expect(await prisma.wallet.count({ where: { userId: driver.id } })).toBe(0)

        const res = await request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set(auth(saboteur)).send({ amountCents: 7777, description: `não pode persistir ${suffix}` })
        expect(res.status).toBe(500)

        expect(await prisma.wallet.count({ where: { userId: driver.id } })).toBe(0)
        expect(await prisma.walletEntry.count({ where: { description: `não pode persistir ${suffix}` } })).toBe(0)
        expect(await prisma.auditLog.count({ where: { actorUserId: saboteur.id } })).toBe(0)
      })

      it('controle: o MESMO pedido feito por ADMIN normal (sem o marcador) persiste — o 500 acima veio do INSERT da auditoria', async () => {
        const driver = await newDriver('drv-adj-controle')
        const res = await request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set(auth(admin)).send({ amountCents: 7777, description: `persiste normalmente ${suffix}` })
        expect(res.status).toBe(201)
        expect(await prisma.walletEntry.count({ where: { description: `persiste normalmente ${suffix}` } })).toBe(1)
      })
    })
  })

  describe('varredura de segredos: nada sensível em AuditLog', () => {
    it('nenhum valor secreto (senha, segredo basic-auth, idTag completo) aparece em NENHUMA linha gerada, e nenhuma chave sensível vira campo do diff', async () => {
      const basicAuthSecret = `Segredo-Basic-Auth-${suffix}`
      const newBasicAuthSecret = `Outro-Segredo-${suffix}`
      const idTag = makeIdTag()
      const realPassword = `SenhaReal-${suffix}`
      const wrongPassword = `SenhaErrada-${suffix}`

      // Conta de staff com senha real para gerar LOGIN_SUCCESS / LOGIN_FAILED.
      const passwordHash = await bcrypt.hash(realPassword, 4)
      const loginStaff = await createUser({ role: 'OPERATOR', label: 'staff-login', suffix, operatorId: tenantA.operatorId, passwordHash })

      // Site novo do tenant A para pendurar o charge point criado pela API.
      const site = await prisma.site.create({
        data: { operatorId: tenantA.operatorId, name: `Site Sweep ${suffix}`, addressLine: 'Rua S', city: 'São Paulo', state: 'SP', postalCode: '00000-000', latitude: -23.5, longitude: -46.6 },
      })
      cleanup.siteIds.push(site.id)

      const cpRes = await request(app).post('/api/admin/charge-points').set(auth(admin)).send({ siteId: site.id, ocppIdentity: `cp-sweep-${suffix}`, basicAuthSecret })
      expect(cpRes.status).toBe(201)
      cleanup.chargePointIds.push(cpRes.body.id)
      await request(app).patch(`/api/admin/charge-points/${cpRes.body.id}`).set(auth(admin)).send({ basicAuthSecret: newBasicAuthSecret, vendor: 'ACME' }).expect(200)
      // 404 com body sensível: cai no fallback `fieldNamesOnly` (só nomes de campo, nunca valores).
      await request(app).patch('/api/admin/charge-points/nao-existe').set(auth(admin)).send({ basicAuthSecret: newBasicAuthSecret }).expect(404)

      const tokenRes = await request(app).post('/api/admin/auth-tokens').set(auth(admin)).send({ idTag, type: 'RFID' })
      expect(tokenRes.status).toBe(201)
      await request(app).patch(`/api/admin/auth-tokens/${tokenRes.body.id}`).set(auth(admin)).send({ status: 'BLOCKED' }).expect(200)
      await request(app).delete(`/api/admin/auth-tokens/${tokenRes.body.id}`).set(auth(admin)).expect(204)

      await request(app).post('/api/auth/login').send({ email: loginStaff.email, password: wrongPassword }).expect(401)
      await request(app).post('/api/auth/login').send({ email: loginStaff.email, password: realPassword }).expect(200)

      const actorIds = [admin.id, loginStaff.id]
      const rows = await waitFor(async () => {
        const found = await rowsOf({ actorUserId: { in: actorIds } })
        // 2 (CP create/patch) +1 (404) +3 (token) +2 (logins) + as demais do arquivo feitas pelo `admin`
        const login = found.filter((r) => r.actorUserId === loginStaff.id).length
        return login >= 2 && found.filter((r) => r.entityType === 'AuthToken').length >= 3 && found.filter((r) => r.entityType === 'ChargePoint').length >= 3 ? found : null
      }, { what: 'linhas para a varredura' })
      await settle()
      const all = await rowsOf({ actorUserId: { in: actorIds } })
      expect(all.length).toBeGreaterThanOrEqual(rows.length)

      const forbiddenValues = [basicAuthSecret, newBasicAuthSecret, realPassword, wrongPassword, idTag]
      const sensitiveKey = /(password|secret|token|hash|idtag)/i

      /** Todas as chaves de um JSON, recursivamente — mas NÃO os itens de `fieldNamesOnly` (lista de NOMES de campo do body de uma requisição que nem chegou a ser processada). */
      function keysOf(value: unknown, acc: string[] = []): string[] {
        if (Array.isArray(value)) value.forEach((v) => keysOf(v, acc))
        else if (value && typeof value === 'object')
          for (const [k, v] of Object.entries(value)) {
            acc.push(k)
            if (k !== 'fieldNamesOnly') keysOf(v, acc)
          }
        return acc
      }

      for (const row of all) {
        const serialized = JSON.stringify(row)
        for (const secret of forbiddenValues) {
          expect(serialized, `linha ${row.id} (${row.action} ${row.path}) vazou um valor secreto`).not.toContain(secret)
        }
        // idTag: só os 4 últimos caracteres podem aparecer (máscara), nunca mais que isso.
        expect(serialized).not.toContain(idTag.slice(-8))

        const sensitiveKeys = keysOf(row.changes).filter((k) => sensitiveKey.test(k))
        // `idTag` é o único campo sensível permitido como CHAVE — e só mascarado.
        expect(
          sensitiveKeys.filter((k) => k !== 'idTag'),
          `linha ${row.id} (${row.action} ${row.path}) tem chave sensível no diff`,
        ).toEqual([])
        if (sensitiveKeys.includes('idTag')) {
          const masked = JSON.stringify(row.changes)
          expect(masked).toMatch(/\*{4,}/)
        }
      }

      // A varredura só vale se os casos "perigosos" realmente geraram linha.
      expect(all.some((r) => r.entityType === 'AuthToken' && r.action === 'CREATE' && r.outcome === 'SUCCESS')).toBe(true)
      expect(all.some((r) => r.entityType === 'ChargePoint' && r.action === 'UPDATE' && r.outcome === 'SUCCESS')).toBe(true)
      expect(all.some((r) => r.action === 'LOGIN_FAILED')).toBe(true)
      const fieldNamesRow = all.find((r) => r.outcome === 'DENIED' && r.entityType === 'ChargePoint')
      expect(fieldNamesRow?.changes).toEqual({ fieldNamesOnly: ['basicAuthSecret'] })
    })
  })
})
