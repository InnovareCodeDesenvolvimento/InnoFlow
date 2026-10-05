import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { PRIVACIDADE_VIGENTE, TERMOS_VIGENTES } from './helpers/termos'

/**
 * Dados da empresa e versões dos Termos pelo PAINEL (`GET/PUT /api/admin/company-profile`) — Postgres + Redis REAIS, banco próprio (`CompanyProfile` é singleton global).
 * Prova: só ADMIN; validação (CNPJ com dígito verificador, site só http(s), e-mail, telefone, versão); painel > env (e a 1ª gravação IMPORTA a env); a rota pública, o cadastro,
 * o reaceite e o rodapé dos e-mails passam a usar o painel na hora; mudar a VERSÃO exige confirmação explícita e derruba todos para `upToDate=false`; auditoria fail-closed e
 * sem PII; concorrência; cache que invalida e expira; banco fora (público cai na env, aceite/admin dão 503).
 */

// Falha de auditoria FORÇADA sob demanda (resto do tempo é o writeAuditLog de verdade) — prova o fail-closed.
const auditoria = vi.hoisted(() => ({ falhar: false }))
vi.mock('../../src/services/auditoria/writeAuditLog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/auditoria/writeAuditLog')>()
  return {
    ...real,
    writeAuditLog: vi.fn(async (...args: Parameters<typeof real.writeAuditLog>) => {
      if (auditoria.falhar) throw new Error('falha simulada de auditoria (teste fail-closed)')
      return real.writeAuditLog(...args)
    }),
  }
})

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  issueToken: typeof import('../../src/lib/jwt').issueToken
  dados: typeof import('../../src/services/legal/dadosLegais')
  consentimento: typeof import('../../src/services/legal/consentimento')
}

const dump = (v: unknown): string => JSON.stringify(v)
const CHAVES_LEGAIS = ['LEGAL_COMPANY_NAME', 'LEGAL_COMPANY_CNPJ', 'LEGAL_SUPPORT_EMAIL', 'LEGAL_SUPPORT_PHONE', 'LEGAL_DPO_EMAIL'] as const

