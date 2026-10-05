import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// Só o ENVIO do comando OCPP é trocado. E a POLÍTICA DE PAPEL é aberta para OPERATOR de propósito: o dia em que o dono liberar OPERATOR (DL4) é este — o escopo por operador
// tem que já estar valendo, sem ninguém lembrar de acrescentá-lo. Com a política FECHADA (padrão do lote 1) o OPERATOR nem chega aqui (ver `remoteStartAdmin.test.ts`).
const sendCommandMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/ocpp/commands', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/ocpp/commands')>()), sendCommand: sendCommandMock }))
vi.mock('../../src/core/sessao/politicaRecargaRemota', () => ({
  PAPEIS_QUE_PODEM_INICIAR_RECARGA_REMOTA: ['ADMIN', 'OPERATOR'],
  podeIniciarRecargaRemota: (papel: string | null | undefined) => papel === 'ADMIN' || papel === 'OPERATOR',
}))

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { createTenant, createUser, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * L1.5 — IDOR da consulta de comando entre OPERADORES (e escopo do disparo), com a política aberta a OPERATOR. O resultado de um comando disparado no operador A nunca pode
 * ser lido por staff do operador B — e "fora do escopo" tem que ser INDISTINGUÍVEL de "não existe" (nada confirma que o correlationId existe).
 */
describe('remote-start/consulta de comando — escopo por operador com a política aberta (L1.5, IDOR)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const REASON = 'Teste de isolamento entre operadores'

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  beforeEach(() => {
    sendCommandMock.mockReset()
    sendCommandMock.mockImplementation(() => new Promise(() => {})) // fica pendurado: só interessa o registro PENDING
  })

  async function operador(label: string) {
    const tenant = await createTenant({ suffix, label })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    return { tenant, url: `/api/admin/charge-points/${tenant.chargePointId}/commands/remote-start` }
  }

  async function motoristaComSaldo(label: string) {
    const driver = await createUser({ role: 'DRIVER', label, suffix })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'TOPUP_PIX', amountCents: 5000, balanceAfterCents: 5000 } })
    return driver
  }

  it('o comando disparado no operador A: staff de A lê (200), staff de B recebe 404 IDÊNTICO ao de um id inexistente, ADMIN lê', async () => {
    const a = await operador('esc-a')
    const b = await operador('esc-b')
    const admin = await createUser({ role: 'ADMIN', label: 'esc-admin', suffix })
    const driver = await motoristaComSaldo('esc-driver')

    const inicio = await request(app).post(a.url).set(auth(a.tenant.staff.token)).send({ connectorId: 1, userId: driver.id, reason: REASON })
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(202) // política aberta: o staff de A inicia no PRÓPRIO carregador
    const id = inicio.body.correlationId as string
    const consulta = (token: string, correlationId = id) => request(app).get(`/api/admin/commands/${correlationId}`).set(auth(token))

    const doDono = await waitFor(async () => {
      const r = await consulta(a.tenant.staff.token)
      return r.status === 200 ? r : null
    })
    expect(doDono.body).toEqual({ status: 'PENDING' })
    expect((await consulta(admin.token)).body).toEqual({ status: 'PENDING' })

    const deB = await consulta(b.tenant.staff.token)
    const inexistente = await consulta(b.tenant.staff.token, randomUUID())
    expect(deB.status).toBe(404)
    expect(deB.body.code).toBe('COMMAND_NOT_FOUND')
    expect(deB.status).toBe(inexistente.status)
    expect(deB.body).toEqual(inexistente.body) // nada denuncia que o id existe
  })

  it('o escopo vale também quando o resultado JÁ chegou (ACCEPTED): B continua sem ver', async () => {
    const a = await operador('esc2-a')
    const b = await operador('esc2-b')
    const driver = await motoristaComSaldo('esc2-driver')
    sendCommandMock.mockImplementation(async () => ({ status: 'Accepted' }))
    const inicio = await request(app).post(a.url).set(auth(a.tenant.staff.token)).send({ connectorId: 1, userId: driver.id, reason: REASON })
    const id = inicio.body.correlationId as string
    await waitFor(async () => (await request(app).get(`/api/admin/commands/${id}`).set(auth(a.tenant.staff.token))).body.status === 'ACCEPTED')
    expect((await request(app).get(`/api/admin/commands/${id}`).set(auth(b.tenant.staff.token))).status).toBe(404)
  })

  it('staff do operador B NÃO dispara no carregador do operador A (404 CHARGE_POINT_NOT_FOUND), nem cria token virtual nem envia comando', async () => {
    const a = await operador('esc3-a')
    const b = await operador('esc3-b')
    const driver = await motoristaComSaldo('esc3-driver')
    const res = await request(app).post(a.url).set(auth(b.tenant.staff.token)).send({ connectorId: 1, userId: driver.id, reason: REASON })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('CHARGE_POINT_NOT_FOUND')
    expect(sendCommandMock).not.toHaveBeenCalled()
    expect(await prisma.authToken.count({ where: { userId: driver.id, type: 'VIRTUAL' } })).toBe(0)
  })

  it('registro do formato antigo (sem escopo) gravado no Redis: nenhum OPERATOR enxerga; ADMIN sim', async () => {
    const a = await operador('esc4-a')
    const admin = await createUser({ role: 'ADMIN', label: 'esc4-admin', suffix })
    const id = randomUUID()
    await redis.set(`ocpp:cmdresult:${id}`, 'user-qualquer|ACCEPTED', 'PX', 60_000)
    expect((await request(app).get(`/api/admin/commands/${id}`).set(auth(a.tenant.staff.token))).status).toBe(404)
    expect((await request(app).get(`/api/admin/commands/${id}`).set(auth(admin.token))).body).toEqual({ status: 'ACCEPTED' })
    await redis.del(`ocpp:cmdresult:${id}`)
  })
})
