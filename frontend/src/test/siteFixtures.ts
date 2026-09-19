import type { ConnectorStatus, ConnectorType, PublicChargePoint, PublicConnector, PublicConnectorGroup, PublicSite } from "@/types/api"

/** Fábrica de `PublicSite` pros testes — `isFree` segue a regra do servidor (online E AVAILABLE); `connectorSummary` é derivado. */
export interface FixtureConnector {
  type?: ConnectorType
  status?: ConnectorStatus
  maxPowerKw?: number
}

export function makeSite(
  overrides: { id?: string; name?: string; addressLine?: string; city?: string; state?: string; latitude?: number; longitude?: number } = {},
  chargePoints: Array<{ id?: string; online?: boolean; connectors: FixtureConnector[] }> = [{ connectors: [{}] }],
): PublicSite {
  let seq = 0
  const cps: PublicChargePoint[] = chargePoints.map((cp, i) => {
    const online = cp.online ?? true
    return {
      id: cp.id ?? `${overrides.id ?? "site"}_cp${i + 1}`,
      ocppIdentity: `CP-${overrides.id ?? "SITE"}-${i + 1}`.toUpperCase(),
      online,
      vendor: "ABB",
      model: "Terra",
      connectors: cp.connectors.map<PublicConnector>((c) => {
        const status = c.status ?? "AVAILABLE"
        seq += 1
        return {
          id: `c${seq}`,
          connectorId: seq,
          type: c.type ?? "DC_CCS2",
          status,
          maxPowerKw: String(c.maxPowerKw ?? 60),
          isFree: online && status === "AVAILABLE",
        }
      }),
    }
  })

  const groups = new Map<string, PublicConnectorGroup>()
  let total = 0
  let free = 0
  for (const cp of cps) {
    for (const c of cp.connectors) {
      total += 1
      if (c.isFree) free += 1
      const power = Number(c.maxPowerKw)
      const key = `${c.type}|${power}`
      const g = groups.get(key) ?? { type: c.type, maxPowerKw: power, total: 0, free: 0 }
      g.total += 1
      if (c.isFree) g.free += 1
      groups.set(key, g)
    }
  }

  return {
    id: overrides.id ?? "site",
    name: overrides.name ?? "Estação Teste",
    addressLine: overrides.addressLine ?? "Rua A, 1",
    city: overrides.city ?? "São Paulo",
    state: overrides.state ?? "SP",
    latitude: overrides.latitude ?? -23.55,
    longitude: overrides.longitude ?? -46.63,
    chargePoints: cps,
    connectorSummary: { total, free, groups: [...groups.values()] },
  }
}
