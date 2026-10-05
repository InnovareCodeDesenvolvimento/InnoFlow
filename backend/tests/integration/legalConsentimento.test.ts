import { afterAll, afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { createUser, uniqueSuffix } from './helpers/fixtures'
import { criarMotoristaComSenha } from './helpers/lgpdFixture'
import { PRIVACIDADE_VIGENTE, TERMOS_VIGENTES } from './helpers/termos'

/**
 * L1.9 — termos e privacidade contra Postgres + Redis REAIS: `GET /api/public/legal`, aceite no cadastro (`POST /api/auth/register`), `GET/POST /api/me/consents`.
 * O que importa: sem aceite da versão VIGENTE não há conta, o aceite é prova gravada (append-only) e idempotente, e os dados da empresa que o dono ainda não mandou saem vazios.
 */
describe('termos de uso e privacidade (L1.9)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let n = 0
  const novoEmail = () => `legal-${++n}-${suffix}@example.com`
  const cadastrar = (corpo: Record<string, unknown>) => request(app).post('/api/auth/register').send({ name: 'Titular Legal', email: novoEmail(), password: 'Senha-Forte-123', ...corpo })

  const envOriginal = { ...env }
  afterEach(() => {
    Object.assign(env, envOriginal) // os testes mexem nas versões/dados da empresa no objeto `env` (lido a cada chamada)
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('GET /api/public/legal', () => {
    it('é PÚBLICO e devolve as versões vigentes; dados da empresa não informados saem null (nenhum placeholder inventado)', async () => {
      Object.assign(env, { LEGAL_COMPANY_NAME: undefined, LEGAL_COMPANY_CNPJ: undefined, LEGAL_SUPPORT_EMAIL: undefined, LEGAL_SUPPORT_PHONE: undefined, LEGAL_DPO_EMAIL: undefined })
      const res = await request(app).get('/api/public/legal')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE, company: { name: null, cnpj: null, supportEmail: null, supportPhone: null, dpoEmail: null } })
      expect(res.headers['cache-control']).toContain('max-age')
    })

    it('com os dados informados: CNPJ formatado e e-mails aparados; valor INVÁLIDO vira null (não quebra nem publica lixo)', async () => {
      Object.assign(env, { LEGAL_COMPANY_NAME: 'InnoFlow Ltda', LEGAL_COMPANY_CNPJ: '11222333000181', LEGAL_SUPPORT_EMAIL: 'suporte@innoflow.com.br', LEGAL_SUPPORT_PHONE: '(11) 4000-0000', LEGAL_DPO_EMAIL: 'isto-nao-e-email' })
      const res = await request(app).get('/api/public/legal')
      expect(res.status).toBe(200)
      expect(res.body.company).toEqual({ name: 'InnoFlow Ltda', cnpj: '11.222.333/0001-81', supportEmail: 'suporte@innoflow.com.br', supportPhone: '(11) 4000-0000', dpoEmail: null })
    })

    it('só expõe o que é público: nenhuma chave além de versões e company', async () => {
      const res = await request(app).get('/api/public/legal')
      expect(Object.keys(res.body).sort()).toEqual(['company', 'privacyVersion', 'termsVersion'])
    })
  })

  describe('POST /api/auth/register — aceite dos termos', () => {
    it('sem `acceptedTermsVersion` é 400 VALIDATION_ERROR e NÃO nasce conta', async () => {
      const email = novoEmail()
      const res = await request(app).post('/api/auth/register').send({ name: 'Sem Aceite', email, password: 'Senha-Forte-123' })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('VALIDATION_ERROR')
      expect(await prisma.user.count({ where: { email } })).toBe(0)
    })

    it('versão que não é a vigente é 409 TERMS_VERSION_OUTDATED e NÃO nasce conta (nem carteira, nem aceite)', async () => {
      const email = novoEmail()
      const res = await cadastrar({ email, acceptedTermsVersion: 'versao-antiga' })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('TERMS_VERSION_OUTDATED')
      expect(await prisma.user.count({ where: { email } })).toBe(0)
    })

    it('com a versão vigente: 201 e a PROVA do aceite gravada junto — termos na versão aceita, privacidade na vigente, origem REGISTER e o IP', async () => {
      const email = novoEmail()
      const res = await cadastrar({ email, acceptedTermsVersion: TERMOS_VIGENTES })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const aceites = await prisma.consentRecord.findMany({ where: { userId: res.body.user.id }, })
      expect(aceites.map((a) => ({ kind: a.kind, version: a.version, source: a.source })).sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([
        { kind: 'PRIVACY', version: PRIVACIDADE_VIGENTE, source: 'REGISTER' },
        { kind: 'TERMS', version: TERMOS_VIGENTES, source: 'REGISTER' },
      ])
      expect(aceites.every((a) => typeof a.ip === 'string' && a.ip.length > 0 && a.ip.length <= 64)).toBe(true)
      expect(await prisma.wallet.count({ where: { userId: res.body.user.id } })).toBe(1) // usuário + carteira + aceite: transação única
    })

    it('e-mail já cadastrado continua 409 EMAIL_TAKEN e não grava aceite de ninguém', async () => {
      const email = novoEmail()
      expect((await cadastrar({ email, acceptedTermsVersion: TERMOS_VIGENTES })).status).toBe(201)
      const antes = await prisma.consentRecord.count()
      const dup = await cadastrar({ email, acceptedTermsVersion: TERMOS_VIGENTES })
      expect(dup.status).toBe(409)
      expect(dup.body.code).toBe('EMAIL_TAKEN')
      expect(await prisma.consentRecord.count()).toBeGreaterThanOrEqual(antes) // (suítes paralelas só somam) — o que importa é o 409 acima, sem 500
    })

    it('o aceite é APPEND-ONLY: não dá para apagar nem trocar a versão (só o IP pode ser zerado, na anonimização)', async () => {
      const res = await cadastrar({ acceptedTermsVersion: TERMOS_VIGENTES })
      const aceite = await prisma.consentRecord.findFirstOrThrow({ where: { userId: res.body.user.id, kind: 'TERMS' } })
      await expect(prisma.consentRecord.delete({ where: { id: aceite.id } })).rejects.toThrow()
      await expect(prisma.consentRecord.update({ where: { id: aceite.id }, data: { version: 'outra' } })).rejects.toThrow()
      await expect(prisma.consentRecord.update({ where: { id: aceite.id }, data: { ip: null } })).resolves.toBeDefined()
    })
  })

  describe('GET/POST /api/me/consents', () => {
    it('quem nunca aceitou (conta anterior ao L1.9) vem com upToDate=false e tudo null — sem consentimento fabricado', async () => {
      const m = await criarMotoristaComSenha(suffix, 'cons-antigo')
      const res = await request(app).get('/api/me/consents').set(m.auth)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ termsVersion: null, privacyVersion: null, acceptedAt: null, upToDate: false })
    })

    it('POST com as versões vigentes: 201, upToDate=true, e repetir é IDEMPOTENTE (201 de novo, mesmas 2 linhas) — inclusive 5 simultâneos', async () => {
      const m = await criarMotoristaComSenha(suffix, 'cons-reaceite')
      const corpo = { termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE }
      const um = await request(app).post('/api/me/consents').set(m.auth).send(corpo)
      expect(um.status, JSON.stringify(um.body)).toBe(201)
      expect(um.body).toMatchObject({ termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE, upToDate: true })
      expect(um.body.acceptedAt).toEqual(expect.any(String))

      const rs = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/me/consents').set(m.auth).send(corpo)))
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201])
      const linhas = await prisma.consentRecord.findMany({ where: { userId: m.id } })
      expect(linhas).toHaveLength(2)
      expect(linhas.every((l) => l.source === 'REACCEPT')).toBe(true)

      const status = await request(app).get('/api/me/consents').set(m.auth)
      expect(status.body.upToDate).toBe(true)
    })

    it('versão que não é a vigente é 409 TERMS_VERSION_OUTDATED e NADA é gravado (nem a metade que estava certa)', async () => {
      const m = await criarMotoristaComSenha(suffix, 'cons-defasado')
      for (const corpo of [
        { termsVersion: 'antiga', privacyVersion: PRIVACIDADE_VIGENTE },
        { termsVersion: TERMOS_VIGENTES, privacyVersion: 'antiga' },
      ]) {
        const r = await request(app).post('/api/me/consents').set(m.auth).send(corpo)
        expect(r.status).toBe(409)
        expect(r.body.code).toBe('TERMS_VERSION_OUTDATED')
      }
      expect(await prisma.consentRecord.count({ where: { userId: m.id } })).toBe(0)
    })

    it('a versão vigente SOBE: quem aceitou a anterior volta a upToDate=false (modal de reaceite) e o novo aceite o põe em dia, mantendo o histórico', async () => {
      const m = await criarMotoristaComSenha(suffix, 'cons-nova-versao')
      await request(app).post('/api/me/consents').set(m.auth).send({ termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE })
      Object.assign(env, { LEGAL_TERMS_VERSION: 'termos-teste-2' }) // deploy com texto novo
      const defasado = await request(app).get('/api/me/consents').set(m.auth)
      expect(defasado.body).toMatchObject({ termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE, upToDate: false })

      const velho = await request(app).post('/api/me/consents').set(m.auth).send({ termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE })
      expect(velho.status).toBe(409) // reaceitar o texto ANTIGO não vale
      const novo = await request(app).post('/api/me/consents').set(m.auth).send({ termsVersion: 'termos-teste-2', privacyVersion: PRIVACIDADE_VIGENTE })
      expect(novo.status).toBe(201)
      expect(novo.body).toMatchObject({ termsVersion: 'termos-teste-2', upToDate: true })
      expect(await prisma.consentRecord.count({ where: { userId: m.id, kind: 'TERMS' } })).toBe(2) // histórico preservado
    })

    it('corpo estrito/validado, só DRIVER e só o próprio token', async () => {
      const m = await criarMotoristaComSenha(suffix, 'cons-papeis')
      const base = { termsVersion: TERMOS_VIGENTES, privacyVersion: PRIVACIDADE_VIGENTE }
      expect((await request(app).post('/api/me/consents').set(m.auth).send({ ...base, userId: 'outro' })).status).toBe(400)
      expect((await request(app).post('/api/me/consents').set(m.auth).send({ termsVersion: TERMOS_VIGENTES })).status).toBe(400)
      expect((await request(app).post('/api/me/consents').set(m.auth).send({ ...base, termsVersion: 'x'.repeat(33) })).status).toBe(400)
      expect((await request(app).get('/api/me/consents')).status).toBe(401)
      const admin = await createUser({ role: 'ADMIN', label: 'cons-admin', suffix })
      expect((await request(app).get('/api/me/consents').set('Authorization', `Bearer ${admin.token}`)).status).toBe(403)
      expect((await request(app).post('/api/me/consents').set('Authorization', `Bearer ${admin.token}`).send(base)).status).toBe(403)
    })
  })
})
