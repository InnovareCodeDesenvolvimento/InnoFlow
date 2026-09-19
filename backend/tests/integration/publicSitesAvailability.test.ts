import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { ConnectorStatus } from '@prisma/client'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * `GET /api/sites` (público, "eletropostos perto de mim") contra Postgres
 * real. O bug de produção que motivou a extensão: a rota mostrava
 * "Disponível" para carregador OFFLINE — este arquivo prende a regra ÚNICA
 * (online = visto há < 5 min E não caiu depois da última mensagem; livre =
 * online E AVAILABLE) na rota de verdade, com dado de verdade.
 *
 * Isolamento: a rota é pública e NÃO escopada por operador (lista tudo que
 * está ativo). Por isso cada teste consulta uma BOUNDING BOX própria, num
 * canto aleatório do mapa, onde só existem os sites criados aqui.
 */
describe('GET /api/sites — disponibilidade real (Postgres)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()

  // Região aleatória (~2 km²) longe do resto dos fixtures — 4 casas decimais para caber em DECIMAL(9,6).
  const baseLat = -Number((5 + Math.random() * 20).toFixed(4))
  const baseLng = -Number((40 + Math.random() * 20).toFixed(4))
  const bbox = { minLat: baseLat - 0.05, maxLat: baseLat + 0.05, minLng: baseLng - 0.05, maxLng: baseLng + 0.05 }
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)
  const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)

  let operatorId: string
  const siteIds: string[] = []
  const chargePointIds: string[] = []
  const connectorIds: string[] = []

  async function makeSite(name: string, opts: { active?: boolean } = {}) {
    const site = await prisma.site.create({
      data: {
        operatorId,
        name: `${name} ${suffix}`,
        addressLine: 'Rua Pública',
        city: 'Cidade',
        state: 'SP',
        postalCode: '00000-000',
        latitude: baseLat + Math.random() * 0.01,
        longitude: baseLng + Math.random() * 0.01,
        active: opts.active ?? true,
      },
    })
    siteIds.push(site.id)
    return site
  }

  async function makeCharger(
    siteId: string,
    label: string,
    presence: { lastSeenAt: Date | null; disconnectedAt?: Date | null; active?: boolean },
    connectors: { connectorId: number; status: ConnectorStatus }[],
  ) {
    const cp = await prisma.chargePoint.create({
      data: { operatorId, siteId, ocppIdentity: `pub-${label}-${suffix}`, basicAuthSecretHash: 'x', lastSeenAt: presence.lastSeenAt, disconnectedAt: presence.disconnectedAt ?? null, active: presence.active ?? true },
    })
    chargePointIds.push(cp.id)
    for (const c of connectors) {
      const connector = await prisma.connector.create({ data: { operatorId, chargePointId: cp.id, connectorId: c.connectorId, type: 'DC_CCS2', status: c.status, maxPowerKw: '50' } })
      connectorIds.push(connector.id)
    }
    return cp
  }

  const listInBbox = (extra: Record<string, unknown> = {}) => request(app).get('/api/sites').query({ ...bbox, pageSize: 100, ...extra })
  type PublicSite = { id: string; name: string; chargePoints: { ocppIdentity: string; online: boolean; connectors: { connectorId: number; isFree: boolean; status: string }[] }[]; connectorSummary: { total: number; free: number } }

  beforeAll(async () => {
    operatorId = (await prisma.operator.create({ data: { name: `Operador Pub ${suffix}`, email: `pub-${suffix}@example.com` } })).id
  })

  afterAll(async () => {
    await prisma.connector.deleteMany({ where: { id: { in: connectorIds } } }).catch(() => undefined)
    await prisma.chargePoint.deleteMany({ where: { id: { in: chargePointIds } } }).catch(() => undefined)
    await prisma.site.deleteMany({ where: { id: { in: siteIds } } }).catch(() => undefined)
    await prisma.operator.deleteMany({ where: { id: operatorId } }).catch(() => undefined)
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('online / isFree', () => {
    let body: { items: PublicSite[]; meta: { total: number } }
    const byIdentity = (label: string) => {
      const found = body.items.flatMap((s) => s.chargePoints).find((cp) => cp.ocppIdentity === `pub-${label}-${suffix}`)
      if (!found) throw new Error(`charge point ${label} não veio na resposta`)
      return found
    }

    beforeAll(async () => {
      const site = await makeSite('Disponibilidade')
      await makeCharger(site.id, 'online', { lastSeenAt: secondsAgo(30) }, [
        { connectorId: 1, status: 'AVAILABLE' },
        { connectorId: 2, status: 'CHARGING' },
        { connectorId: 3, status: 'FAULTED' },
      ])
      // O BUG DE PRODUÇÃO: carregador sumiu há 6 min (passou do limiar de 5) mas o ÚLTIMO status persistido do conector segue AVAILABLE.
      await makeCharger(site.id, 'offline-tempo', { lastSeenAt: minutesAgo(6) }, [{ connectorId: 1, status: 'AVAILABLE' }])
      // Caiu AGORA (WebSocket fechou depois da última mensagem) — offline mesmo dentro do limiar de 5 min.
      await makeCharger(site.id, 'caiu-agora', { lastSeenAt: secondsAgo(60), disconnectedAt: secondsAgo(10) }, [{ connectorId: 1, status: 'AVAILABLE' }])
      // Fronteira: fechou no MESMO instante da última mensagem (>=) — também offline.
      const same = secondsAgo(45)
      await makeCharger(site.id, 'mesmo-instante', { lastSeenAt: same, disconnectedAt: same }, [{ connectorId: 1, status: 'AVAILABLE' }])
      // Já caiu e VOLTOU: `disconnectedAt` é mais antigo que `lastSeenAt` — online de novo sem ninguém limpar a coluna.
      await makeCharger(site.id, 'reconectou', { lastSeenAt: secondsAgo(20), disconnectedAt: minutesAgo(3) }, [{ connectorId: 1, status: 'AVAILABLE' }])
      // Nunca falou com o servidor.
      await makeCharger(site.id, 'nunca-visto', { lastSeenAt: null }, [{ connectorId: 1, status: 'AVAILABLE' }])
      // Desativado: nem aparece.
      await makeCharger(site.id, 'inativo', { lastSeenAt: secondsAgo(5), active: false }, [{ connectorId: 1, status: 'AVAILABLE' }])

      const res = await listInBbox()
      expect(res.status).toBe(200)
      body = res.body
    })

    it('carregador online: só o conector AVAILABLE é livre (CHARGING e FAULTED não)', () => {
      const cp = byIdentity('online')
      expect(cp.online).toBe(true)
      expect(Object.fromEntries(cp.connectors.map((c) => [c.connectorId, c.isFree]))).toEqual({ 1: true, 2: false, 3: false })
      expect(cp.connectors.map((c) => c.status)).toEqual(['AVAILABLE', 'CHARGING', 'FAULTED'])
    })

    it('OFFLINE por tempo com conector AVAILABLE -> online:false e isFree:false (o bug corrigido em produção)', () => {
      const cp = byIdentity('offline-tempo')
      expect(cp.online).toBe(false)
      expect(cp.connectors[0]).toMatchObject({ status: 'AVAILABLE', isFree: false })
    })

    it('disconnectedAt >= lastSeenAt -> offline MESMO dentro do limiar de 5 min', () => {
      expect(byIdentity('caiu-agora')).toMatchObject({ online: false })
      expect(byIdentity('caiu-agora').connectors[0].isFree).toBe(false)
    })

    it('disconnectedAt exatamente igual a lastSeenAt -> offline (a comparação é >=)', () => {
      expect(byIdentity('mesmo-instante').online).toBe(false)
    })

    it('desconexão ANTIGA (anterior à última mensagem) não derruba: carregador reconectado volta a online e a livre', () => {
      const cp = byIdentity('reconectou')
      expect(cp.online).toBe(true)
      expect(cp.connectors[0].isFree).toBe(true)
    })

    it('nunca visto (lastSeenAt nulo) -> offline', () => {
      const cp = byIdentity('nunca-visto')
      expect(cp.online).toBe(false)
      expect(cp.connectors[0].isFree).toBe(false)
    })

    it('carregador inativo não aparece', () => {
      expect(body.items.flatMap((s) => s.chargePoints).some((cp) => cp.ocppIdentity === `pub-inativo-${suffix}`)).toBe(false)
    })

    it('connectorSummary conta livres pela MESMA regra (só os online+AVAILABLE: online#1 e reconectou#1)', () => {
      const site = body.items.find((s) => s.name === `Disponibilidade ${suffix}`)!
      // conectores: online(3) + offline-tempo(1) + caiu-agora(1) + mesmo-instante(1) + reconectou(1) + nunca-visto(1) = 8; livres = 2
      expect(site.connectorSummary).toMatchObject({ total: 8, free: 2 })
    })

    it('NUNCA vaza lastSeenAt/disconnectedAt/operatorId em lugar nenhum da resposta', () => {
      const serialized = JSON.stringify(body)
      expect(serialized).not.toMatch(/lastSeenAt|disconnectedAt|lastBootAt|operatorId|basicAuth/i)
      expect(serialized).not.toContain(operatorId)
    })

    it('resposta pública sempre revalida (Cache-Control: no-cache)', async () => {
      const res = await listInBbox()
      expect(res.headers['cache-control']).toBe('no-cache')
    })
  })

  describe('filtros e paginação', () => {
    it('site inativo não aparece', async () => {
      const inactive = await makeSite('Inativo', { active: false })
      const res = await listInBbox()
      expect((res.body.items as PublicSite[]).some((s) => s.id === inactive.id)).toBe(false)
    })

    it('bounding box INCOMPLETA -> 400 (os 4 limites vêm juntos ou nenhum)', async () => {
      for (const partial of [{ minLat: baseLat }, { minLat: baseLat, maxLat: baseLat + 1 }, { minLat: baseLat, maxLat: baseLat + 1, minLng: baseLng }]) {
        const res = await request(app).get('/api/sites').query(partial)
        expect(res.status, JSON.stringify(partial)).toBe(400)
        expect(res.body.code).toBe('VALIDATION_ERROR')
      }
    })

    it('coordenada fora do mundo (lat 91) e pageSize acima de 100 -> 400', async () => {
      expect((await request(app).get('/api/sites').query({ ...bbox, maxLat: 91 })).status).toBe(400)
      expect((await request(app).get('/api/sites').query({ pageSize: 101 })).status).toBe(400)
      expect((await request(app).get('/api/sites').query({ page: 0 })).status).toBe(400)
    })

    it('bbox só devolve o que está dentro dela', async () => {
      const far = await prisma.site.create({
        data: { operatorId, name: `Longe ${suffix}`, addressLine: 'x', city: 'x', state: 'SP', postalCode: '00000-000', latitude: baseLat + 3, longitude: baseLng + 3 },
      })
      siteIds.push(far.id)
      const res = await listInBbox()
      expect((res.body.items as PublicSite[]).some((s) => s.id === far.id)).toBe(false)
    })

    it('ordem ESTÁVEL na paginação: (name, id) — sem repetir nem perder site entre páginas, inclusive com nomes IGUAIS', async () => {
      // Nomes criados fora de ordem, com dois nomes idênticos (o desempate por id é o que evita repetição/perda).
      const created = []
      for (const name of ['Pag-03', 'Pag-01', 'Pag-02', 'Pag-02', 'Pag-02']) {
        const s = await prisma.site.create({
          data: { operatorId, name: `${name}-${suffix}`, addressLine: 'x', city: 'x', state: 'SP', postalCode: '00000-000', latitude: baseLat - 0.03 + Math.random() * 0.001, longitude: baseLng - 0.03 + Math.random() * 0.001 },
        })
        siteIds.push(s.id)
        created.push(s)
      }
      const inPagBox = { minLat: baseLat - 0.04, maxLat: baseLat - 0.02, minLng: baseLng - 0.04, maxLng: baseLng - 0.02 }

      const expected = [...created].sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1)).map((s) => s.id)

      const seen: string[] = []
      let totalPages = 0
      for (let page = 1; page <= 3; page++) {
        const res = await request(app).get('/api/sites').query({ ...inPagBox, page, pageSize: 2 })
        expect(res.status).toBe(200)
        expect(res.body.meta).toMatchObject({ page, pageSize: 2, total: 5, totalPages: 3 })
        totalPages = res.body.meta.totalPages
        seen.push(...(res.body.items as PublicSite[]).map((s) => s.id))
      }
      expect(totalPages).toBe(3)
      expect(seen).toEqual(expected) // mesma ordem, cada um exatamente uma vez
      expect(new Set(seen).size).toBe(5)

      // Página além do fim: vazia, sem erro.
      const beyond = await request(app).get('/api/sites').query({ ...inPagBox, page: 4, pageSize: 2 })
      expect(beyond.status).toBe(200)
      expect(beyond.body.items).toEqual([])
    })

    it('duas chamadas seguidas devolvem a mesma ordem (determinismo)', async () => {
      const a = await listInBbox()
      const b = await listInBbox()
      expect((a.body.items as PublicSite[]).map((s) => s.id)).toEqual((b.body.items as PublicSite[]).map((s) => s.id))
    })
  })
})