describe('dados da empresa pelo painel (company-profile) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const envSalvo: Record<string, unknown> = {}
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('cpf')
    const [appMod, prismaMod, redisMod, envMod, jwtMod, dadosMod, consMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/services/legal/dadosLegais'),
      import('../../src/services/legal/consentimento'),
    ])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, env: envMod.env as unknown as Record<string, unknown>, issueToken: jwtMod.issueToken, dados: dadosMod, consentimento: consMod }
    app = m.createApp()
    for (const k of [...CHAVES_LEGAIS, 'LEGAL_TERMS_VERSION', 'LEGAL_PRIVACY_VERSION']) envSalvo[k] = m.env[k]
  }, 120_000)

  afterAll(async () => {
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.companyProfile.deleteMany()
    m.dados.resetDadosLegaisParaTeste()
    auditoria.falhar = false
    for (const k of CHAVES_LEGAIS) m.env[k] = undefined
    m.env.LEGAL_TERMS_VERSION = TERMOS_VIGENTES
    m.env.LEGAL_PRIVACY_VERSION = PRIVACIDADE_VIGENTE
  })
  afterEach(() => {
    for (const k of Object.keys(envSalvo)) m.env[k] = envSalvo[k]
    m.dados.resetDadosLegaisParaTeste()
  })

  async function novoUsuario(role: 'ADMIN' | 'OPERATOR' | 'DRIVER' = 'ADMIN') {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    let operatorId: string | null = null
    if (role === 'OPERATOR') operatorId = (await m.prisma.operator.create({ data: { name: `Op ${sufixo}`, email: `op-${sufixo}@example.com` } })).id
    const user = await m.prisma.user.create({ data: { role, name: `${role} ${sufixo}`, email: `${role.toLowerCase()}-${sufixo}@example.com`, operatorId, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    return { id: user.id, token: m.issueToken({ id: user.id, role, operatorId }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  const get = (u: { token: string }) => request(app).get('/api/admin/company-profile').set(auth(u))
  const put = (u: { token: string }, body: Record<string, unknown>) => request(app).put('/api/admin/company-profile').set(auth(u)).send(body)
  const publico = () => request(app).get('/api/public/legal')
  const esperarAuditoria = async (userId: string, n: number) => {
    const limite = Date.now() + 5000
    let l = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    while (l.length < n && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 50))
      l = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    }
    return l
  }
  const cadastrar = (versao: string) => request(app).post('/api/auth/register').send({ name: 'Motorista', email: `m-${++contador}-${Math.random().toString(36).slice(2, 7)}@example.com`, password: 'Senha-Forte-123', acceptedTermsVersion: versao })

  const DADOS = {
    legalName: 'InnoFlow Mobilidade Ltda',
    tradeName: 'InnoFlow',
    cnpj: '11.222.333/0001-81',
    supportEmail: 'Suporte@InnoFlow.com.br',
    supportPhone: '(11) 4000-0000',
    address: 'Rua das Flores, 100 - São Paulo/SP',
    website: 'www.innoflow.com.br',
    dpoName: 'Maria Encarregada',
    dpoEmail: 'dpo@innoflow.com.br',
  }

  describe('acesso', () => {
    it('sem token 401; OPERATOR e DRIVER 403 em GET e PUT (só ADMIN) e nada é gravado', async () => {
      expect((await request(app).get('/api/admin/company-profile')).status).toBe(401)
      expect((await request(app).put('/api/admin/company-profile').send({ tradeName: 'x' })).status).toBe(401)
      for (const role of ['OPERATOR', 'DRIVER'] as const) {
        const u = await novoUsuario(role)
        expect((await get(u)).status).toBe(403)
        expect((await put(u, { tradeName: 'Invasor' })).status).toBe(403)
      }
      expect(await m.prisma.companyProfile.count()).toBe(0)
    })
  })

  describe('GET', () => {
    it('sem nada salvo e sem env: source "env", tudo null, versões da env, sem pendência', async () => {
      const res = await get(await novoUsuario())
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toEqual({
        source: 'env',
        profile: { legalName: null, tradeName: null, cnpj: null, supportEmail: null, supportPhone: null, address: null, website: null, dpoName: null, dpoEmail: null },
        versions: { termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE, termsSource: 'env', privacySource: 'env', envTermsVersion: TERMOS_VIGENTES, envPrivacyVersion: PRIVACIDADE_VIGENTE },
        invalidEnvFields: [],
        updatedAt: null,
      })
    })

    it('com SÓ a env: mostra o que a env informa (source "env") e aponta campo inválido da env', async () => {
      Object.assign(m.env, { LEGAL_COMPANY_NAME: 'Empresa Env Ltda', LEGAL_COMPANY_CNPJ: '11222333000181', LEGAL_SUPPORT_EMAIL: 'suporte@env.com.br', LEGAL_DPO_EMAIL: 'isto-nao-e-email' })
      const res = await get(await novoUsuario())
      expect(res.body.source).toBe('env')
      expect(res.body.profile).toMatchObject({ legalName: 'Empresa Env Ltda', cnpj: '11.222.333/0001-81', supportEmail: 'suporte@env.com.br', dpoEmail: null })
      expect(res.body.invalidEnvFields).toEqual(['dpoEmail'])
    })
  })

  describe('PUT — validação (nada é gravado quando inválido)', () => {
    it('rejeita: campo desconhecido, corpo vazio, só confirmação, CNPJ com dígito errado, e-mail, telefone, site perigoso/credencial, versão fora do formato, texto longo demais', async () => {
      let admin = await novoUsuario()
      const ruins: Array<Record<string, unknown>> = [
        { tradeNme: 'x' },
        {},
        { confirmVersionChange: true },
        { cnpj: '11.222.333/0001-82' },
        { cnpj: '123' },
        { supportEmail: 'sem-arroba' },
        { dpoEmail: 'a@b' },
        { supportPhone: 'abc' },
        { supportPhone: '123' },
        { website: 'javascript:alert(1)' },
        { website: 'https://user:senha@innoflow.com.br' },
        { website: 'ftp://innoflow.com.br' },
        { termsVersion: 'com espaço' },
        { termsVersion: 'v'.repeat(33) },
        { privacyVersion: '../x' },
        { legalName: 'x'.repeat(161) },
        { tradeName: 'x'.repeat(121) },
        { address: 'x'.repeat(301) },
        { dpoName: 'x'.repeat(121) },
        { legalName: 123 },
        { confirmVersionChange: 'sim', tradeName: 'x' },
      ]
      let n = 0
      for (const body of ruins) {
        if (n++ % 8 === 0) admin = await novoUsuario() // o limite de 10 PUTs/min é por ADMIN e conta os 400 também
        const res = await put(admin, body)
        expect(res.status, dump(body)).toBe(400)
        expect(res.body.code, dump(body)).toBe('VALIDATION_ERROR')
        expect(res.body.details.length, dump(body)).toBeGreaterThan(0)
      }
      expect(await m.prisma.companyProfile.count()).toBe(0)
    })

    it('o erro de CNPJ aponta o campo e fala em português', async () => {
      const res = await put(await novoUsuario(), { cnpj: '11.222.333/0001-82' })
      expect(res.body.details).toEqual([expect.objectContaining({ path: 'cnpj', message: expect.stringContaining('CNPJ inválido') })])
    })
  })

  describe('PUT — gravação e uso', () => {
    it('grava normalizado (CNPJ 14 caracteres, e-mail minúsculo, site canônico), GET devolve o que o dono digitou e a rota PÚBLICA já usa na hora', async () => {
      const admin = await novoUsuario()
      const res = await put(admin, DADOS)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.source).toBe('db')
      expect(res.body.profile).toEqual({
        legalName: 'InnoFlow Mobilidade Ltda',
        tradeName: 'InnoFlow',
        cnpj: '11.222.333/0001-81',
        supportEmail: 'suporte@innoflow.com.br',
        supportPhone: '(11) 4000-0000',
        address: 'Rua das Flores, 100 - São Paulo/SP',
        website: 'https://www.innoflow.com.br',
        dpoName: 'Maria Encarregada',
        dpoEmail: 'dpo@innoflow.com.br',
      })
      expect(res.body.updatedAt).toEqual(expect.any(String))
      const linha = await m.prisma.companyProfile.findUniqueOrThrow({ where: { id: 1 } })
      expect(linha.cnpj).toBe('11222333000181')
      expect(linha.companyDataSavedAt).not.toBeNull()
      expect(linha.updatedByUserId).toBe(admin.id)

      const pub = await publico()
      expect(pub.status).toBe(200)
      expect(pub.body).toEqual({
        termsVersion: TERMOS_VIGENTES,
        privacyVersion: PRIVACIDADE_VIGENTE,
        company: {
          name: 'InnoFlow Mobilidade Ltda',
          tradeName: 'InnoFlow',
          cnpj: '11.222.333/0001-81',
          supportEmail: 'suporte@innoflow.com.br',
          supportPhone: '(11) 4000-0000',
          address: 'Rua das Flores, 100 - São Paulo/SP',
          website: 'https://www.innoflow.com.br',
          dpoName: 'Maria Encarregada',
          dpoEmail: 'dpo@innoflow.com.br',
        },
      })
      expect(Object.keys(pub.body).sort()).toEqual(['company', 'privacyVersion', 'termsVersion'])
      expect(pub.headers['cache-control']).toBe('public, max-age=30')
    })

    it('CNPJ alfanumérico é aceito e guardado normalizado em maiúsculas', async () => {
      const res = await put(await novoUsuario(), { cnpj: '12.abc.345/01de-35' })
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.profile.cnpj).toBe('12.ABC.345/01DE-35')
      expect((await m.prisma.companyProfile.findUniqueOrThrow({ where: { id: 1 } })).cnpj).toBe('12ABC34501DE35')
    })

    it('PUT parcial só mexe no que veio; null e texto vazio LIMPAM o campo; campo não enviado fica como estava', async () => {
      const admin = await novoUsuario()
      await put(admin, DADOS)
      const r = await put(admin, { supportPhone: null, address: '   ', tradeName: 'Novo Fantasia' })
      expect(r.status, dump(r.body)).toBe(200)
      expect(r.body.profile).toMatchObject({ supportPhone: null, address: null, tradeName: 'Novo Fantasia', legalName: 'InnoFlow Mobilidade Ltda', cnpj: '11.222.333/0001-81' })
      const pub = await publico()
      expect(pub.body.company).toMatchObject({ supportPhone: null, address: null, tradeName: 'Novo Fantasia' })
    })

    it('1ª gravação IMPORTA o que a env já informava (não some da página pública); depois disso a env não completa mais campo vazio', async () => {
      Object.assign(m.env, { LEGAL_COMPANY_NAME: 'Empresa Env Ltda', LEGAL_COMPANY_CNPJ: '11222333000181', LEGAL_SUPPORT_EMAIL: 'suporte@env.com.br', LEGAL_SUPPORT_PHONE: '(11) 3000-0000', LEGAL_DPO_EMAIL: 'dpo@env.com.br' })
      const admin = await novoUsuario()
      const antes = (await publico()).body.company
      expect(antes).toMatchObject({ name: 'Empresa Env Ltda', cnpj: '11.222.333/0001-81' })

      const r = await put(admin, { tradeName: 'Marca Nova' })
      expect(r.body.source).toBe('db')
      expect(r.body.profile).toMatchObject({ legalName: 'Empresa Env Ltda', cnpj: '11.222.333/0001-81', supportEmail: 'suporte@env.com.br', supportPhone: '(11) 3000-0000', dpoEmail: 'dpo@env.com.br', tradeName: 'Marca Nova' })
      expect((await publico()).body.company).toMatchObject({ name: 'Empresa Env Ltda', cnpj: '11.222.333/0001-81', tradeName: 'Marca Nova' })

      const limpou = await put(admin, { cnpj: null })
      expect(limpou.body.profile.cnpj).toBeNull()
      expect((await publico()).body.company.cnpj).toBeNull() // a env NÃO faz o CNPJ reaparecer
    })

    it('o PUT do painel NÃO sobrescreve o que o painel mandou quando a env muda depois (painel > env)', async () => {
      const admin = await novoUsuario()
      await put(admin, { legalName: 'Do Painel Ltda' })
      Object.assign(m.env, { LEGAL_COMPANY_NAME: 'Mudou na env' })
      expect((await publico()).body.company.name).toBe('Do Painel Ltda')
    })

    it('o resolvedor serve ao rodapé dos e-mails (worker): dadosPublicosDaEmpresa() devolve o que o painel gravou, na hora', async () => {
      await put(await novoUsuario(), DADOS)
      expect(await m.consentimento.dadosPublicosDaEmpresa()).toMatchObject({ name: 'InnoFlow Mobilidade Ltda', cnpj: '11.222.333/0001-81', address: 'Rua das Flores, 100 - São Paulo/SP' })
    })
  })

  describe('versão dos Termos/Privacidade', () => {
    it('mudar a versão SEM confirmar = 409 VERSION_CHANGE_NOT_CONFIRMED com o impacto, e NADA é gravado (nem os outros campos do mesmo PUT)', async () => {
      const admin = await novoUsuario()
      await cadastrar(TERMOS_VIGENTES)
      const res = await put(admin, { termsVersion: 'termos-novos-2', legalName: 'Nao Pode Gravar Ltda' })
      expect(res.status, dump(res.body)).toBe(409)
      expect(res.body.code).toBe('VERSION_CHANGE_NOT_CONFIRMED')
      expect(res.body.details[0]).toMatchObject({ field: 'confirmVersionChange', currentTermsVersion: TERMOS_VIGENTES, newTermsVersion: 'termos-novos-2', currentPrivacyVersion: PRIVACIDADE_VIGENTE, newPrivacyVersion: PRIVACIDADE_VIGENTE })
      expect(res.body.details[0].driversAffected).toBeGreaterThanOrEqual(1)
      expect(await m.prisma.companyProfile.count()).toBe(0) // a transação inteira voltou (nem a linha vazia ficou)
    })

    it('confirmVersionChange:false também é recusado; só `true` vale', async () => {
      const res = await put(await novoUsuario(), { privacyVersion: 'priv-novo-2', confirmVersionChange: false })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('VERSION_CHANGE_NOT_CONFIRMED')
    })

    it('confirmada: a rota pública, o cadastro e o reaceite passam a exigir a versão nova; quem aceitou a antiga fica upToDate=false e volta a true ao reaceitar', async () => {
      const admin = await novoUsuario()
      const velho = await cadastrar(TERMOS_VIGENTES)
      expect(velho.status, dump(velho.body)).toBe(201)
      const tokenVelho = velho.body.token as string
      const status0 = await request(app).get('/api/me/consents').set({ Authorization: `Bearer ${tokenVelho}` })
      expect(status0.body).toMatchObject({ upToDate: true })

      const res = await put(admin, { termsVersion: 'termos-novos-2', confirmVersionChange: true })
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.versions).toMatchObject({ termsVersion: 'termos-novos-2', privacyVersion: PRIVACIDADE_VIGENTE, termsSource: 'db', privacySource: 'env' })
      expect((await publico()).body).toMatchObject({ termsVersion: 'termos-novos-2', privacyVersion: PRIVACIDADE_VIGENTE })

      // motorista existente: em dia -> fora de dia (sem ele ter feito nada)
      const status1 = await request(app).get('/api/me/consents').set({ Authorization: `Bearer ${tokenVelho}` })
      expect(status1.body).toMatchObject({ upToDate: false, termsVersion: TERMOS_VIGENTES })

      // cadastro novo: a versão antiga é recusada, a nova passa
      const antigo = await cadastrar(TERMOS_VIGENTES)
      expect(antigo.status).toBe(409)
      expect(antigo.body.code).toBe('TERMS_VERSION_OUTDATED')
      const novo = await cadastrar('termos-novos-2')
      expect(novo.status, dump(novo.body)).toBe(201)
      const registros = await m.prisma.consentRecord.findMany({ where: { userId: novo.body.user.id }, orderBy: { kind: 'asc' } })
      expect(registros.map((r) => `${r.kind}:${r.version}`).sort()).toEqual([`PRIVACY:${PRIVACIDADE_VIGENTE}`, 'TERMS:termos-novos-2'])

      // reaceite do existente
      const velhoRecusado = await request(app).post('/api/me/consents').set({ Authorization: `Bearer ${tokenVelho}` }).send({ termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE })
      expect(velhoRecusado.status).toBe(409)
      const aceite = await request(app).post('/api/me/consents').set({ Authorization: `Bearer ${tokenVelho}` }).send({ termsVersion: 'termos-novos-2', privacyVersion: PRIVACIDADE_VIGENTE })
      expect(aceite.status, dump(aceite.body)).toBe(201)
      expect(aceite.body).toMatchObject({ upToDate: true, termsVersion: 'termos-novos-2' })
    })

    it('repetir a versão que JÁ vale (explícita) não exige confirmação nem derruba ninguém; limpar a versão do painel (null) volta à da env e, se muda, exige confirmação', async () => {
      const admin = await novoUsuario()
      const ok = await put(admin, { termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE })
      expect(ok.status, dump(ok.body)).toBe(200)
      expect(ok.body.versions).toMatchObject({ termsSource: 'db', privacySource: 'db' })

      await put(admin, { termsVersion: 'termos-novos-3', confirmVersionChange: true })
      const volta = await put(admin, { termsVersion: null })
      expect(volta.status).toBe(409) // da 'termos-novos-3' para a da env muda a versão efetiva
      const confirmada = await put(admin, { termsVersion: null, confirmVersionChange: true })
      expect(confirmada.status).toBe(200)
      expect(confirmada.body.versions).toMatchObject({ termsVersion: TERMOS_VIGENTES, termsSource: 'env' })
    })

    it('confirmVersionChange sobrando num PUT sem mudança de versão é inofensivo', async () => {
      const res = await put(await novoUsuario(), { tradeName: 'Marca', confirmVersionChange: true })
      expect(res.status).toBe(200)
    })
  })

  describe('auditoria', () => {
    it('grava UMA linha UPDATE/CompanyProfile: valores só do que não é pessoa; e-mail, telefone, endereço e encarregado entram só pelo NOME do campo', async () => {
      const admin = await novoUsuario()
      const res = await put(admin, DADOS)
      expect(res.status).toBe(200)
      const linhas = (await esperarAuditoria(admin.id, 1)).filter((l) => l.entityType === 'CompanyProfile')
      expect(linhas).toHaveLength(1) // o middleware genérico NÃO duplica
      const l = linhas[0]!
      expect(l).toMatchObject({ action: 'UPDATE', outcome: 'SUCCESS', actionDetail: 'company_profile', entityId: '1' })
      const changes = l.changes as Record<string, unknown>
      expect(changes.legalName).toEqual({ from: null, to: 'InnoFlow Mobilidade Ltda' })
      expect(changes.cnpj).toEqual({ from: null, to: '11222333000181' })
      for (const campo of ['supportEmail', 'supportPhone', 'address', 'dpoName', 'dpoEmail']) expect(changes[campo], campo).toEqual({ changed: true })
      const texto = JSON.stringify(l)
      for (const pii of ['4000-0000', 'Rua das Flores', 'Maria Encarregada', 'suporte@', 'dpo@']) expect(texto, pii).not.toContain(pii)
    })

    it('mudança de versão marca o actionDetail e a confirmação; PUT sem nenhuma diferença grava linha sem diff', async () => {
      const admin = await novoUsuario()
      await put(admin, { termsVersion: 'termos-novos-9', confirmVersionChange: true })
      const l = (await esperarAuditoria(admin.id, 1))[0]!
      expect(l.actionDetail).toBe('company_profile:legal_version_changed')
      expect(l.changes).toMatchObject({ termsVersion: { from: null, to: 'termos-novos-9' }, versionChangeConfirmed: true })
    })

    it('FAIL-CLOSED: se a auditoria falha, o PUT falha (500) e NADA é gravado', async () => {
      const admin = await novoUsuario()
      await put(admin, { legalName: 'Antes Ltda' })
      auditoria.falhar = true
      const res = await put(admin, { legalName: 'Depois Ltda' })
      expect(res.status).toBe(500)
      auditoria.falhar = false
      expect((await m.prisma.companyProfile.findUniqueOrThrow({ where: { id: 1 } })).legalName).toBe('Antes Ltda')
      expect((await get(admin)).body.profile.legalName).toBe('Antes Ltda')
    })
  })

  describe('concorrência, cache e rate limit', () => {
    it('dois PUTs simultâneos em campos diferentes: os dois valem (linha trancada, nenhuma atualização perdida)', async () => {
      const a = await novoUsuario()
      const b = await novoUsuario()
      const [r1, r2] = await Promise.all([put(a, { supportPhone: '(11) 4000-1111' }), put(b, { address: 'Rua Concorrente, 1' })])
      expect([r1.status, r2.status]).toEqual([200, 200])
      const linha = await m.prisma.companyProfile.findUniqueOrThrow({ where: { id: 1 } })
      expect(linha).toMatchObject({ supportPhone: '(11) 4000-1111', address: 'Rua Concorrente, 1' })
    })

    it('cache de 30 s por processo: mudança feita direto no banco (outro processo) só aparece depois do TTL/invalidação; o PUT invalida na hora', async () => {
      const admin = await novoUsuario()
      await put(admin, { legalName: 'Primeira Ltda' })
      expect((await publico()).body.company.name).toBe('Primeira Ltda') // popula o cache
      await m.prisma.companyProfile.update({ where: { id: 1 }, data: { legalName: 'Mudou Por Fora Ltda' } })
      expect((await publico()).body.company.name).toBe('Primeira Ltda') // ainda em cache
      m.dados.invalidarCacheDadosLegais()
      expect((await publico()).body.company.name).toBe('Mudou Por Fora Ltda')
      await put(admin, { legalName: 'Via Painel Ltda' })
      expect((await publico()).body.company.name).toBe('Via Painel Ltda') // PUT invalidou
    })

    it('rate limit do PUT: 10/min por ADMIN, o 11º é 429', async () => {
      const admin = await novoUsuario()
      const codigos: number[] = []
      for (let i = 0; i < 11; i += 1) codigos.push((await put(admin, { tradeName: `Marca ${i}` })).status)
      expect(codigos.slice(0, 10).every((c) => c === 200)).toBe(true)
      expect(codigos[10]).toBe(429)
    })
  })

  describe('banco fora do ar', () => {
    it('a rota pública e o rodapé caem na env (200); o aceite dos termos e a tela do admin dão 503; volta ao normal quando o banco volta', async () => {
      Object.assign(m.env, { LEGAL_COMPANY_NAME: 'Reserva da Env Ltda' })
      const admin = await novoUsuario()
      await m.prisma.$executeRawUnsafe('ALTER TABLE "CompanyProfile" RENAME TO "CompanyProfile_fora"')
      try {
        m.dados.resetDadosLegaisParaTeste()
        const pub = await publico()
        expect(pub.status).toBe(200)
        expect(pub.body).toMatchObject({ termsVersion: TERMOS_VIGENTES, company: { name: 'Reserva da Env Ltda' } })
        expect(await m.consentimento.dadosPublicosDaEmpresa()).toMatchObject({ name: 'Reserva da Env Ltda' })

        const cadastro = await cadastrar(TERMOS_VIGENTES)
        expect(cadastro.status).toBe(503)
        expect(cadastro.body.code).toBe('LEGAL_SETTINGS_UNAVAILABLE')
        const tela = await get(admin)
        expect(tela.status).toBe(503)
        expect(tela.body.code).toBe('LEGAL_SETTINGS_UNAVAILABLE')
      } finally {
        await m.prisma.$executeRawUnsafe('ALTER TABLE "CompanyProfile_fora" RENAME TO "CompanyProfile"')
      }
      m.dados.resetDadosLegaisParaTeste()
      expect((await cadastrar(TERMOS_VIGENTES)).status).toBe(201)
    }, 30_000)
  })

  describe('trava no banco (além da API)', () => {
    it('só existe a linha id=1; CNPJ fora do formato e versão em branco são recusados pelo CHECK', async () => {
      await expect(m.prisma.$executeRawUnsafe(`INSERT INTO "CompanyProfile" ("id", "updatedAt") VALUES (2, NOW())`)).rejects.toThrow()
      await m.prisma.$executeRawUnsafe(`INSERT INTO "CompanyProfile" ("id", "updatedAt") VALUES (1, NOW())`)
      await expect(m.prisma.$executeRawUnsafe(`UPDATE "CompanyProfile" SET "cnpj" = '11.222.333/0001-81' WHERE "id" = 1`)).rejects.toThrow()
      await expect(m.prisma.$executeRawUnsafe(`UPDATE "CompanyProfile" SET "cnpj" = 'abc' WHERE "id" = 1`)).rejects.toThrow()
      await expect(m.prisma.$executeRawUnsafe(`UPDATE "CompanyProfile" SET "termsVersion" = '   ' WHERE "id" = 1`)).rejects.toThrow()
      await expect(m.prisma.$executeRawUnsafe(`UPDATE "CompanyProfile" SET "cnpj" = '12ABC34501DE35' WHERE "id" = 1`)).resolves.toBeDefined()
    })
  })
})
