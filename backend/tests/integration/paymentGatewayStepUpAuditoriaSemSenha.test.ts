import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * QA da Íris (F5.8, rodada Vega-2) — mutante S2 que sobreviveu: apagar o `delete req.body.currentPassword` do PUT do gateway não deixava nenhum teste
 * vermelho. A razão: o único teste de auditoria olha o caminho "senha ERRADA" (que descreve a linha com `changes: null`) e o de sucesso (`skip: true`).
 * O caminho que depende do `delete` é outro: senha CERTA e, DEPOIS do step-up, uma recusa de negócio (400/409/503) — aí quem grava a linha é o
 * middleware GENÉRICO de auditoria, que registra os NOMES dos campos do `req.body`. Sem o `delete`, o nome `currentPassword` (e só o nome: o middleware
 * nunca guarda valor) passa a constar na trilha de auditoria de toda recusa — e se um dia o middleware passar a guardar valores, a senha vai junto.
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  issueToken: typeof import('../../src/lib/jwt').issueToken
}

describe('step-up: a trilha de auditoria de uma recusa de negócio PÓS-senha não registra a senha (nem o nome do campo) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgu')
    const [appMod, prismaMod, redisMod, jwtMod] = await Promise.all([import('../../src/api/app'), import('../../src/lib/prisma'), import('../../src/lib/redis'), import('../../src/lib/jwt')])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, issueToken: jwtMod.issueToken }
    app = m.createApp()
  }, 120_000)

  afterAll(async () => {
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  async function novoAdmin() {
    contador += 1
    const user = await m.prisma.user.create({ data: { role: 'ADMIN', name: `Admin ${contador}`, email: `admin-aud-${contador}-${Math.random().toString(36).slice(2, 7)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'ADMIN', operatorId: null }) }
  }
  async function linhasDeAuditoria(userId: string, minimo: number) {
    const limite = Date.now() + 8000
    let linhas = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    while (linhas.length < minimo && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 50))
      linhas = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    }
    return linhas
  }

  it('senha CERTA + recusa de negócio 409 GATEWAY_NOT_READY (e 400, que não é auditado): a linha de auditoria lista os campos do PUT mas NUNCA currentPassword', async () => {
    const admin = await novoAdmin()
    const put = (corpo: Record<string, unknown>) => request(app).put('/api/admin/payment-gateway').set({ Authorization: `Bearer ${admin.token}` }).send({ currentPassword: SENHA_ADMIN_TESTE, ...corpo })

    const naoPronto = await put({ cardEnabled: true }) // sem pré-requisito de cartão => 409 depois do step-up
    expect(naoPronto.status, JSON.stringify(naoPronto.body)).toBe(409)
    const semConfirmacao = await put({ environment: 'production' }) // => 400 depois do step-up (400 NÃO é auditado pelo middleware: só 403/404/5xx e demais 4xx)
    expect(semConfirmacao.status, JSON.stringify(semConfirmacao.body)).toBe(400)

    const linhas = await linhasDeAuditoria(admin.id, 1)
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ outcome: 'FAILED', httpStatus: 409, action: 'UPDATE' })
    const dump = JSON.stringify(linhas)
    // controle positivo: a trilha registra os NOMES dos campos que o admin tentou mudar
    expect(dump).toContain('cardEnabled')
    // o que não pode estar: nem o valor, nem o nome do campo da senha
    expect(dump).not.toContain(SENHA_ADMIN_TESTE)
    expect(dump).not.toContain('currentPassword')
  })
})
