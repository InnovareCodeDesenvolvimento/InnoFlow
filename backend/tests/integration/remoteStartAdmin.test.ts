import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// Só o ENVIO do comando OCPP é trocado (o gateway real não existe aqui): o resultado fica sob controle do teste. Rota, validação, política de papel, auditoria, Redis e Postgres são os reais.
const sendCommandMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/ocpp/commands', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/ocpp/commands')>()), sendCommand: sendCommandMock }))

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { OcppCommandTimeoutError } from '../../src/ocpp/commands'
import { createTenant, createUser, settle, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * L1.5 — `POST /api/admin/charge-points/:id/commands/remote-start` com `reason` obrigatório e política DL4 (só ADMIN), e `GET /api/admin/commands/:correlationId`.
 * O isolamento ENTRE OPERADORES (IDOR) com a política aberta está em `remoteStartPoliticaEscopo.test.ts`.
 */
describe('remote-start admin (L1.5) — reason obrigatório, ADMIN-only (DL4) e consulta do comando', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const REASON = 'Cliente sem bateria no celular, recarga assistida'

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  beforeEach(() => {
    sendCommandMock.mockReset()
  })

  /** Operador + carregador ONLINE com conector livre e tarifa, um ADMIN e um motorista com saldo. */
  async function cenario(label: string) {
    const tenant = await createTenant({ suffix, label })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    const admin = await createUser({ role: 'ADMIN', label: `admin-${label}`, suffix })
    const driver = await createUser({ role: 'DRIVER', label: `driver-${label}`, suffix })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'TOPUP_PIX', amountCents: 5000, balanceAfterCents: 5000 } })
    const url = `/api/admin/charge-points/${tenant.chargePointId}/commands/remote-start`
    const corpo = (over: Record<string, unknown> = {}) => ({ connectorId: 1, userId: driver.id, reason: REASON, ...over })
    const virtualTokens = () => prisma.authToken.count({ where: { userId: driver.id, type: 'VIRTUAL' } })
    return { tenant, admin, driver, url, corpo, virtualTokens }
  }

  /** Comando OCPP "pendurado" até o teste decidir (aceito/recusado/timeout). */
  function comandoControlavel() {
    let resolver!: (v: unknown) => void
    let rejeitar!: (e: unknown) => void
    sendCommandMock.mockImplementation(() => new Promise((res, rej) => { resolver = res; rejeitar = rej }))
    return { aceitar: () => resolver({ status: 'Accepted' }), recusar: () => resolver({ status: 'Rejected' }), estourarPrazo: () => rejeitar(new OcppCommandTimeoutError('timeout simulado')) }
  }

  const consultar = (correlationId: string, token: string) => request(app).get(`/api/admin/commands/${correlationId}`).set(auth(token))

  it('sem reason, curto (<10 após trim), longo (>200), só espaços, com quebra de linha ou não-string -> 400 VALIDATION_ERROR no campo reason; NADA acontece (sem comando, sem token virtual)', async () => {
    const c = await cenario('rs-valida')
    const invalidos: unknown[] = [undefined, '', '         ', 'curto 123', '   curto 12   ', 'x'.repeat(201), 'motivo valido\ncom quebra de linha', 'motivo\tcom tab aqui', 12345678901, null]
    for (const reason of invalidos) {
      const body = reason === undefined ? { connectorId: 1, userId: c.driver.id } : c.corpo({ reason })
      const res = await request(app).post(c.url).set(auth(c.admin.token)).send(body)
      expect(res.status, JSON.stringify(reason)).toBe(400)
      expect(res.body.code).toBe('VALIDATION_ERROR')
      expect(JSON.stringify(res.body.details)).toContain('reason')
    }
    expect(sendCommandMock).not.toHaveBeenCalled()
    expect(await c.virtualTokens()).toBe(0)
  })

  it('reason válido (10 e 200 caracteres são aceitos): 202, comando enviado UMA vez, e a auditoria leva quem, para quem, o motivo (aparado) e o correlationId', async () => {
    const c = await cenario('rs-ok')
    comandoControlavel()
    const res = await request(app).post(c.url).set(auth(c.admin.token)).send(c.corpo({ reason: `   ${REASON}   ` }))
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(res.body).toMatchObject({ status: 'PENDING', correlationId: expect.any(String), walletBalanceCents: 5000 })
    expect(sendCommandMock).toHaveBeenCalledTimes(1)
    expect(sendCommandMock.mock.calls[0]![1]).toBe('RemoteStartTransaction')

    const linha = await waitFor(() => prisma.auditLog.findFirst({ where: { correlationId: res.body.correlationId } }))
    expect(linha.actorUserId).toBe(c.admin.id)
    expect(linha.action).toBe('REMOTE_COMMAND')
    expect(linha.outcome).toBe('SUCCESS')
    expect(linha.entityId).toBe(c.tenant.chargePointId)
    expect(linha.actionDetail).toBe(`RemoteStartTransaction (userId=${c.driver.id}, reason=${REASON})`)

    // limites: 10 e 200 passam (cada um em um carregador livre novo — o conector fica ocupado só quando o carregador responde, aqui nunca)
    for (const reason of ['a'.repeat(10), 'b'.repeat(200)]) {
      const r = await request(app).post(c.url).set(auth(c.admin.token)).send(c.corpo({ reason }))
      expect(r.status, `reason de ${reason.length}`).toBe(202)
    }
  })

  it('DL4: OPERATOR do PRÓPRIO operador, no PRÓPRIO carregador, com corpo perfeito -> 403 FORBIDDEN; nada é criado nem enviado; a tentativa é auditada como DENIED', async () => {
    const c = await cenario('rs-op')
    const res = await request(app).post(c.url).set(auth(c.tenant.staff.token)).send(c.corpo())
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(sendCommandMock).not.toHaveBeenCalled()
    expect(await c.virtualTokens()).toBe(0)

    // o 403 sai ANTES da validação: não revela o formato do corpo a quem não pode usar a rota
    const semCorpo = await request(app).post(c.url).set(auth(c.tenant.staff.token)).send({})
    expect(semCorpo.status).toBe(403)

    const linha = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: c.tenant.staff.id, path: c.url, outcome: 'DENIED' } }))
    expect(linha.httpStatus).toBe(403)
  })

  it('motorista e sem token não chegam lá (403 / 401)', async () => {
    const c = await cenario('rs-papeis')
    expect((await request(app).post(c.url).set(auth(c.driver.token)).send(c.corpo())).status).toBe(403)
    expect((await request(app).post(c.url).send(c.corpo())).status).toBe(401)
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('GET /api/admin/commands/:id acompanha o ciclo: PENDING enquanto o carregador não responde -> ACCEPTED; e REJECTED / TIMEOUT quando for o caso', async () => {
    const c = await cenario('rs-ciclo')

    const cmd = comandoControlavel()
    const aceito = await request(app).post(c.url).set(auth(c.admin.token)).send(c.corpo())
    expect(aceito.status).toBe(202)
    const idAceito = aceito.body.correlationId as string
    const pendente = await waitFor(async () => {
      const r = await consultar(idAceito, c.admin.token)
      return r.status === 200 && r.body.status === 'PENDING' ? r : null
    })
    expect(pendente.body).toEqual({ status: 'PENDING' })
    cmd.aceitar()
    await waitFor(async () => (await consultar(idAceito, c.admin.token)).body.status === 'ACCEPTED')

    const cmd2 = comandoControlavel()
    const recusado = await request(app).post(c.url).set(auth(c.admin.token)).send(c.corpo())
    cmd2.recusar()
    await waitFor(async () => (await consultar(recusado.body.correlationId, c.admin.token)).body.status === 'REJECTED')

    const cmd3 = comandoControlavel()
    const lento = await request(app).post(c.url).set(auth(c.admin.token)).send(c.corpo())
    cmd3.estourarPrazo()
    await waitFor(async () => (await consultar(lento.body.correlationId, c.admin.token)).body.status === 'TIMEOUT')
  })

  it('GET: id desconhecido -> 404 COMMAND_NOT_FOUND; id mal formado -> 400; sem token 401; motorista e OPERATOR 403 (DL4)', async () => {
    const c = await cenario('rs-get')
    const desconhecido = await consultar(randomUUID(), c.admin.token)
    expect(desconhecido.status).toBe(404)
    expect(desconhecido.body.code).toBe('COMMAND_NOT_FOUND')
    expect((await consultar('nao-e-uuid', c.admin.token)).status).toBe(400)
    expect((await request(app).get(`/api/admin/commands/${randomUUID()}`)).status).toBe(401)
    expect((await consultar(randomUUID(), c.driver.token)).status).toBe(403)
    expect((await consultar(randomUUID(), c.tenant.staff.token)).status).toBe(403)
  })

  it('o registro expira (TTL de 2 min no Redis) — depois disso o GET admin responde 404', async () => {
    const c = await cenario('rs-ttl')
    comandoControlavel()
    const res = await request(app).post(c.url).set(auth(c.admin.token)).send(c.corpo())
    await waitFor(async () => (await consultar(res.body.correlationId, c.admin.token)).status === 200)
    const ttl = await redis.pttl(`ocpp:cmdresult:${res.body.correlationId}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(120_000)
    await redis.del(`ocpp:cmdresult:${res.body.correlationId}`) // simula a expiração
    expect((await consultar(res.body.correlationId, c.admin.token)).status).toBe(404)
  })

  it('compatibilidade: o MOTORISTA afetado continua lendo o resultado pelo /api/me/commands (PENDING -> ACCEPTED) e OUTRO motorista não vê nada', async () => {
    const c = await cenario('rs-motorista')
    const outro = await createUser({ role: 'DRIVER', label: 'rs-motorista-outro', suffix })
    const cmd = comandoControlavel()
    const res = await request(app).post(c.url).set(auth(c.admin.token)).send(c.corpo())
    const id = res.body.correlationId as string
    await waitFor(async () => (await consultar(id, c.admin.token)).status === 200) // registro PENDING gravado
    const doMotorista = () => request(app).get(`/api/me/commands/${id}`).set(auth(c.driver.token))
    expect((await doMotorista()).body).toEqual({ status: 'PENDING' })
    cmd.aceitar()
    await waitFor(async () => (await doMotorista()).body.status === 'ACCEPTED')
    expect((await request(app).get(`/api/me/commands/${id}`).set(auth(outro.token))).body).toEqual({ status: 'PENDING' })
    await settle(50)
  })
})
