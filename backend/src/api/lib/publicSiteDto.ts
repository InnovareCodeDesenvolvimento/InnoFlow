import { isChargePointOnline, isConnectorFree, resumirConectores } from '../../core/estacoes/disponibilidade'

/**
 * Monta o DTO público de um site (`GET /api/sites`) a partir da linha do
 * Prisma. Função PURA (só tipos estruturais, nenhum import de Prisma/Express)
 * — existe separada da rota para o bug que motivou a extensão (mostrar
 * "Disponível" para carregador OFFLINE) ter um teste de unidade, não só uma
 * conferência manual.
 *
 * NUNCA devolve `lastSeenAt`/`disconnectedAt` (só o booleano derivado
 * `online`), `operatorId` nem qualquer dado interno — o `select` da rota já
 * não os traz, e o mapeamento abaixo é whitelist campo a campo.
 */

interface DecimalLike {
  toNumber(): number
  toString(): string
}

export interface SiteRow {
  id: string
  name: string
  addressLine: string
  city: string
  state: string
  latitude: DecimalLike
  longitude: DecimalLike
  chargePoints: {
    id: string
    ocppIdentity: string
    vendor: string | null
    model: string | null
    lastSeenAt: Date | null
    disconnectedAt: Date | null
    connectors: { id: string; connectorId: number; type: string; status: string; maxPowerKw: DecimalLike | null }[]
  }[]
}

export function paraSitePublico(site: SiteRow, now: Date) {
  const chargePoints = site.chargePoints.map((cp) => {
    const online = isChargePointOnline(cp, now)
    return {
      id: cp.id,
      ocppIdentity: cp.ocppIdentity,
      online,
      vendor: cp.vendor,
      model: cp.model,
      connectors: cp.connectors.map((c) => ({
        id: c.id,
        connectorId: c.connectorId,
        type: c.type,
        status: c.status,
        maxPowerKw: c.maxPowerKw?.toString() ?? null,
        isFree: isConnectorFree(online, c.status),
      })),
    }
  })

  const connectorSummary = resumirConectores(
    site.chargePoints.flatMap((cp, i) =>
      cp.connectors.map((c, j) => ({ type: c.type, maxPowerKw: c.maxPowerKw ? c.maxPowerKw.toNumber() : null, free: chargePoints[i].connectors[j].isFree })),
    ),
  )

  return {
    id: site.id,
    name: site.name,
    addressLine: site.addressLine,
    city: site.city,
    state: site.state,
    // Prisma Decimal serializa como string no JSON — o contrato é `number`.
    latitude: site.latitude.toNumber(),
    longitude: site.longitude.toNumber(),
    chargePoints,
    connectorSummary,
  }
}
