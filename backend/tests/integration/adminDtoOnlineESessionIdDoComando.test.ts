import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { IHandlersOption } from 'ocpp-rpc'

// Só o ENVIO do comando OCPP é trocado (o gateway real não existe aqui). Rotas, escopo, Redis, Postgres e o handler REAL de StartTransaction são os de verdade.
const sendCommandMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/ocpp/commands', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/ocpp/commands')>()), sendCommand: sendCommandMock }))
// Política aberta a OPERATOR de propósito (o dia em que o dono liberar — DL4): o escopo por operador do `sessionId` tem que já estar valendo.
vi.mock('../../src/core/sessao/politicaRecargaRemota', () => ({
  PAPEIS_QUE_PODEM_INICIAR_RECARGA_REMOTA: ['ADMIN', 'OPERATOR'],
  podeIniciarRecargaRemota: (papel: string | null | undefined) => papel === 'ADMIN' || papel === 'OPERATOR',
}))

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import type { OcppHandlerCtx } from '../../src/ocpp/context'
import { CHARGE_POINT_ONLINE_THRESHOLD_MS } from '../../src/core/estacoes/disponibilidade'
import { createTenant, createUser, uniqueSuffix, waitFor, type TestTenant } from './helpers/fixtures'

/**
 * Vega-J (pedido das Lyras):
 *  1) DTO admin de carregadores ganha `online: boolean` (regra única `isChargePointOnline`), aditivo — `lastSeenAt` segue no JSON;
 *  2) `GET /api/admin/commands/:id` devolve `sessionId` quando um remote-start foi ACCEPTED (null se a sessão ainda não nasceu), sem vazar sessão de outro motorista/operador.
 */
