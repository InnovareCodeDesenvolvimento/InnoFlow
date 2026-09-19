import { describe, expect, it } from 'vitest'
import { paraSitePublico, type SiteRow } from '../../src/api/lib/publicSiteDto'
import { CHARGE_POINT_ONLINE_THRESHOLD_MS } from '../../src/core/estacoes/disponibilidade'

const NOW = new Date('2026-09-19T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

/** Decimal do Prisma serializa como string — simulamos só o que o mapper usa. */
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) })

const conector = (over: Partial<SiteRow['chargePoints'][number]['connectors'][number]> = {}) => ({
  id: 'c1',
  connectorId: 1,
  type: 'DC_CCS2',
  status: 'AVAILABLE',
  maxPowerKw: dec(60),
  ...over,
})

const site = (chargePoints: SiteRow['chargePoints']): SiteRow => ({
  id: 's1',
  name: 'Estação Matriz',
  addressLine: 'Av. Paulista, 1000',
  city: 'São Paulo',
  state: 'SP',
  latitude: dec(-23.561684),
  longitude: dec(-46.655981),
  chargePoints,
})

const cp = (over: Partial<SiteRow['chargePoints'][number]> = {}): SiteRow['chargePoints'][number] => ({
  id: 'cp1',
  ocppIdentity: 'CP-001',
  vendor: 'ABB',
  model: 'Terra',
  lastSeenAt: ago(5_000),
  disconnectedAt: null,
  connectors: [conector()],
  ...over,
})

describe('paraSitePublico', () => {
  it('REGRESSÃO do bug: carregador OFFLINE com conector AVAILABLE persistido NÃO é livre', () => {
    const dto = paraSitePublico(site([cp({ lastSeenAt: ago(CHARGE_POINT_ONLINE_THRESHOLD_MS + 60_000) })]), NOW)

    expect(dto.chargePoints[0].online).toBe(false)
    expect(dto.chargePoints[0].connectors[0].status).toBe('AVAILABLE') // status CRU preservado...
    expect(dto.chargePoints[0].connectors[0].isFree).toBe(false) // ...mas nunca "livre"
    expect(dto.connectorSummary).toMatchObject({ total: 1, free: 0 })
  })

  it('carregador que acabou de CAIR (close depois da última mensagem) já aparece offline, dentro do limiar', () => {
    const dto = paraSitePublico(site([cp({ lastSeenAt: ago(10_000), disconnectedAt: ago(2_000) })]), NOW)
    expect(dto.chargePoints[0].online).toBe(false)
    expect(dto.connectorSummary.free).toBe(0)
  })

  it('online + AVAILABLE -> livre; online + CHARGING -> não livre', () => {
    const dto = paraSitePublico(site([cp({ connectors: [conector({ id: 'a', connectorId: 1 }), conector({ id: 'b', connectorId: 2, status: 'CHARGING' })] })]), NOW)

    expect(dto.chargePoints[0].online).toBe(true)
    expect(dto.chargePoints[0].connectors.map((c) => c.isFree)).toEqual([true, false])
    expect(dto.connectorSummary).toMatchObject({ total: 2, free: 1 })
  })

  it('latitude/longitude saem como NUMBER (Decimal serializaria como string)', () => {
    const dto = paraSitePublico(site([cp()]), NOW)
    expect(dto.latitude).toBe(-23.561684)
    expect(dto.longitude).toBe(-46.655981)
    expect(typeof dto.latitude).toBe('number')
  })

  it('NUNCA vaza lastSeenAt/disconnectedAt/operatorId — nem no JSON serializado', () => {
    const json = JSON.stringify(paraSitePublico(site([cp()]), NOW))
    expect(json).not.toContain('lastSeenAt')
    expect(json).not.toContain('disconnectedAt')
    expect(json).not.toContain('operatorId')
  })

  it('expõe ocppIdentity (deep link /c/:ocppIdentity/:connectorId) e o formato do contrato PublicSite', () => {
    const dto = paraSitePublico(site([cp()]), NOW)
    expect(dto.chargePoints[0]).toEqual({
      id: 'cp1',
      ocppIdentity: 'CP-001',
      online: true,
      vendor: 'ABB',
      model: 'Terra',
      connectors: [{ id: 'c1', connectorId: 1, type: 'DC_CCS2', status: 'AVAILABLE', maxPowerKw: '60', isFree: true }],
    })
  })

  it('connectorSummary soma os conectores de TODOS os carregadores do site, agrupado por (tipo, potência), com a mesma regra de isFree', () => {
    const dto = paraSitePublico(
      site([
        cp({ id: 'cp1', ocppIdentity: 'CP-001', connectors: [conector({ id: 'a' }), conector({ id: 'b', connectorId: 2, status: 'CHARGING' })] }),
        cp({ id: 'cp2', ocppIdentity: 'CP-002', lastSeenAt: null, connectors: [conector({ id: 'c' })] }), // offline: 1 conector AVAILABLE que NÃO conta como livre
        cp({ id: 'cp3', ocppIdentity: 'CP-003', connectors: [conector({ id: 'd', type: 'AC_TYPE2', maxPowerKw: dec(22) })] }),
      ]),
      NOW,
    )

    expect(dto.connectorSummary).toEqual({
      total: 4,
      free: 2, // a (online, AVAILABLE) e d (online, AVAILABLE); b ocupado, c em carregador offline
      groups: [
        { type: 'AC_TYPE2', maxPowerKw: 22, total: 1, free: 1 },
        { type: 'DC_CCS2', maxPowerKw: 60, total: 3, free: 1 },
      ],
    })
  })

  it('site sem carregador ativo -> lista vazia e resumo zerado (não quebra)', () => {
    const dto = paraSitePublico(site([]), NOW)
    expect(dto.chargePoints).toEqual([])
    expect(dto.connectorSummary).toEqual({ total: 0, free: 0, groups: [] })
  })

  it('conector sem potência cadastrada -> maxPowerKw null (grupo próprio, sem NaN)', () => {
    const dto = paraSitePublico(site([cp({ connectors: [conector({ maxPowerKw: null })] })]), NOW)
    expect(dto.chargePoints[0].connectors[0].maxPowerKw).toBeNull()
    expect(dto.connectorSummary.groups).toEqual([{ type: 'DC_CCS2', maxPowerKw: null, total: 1, free: 1 }])
  })
})