describe('Vega-J — online no DTO de carregadores e sessionId na consulta do comando', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const REASON = 'Cliente sem bateria, recarga assistida'

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  beforeEach(() => {
    sendCommandMock.mockReset()
    sendCommandMock.mockImplementation(async () => ({ status: 'Accepted' }))
  })

  async function operador(label: string) {
    const tenant = await createTenant({ suffix, label })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    return tenant
  }

  async function motoristaComSaldo(label: string) {
    const driver = await createUser({ role: 'DRIVER', label, suffix })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'TOPUP_PIX', amountCents: 5000, balanceAfterCents: 5000 } })
    return driver
  }

  const ctxDe = (t: TestTenant): OcppHandlerCtx => ({ chargePointId: t.chargePointId, operatorId: t.operatorId, ocppIdentity: t.ocppIdentity })
  const startUrl = (t: TestTenant) => `/api/admin/charge-points/${t.chargePointId}/commands/remote-start`
  const consultar = (correlationId: string, token: string) => request(app).get(`/api/admin/commands/${correlationId}`).set(auth(token))

  /** O carregador (simulado) responde ao RemoteStart com StartTransaction usando o idTag que o servidor mandou — o handler REAL cria a sessão. */
  async function startTransactionDoCarregador(t: TestTenant, idTag: string) {
    const params = { connectorId: 1, idTag, meterStart: 100, timestamp: new Date().toISOString() }
    const res = await handleStartTransaction({ messageId: randomUUID(), params, method: 'StartTransaction', signal: new AbortController().signal } as unknown as IHandlersOption, ctxDe(t))
    expect(res.idTagInfo.status).toBe('Accepted')
    return res.transactionId
  }

  describe('1) online no DTO admin de carregadores', () => {
    it('lista e detalhe trazem `online` (regra única do servidor) junto de `lastSeenAt`; POST/PATCH também; e nunca o hash do segredo', async () => {
      const t = await createTenant({ suffix, label: 'dto-online' })
      const admin = await createUser({ role: 'ADMIN', label: 'dto-admin', suffix })
      const agora = new Date()
      await prisma.chargePoint.update({ where: { id: t.chargePointId }, data: { lastSeenAt: agora } })

      const detalhe = await request(app).get(`/api/admin/charge-points/${t.chargePointId}`).set(auth(admin.token))
      expect(detalhe.status).toBe(200)
      expect(detalhe.body.online).toBe(true)
      expect(detalhe.body.lastSeenAt).toBe(agora.toISOString())
      expect(detalhe.body).not.toHaveProperty('basicAuthSecretHash')

      const lista = await request(app).get('/api/admin/charge-points?pageSize=100').set(auth(t.staff.token))
      const item = (lista.body.items as Array<{ id: string; online: unknown; lastSeenAt: string | null }>).find((i) => i.id === t.chargePointId)
      expect(item).toMatchObject({ online: true, lastSeenAt: agora.toISOString() })
      expect(lista.body.items.every((i: { online: unknown }) => typeof i.online === 'boolean')).toBe(true)

      const edit = await request(app).patch(`/api/admin/charge-points/${t.chargePointId}`).set(auth(admin.token)).send({ vendor: 'ACME' })
      expect(edit.status).toBe(200)
      expect(edit.body.online).toBe(true)
    })

    it('offline por limiar (lastSeenAt velho), por nunca ter reportado (null) e por queda (disconnectedAt >= lastSeenAt); volta a online com mensagem posterior', async () => {
      const t = await createTenant({ suffix, label: 'dto-offline' })
      const admin = await createUser({ role: 'ADMIN', label: 'dto-admin2', suffix })
      const online = async () => (await request(app).get(`/api/admin/charge-points/${t.chargePointId}`).set(auth(admin.token))).body.online

      expect(await online()).toBe(false) // nunca reportou (lastSeenAt null)
      expect((await request(app).get(`/api/admin/charge-points/${t.chargePointId}`).set(auth(admin.token))).body.lastSeenAt).toBeNull()

      await prisma.chargePoint.update({ where: { id: t.chargePointId }, data: { lastSeenAt: new Date(Date.now() - CHARGE_POINT_ONLINE_THRESHOLD_MS - 5_000) } })
      expect(await online()).toBe(false) // passou do limiar

      const visto = new Date(Date.now() - 10_000)
      await prisma.chargePoint.update({ where: { id: t.chargePointId }, data: { lastSeenAt: visto } })
      expect(await online()).toBe(true)

      await prisma.chargePoint.update({ where: { id: t.chargePointId }, data: { disconnectedAt: new Date(visto.getTime() + 1_000) } }) // fechou DEPOIS da última mensagem
      expect(await online()).toBe(false)

      await prisma.chargePoint.update({ where: { id: t.chargePointId }, data: { lastSeenAt: new Date() } }) // mensagem posterior "cura"
      expect(await online()).toBe(true)
    })

    it('escopo de operador intacto: OPERATOR só enxerga os seus (e `online` não abre outro operador)', async () => {
      const a = await operador('dto-esc-a')
      const b = await operador('dto-esc-b')
      const lista = await request(app).get('/api/admin/charge-points?pageSize=100').set(auth(a.staff.token))
      const ids = (lista.body.items as Array<{ id: string }>).map((i) => i.id)
      expect(ids).toContain(a.chargePointId)
      expect(ids).not.toContain(b.chargePointId)
      expect((await request(app).get(`/api/admin/charge-points/${b.chargePointId}`).set(auth(a.staff.token))).status).toBe(404)
    })
  })

  describe('2) sessionId na consulta do comando remote-start', () => {
    async function dispararRemoteStart(t: TestTenant, adminToken: string, driverId: string) {
      const res = await request(app).post(startUrl(t)).set(auth(adminToken)).send({ connectorId: 1, userId: driverId, reason: REASON })
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      return { correlationId: res.body.correlationId as string, idTag: res.body.idTag as string }
    }

    it('ACCEPTED sem StartTransaction ainda: sessionId null; depois que o carregador abre a transação: o id da sessão certa (e o idTag nunca vaza na resposta)', async () => {
      const t = await operador('sid-ok')
      const admin = await createUser({ role: 'ADMIN', label: 'sid-admin', suffix })
      const driver = await motoristaComSaldo('sid-driver')
      const { correlationId, idTag } = await dispararRemoteStart(t, admin.token, driver.id)

      const aceito = await waitFor(async () => {
        const r = await consultar(correlationId, admin.token)
        return r.status === 200 && r.body.status === 'ACCEPTED' ? r : null
      })
      expect(aceito.body).toEqual({ status: 'ACCEPTED', sessionId: null }) // aceito, mas a sessão nasce no StartTransaction, que ainda não chegou

      const transactionId = await startTransactionDoCarregador(t, idTag)
      const sessao = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: transactionId } })
      const depois = await consultar(correlationId, admin.token)
      expect(depois.body).toEqual({ status: 'ACCEPTED', sessionId: sessao.id })
      expect(JSON.stringify(depois.body)).not.toContain(idTag)
    })

    it('PENDING / REJECTED / TIMEOUT NÃO trazem sessionId (aditivo só no ACCEPTED de remote-start)', async () => {
      const t = await operador('sid-semid')
      const admin = await createUser({ role: 'ADMIN', label: 'sid-admin2', suffix })
      const driver = await motoristaComSaldo('sid-driver2')

      sendCommandMock.mockImplementation(() => new Promise(() => {}))
      const pendente = await dispararRemoteStart(t, admin.token, driver.id)
      const r1 = await waitFor(async () => {
        const r = await consultar(pendente.correlationId, admin.token)
        return r.status === 200 ? r : null
      })
      expect(r1.body).toEqual({ status: 'PENDING' })

      sendCommandMock.mockImplementation(async () => ({ status: 'Rejected' }))
      const recusado = await dispararRemoteStart(t, admin.token, driver.id)
      await waitFor(async () => (await consultar(recusado.correlationId, admin.token)).body.status === 'REJECTED')
      expect((await consultar(recusado.correlationId, admin.token)).body).toEqual({ status: 'REJECTED' })
    })

    it('com DOIS motoristas no MESMO carregador, cada comando enxerga só a SUA sessão (nada de "a mais recente do carregador")', async () => {
      const t = await operador('sid-dois')
      const admin = await createUser({ role: 'ADMIN', label: 'sid-admin3', suffix })
      const d1 = await motoristaComSaldo('sid-d1')
      const d2 = await motoristaComSaldo('sid-d2')
      const c1 = await dispararRemoteStart(t, admin.token, d1.id)
      const c2 = await dispararRemoteStart(t, admin.token, d2.id)
      await waitFor(async () => (await consultar(c1.correlationId, admin.token)).body.status === 'ACCEPTED')
      await waitFor(async () => (await consultar(c2.correlationId, admin.token)).body.status === 'ACCEPTED')

      // O carregador só abre a transação do SEGUNDO comando (no conector 1). O primeiro continua sem sessão.
      const tx2 = await startTransactionDoCarregador(t, c2.idTag)
      const s2 = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: tx2 } })
      expect(s2.userId).toBe(d2.id)
      expect((await consultar(c1.correlationId, admin.token)).body).toEqual({ status: 'ACCEPTED', sessionId: null })
      expect((await consultar(c2.correlationId, admin.token)).body).toEqual({ status: 'ACCEPTED', sessionId: s2.id })
    })

    it('escopo por operador (política aberta): o staff de A vê o sessionId do comando de A; o de B recebe o 404 de sempre e NUNCA o id; ADMIN vê', async () => {
      const a = await operador('sid-esc-a')
      const b = await operador('sid-esc-b')
      const admin = await createUser({ role: 'ADMIN', label: 'sid-admin4', suffix })
      const driver = await motoristaComSaldo('sid-esc-driver')
      const { correlationId, idTag } = await dispararRemoteStart(a, a.staff.token, driver.id)
      await waitFor(async () => (await consultar(correlationId, a.staff.token)).body.status === 'ACCEPTED')
      const tx = await startTransactionDoCarregador(a, idTag)
      const sessao = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: tx } })

      expect((await consultar(correlationId, a.staff.token)).body).toEqual({ status: 'ACCEPTED', sessionId: sessao.id })
      expect((await consultar(correlationId, admin.token)).body).toEqual({ status: 'ACCEPTED', sessionId: sessao.id })
      const deB = await consultar(correlationId, b.staff.token)
      expect(deB.status).toBe(404)
      expect(JSON.stringify(deB.body)).not.toContain(sessao.id)
    })

    it('comandos que NÃO são remote-start (registro sem idTag, ex.: remote-stop do app) e registro do formato antigo nunca ganham sessionId', async () => {
      const admin = await createUser({ role: 'ADMIN', label: 'sid-admin5', suffix })
      const id = randomUUID()
      await redis.set(`ocpp:cmdresult:${id}`, 'user-qualquer|ACCEPTED|cp-qualquer|op-qualquer', 'PX', 60_000)
      const antigo = randomUUID()
      await redis.set(`ocpp:cmdresult:${antigo}`, 'user-qualquer|ACCEPTED', 'PX', 60_000)
      expect((await consultar(id, admin.token)).body).toEqual({ status: 'ACCEPTED' })
      expect((await consultar(antigo, admin.token)).body).toEqual({ status: 'ACCEPTED' })
      await redis.del(`ocpp:cmdresult:${id}`, `ocpp:cmdresult:${antigo}`)
    })

    it('registro adulterado/forjado: idTag de OUTRO motorista ou de outro charge point no registro não acha sessão alheia (motorista e charge point também são exigidos)', async () => {
      const a = await operador('sid-forja-a')
      const b = await operador('sid-forja-b')
      const admin = await createUser({ role: 'ADMIN', label: 'sid-admin6', suffix })
      const dono = await motoristaComSaldo('sid-forja-dono')
      const outro = await motoristaComSaldo('sid-forja-outro')
      const { correlationId, idTag } = await dispararRemoteStart(a, admin.token, dono.id)
      await waitFor(async () => (await consultar(correlationId, admin.token)).body.status === 'ACCEPTED')
      await startTransactionDoCarregador(a, idTag)

      const forjaMotorista = randomUUID()
      await redis.set(`ocpp:cmdresult:${forjaMotorista}`, `${outro.id}|ACCEPTED|${a.chargePointId}|${a.operatorId}|${idTag}`, 'PX', 60_000)
      const forjaCarregador = randomUUID()
      await redis.set(`ocpp:cmdresult:${forjaCarregador}`, `${dono.id}|ACCEPTED|${b.chargePointId}|${b.operatorId}|${idTag}`, 'PX', 60_000)
      expect((await consultar(forjaMotorista, admin.token)).body).toEqual({ status: 'ACCEPTED', sessionId: null })
      expect((await consultar(forjaCarregador, admin.token)).body).toEqual({ status: 'ACCEPTED', sessionId: null })
      await redis.del(`ocpp:cmdresult:${forjaMotorista}`, `ocpp:cmdresult:${forjaCarregador}`)
    })
  })
})
