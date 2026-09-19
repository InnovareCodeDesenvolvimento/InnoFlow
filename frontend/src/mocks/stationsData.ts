/**
 * Estações públicas do mapa ("eletropostos perto de mim") — espelha o
 * contrato estendido de `GET /api/sites` (`PublicSite`: `connectorSummary`,
 * `PublicChargePoint.ocppIdentity/online`, `PublicConnector.isFree`), ver
 * `decisoes-mapa-eletropostos.md`. Junta os 5 sites "de sempre" (`data.ts`,
 * intocados — o Admin/relatórios dependem deles) com ~11 sites extras em
 * volta de São Paulo, com mistura de livre / ocupado / offline.
 *
 * `isFree` segue a regra ÚNICA do servidor: carregador online E status
 * AVAILABLE — nunca só o status. Morumbi tem conectores AVAILABLE num
 * carregador OFFLINE de propósito: é o caso que a listagem antiga mentia.
 */
import { mockChargePoints, mockConnectors, mockSites } from "./data"
import type { ConnectorStatus, ConnectorType, PublicChargePoint, PublicConnector, PublicConnectorGroup, PublicSite } from "@/types/api"

interface ExtraConnector {
  id: string
  connectorId: number
  type: ConnectorType
  status: ConnectorStatus
  maxPowerKw: number
}

interface ExtraChargePoint {
  id: string
  ocppIdentity: string
  vendor: string
  model: string
  online: boolean
  connectors: ExtraConnector[]
}

export interface ExtraStation {
  id: string
  name: string
  addressLine: string
  city: string
  state: string
  latitude: number
  longitude: number
  chargePoints: ExtraChargePoint[]
}

let connectorSeq = 0
const conn = (type: ConnectorType, status: ConnectorStatus, maxPowerKw: number, connectorId: number): ExtraConnector => ({
  id: `stconn_${++connectorSeq}`,
  connectorId,
  type,
  status,
  maxPowerKw,
})

/** Estado MUTÁVEL (só os extras): o stream de tempo real do mock vira conectores de livre↔ocupado pra a lista mudar sozinha. */
export const extraStations: ExtraStation[] = [
  {
    id: "st_paulista",
    name: "Shopping Paulista",
    addressLine: "Av. Paulista, 1578",
    city: "São Paulo",
    state: "SP",
    latitude: -23.5614,
    longitude: -46.6559,
    chargePoints: [
      { id: "stcp_paulista_1", ocppIdentity: "CP-PAULISTA-01", vendor: "ABB", model: "Terra 54", online: true, connectors: [conn("DC_CCS2", "AVAILABLE", 60, 1), conn("AC_TYPE2", "CHARGING", 22, 2)] },
      { id: "stcp_paulista_2", ocppIdentity: "CP-PAULISTA-02", vendor: "ABB", model: "Terra 184", online: true, connectors: [conn("DC_CCS2", "CHARGING", 120, 1), conn("DC_CCS2", "AVAILABLE", 120, 2)] },
    ],
  },
  {
    id: "st_pinheiros",
    name: "Estacionamento Pinheiros",
    addressLine: "Rua dos Pinheiros, 870",
    city: "São Paulo",
    state: "SP",
    latitude: -23.567,
    longitude: -46.702,
    chargePoints: [
      { id: "stcp_pinheiros_1", ocppIdentity: "CP-PINHEIROS-01", vendor: "WEG", model: "EVR-22", online: true, connectors: [conn("AC_TYPE2", "AVAILABLE", 22, 1), conn("AC_TYPE2", "AVAILABLE", 22, 2)] },
    ],
  },
  {
    id: "st_ibirapuera",
    name: "Parque Ibirapuera — Portão 3",
    addressLine: "Av. Pedro Álvares Cabral, s/n",
    city: "São Paulo",
    state: "SP",
    latitude: -23.5874,
    longitude: -46.6576,
    chargePoints: [
      { id: "stcp_ibira_1", ocppIdentity: "CP-IBIRAPUERA-01", vendor: "Siemens", model: "SICHARGE UC100", online: true, connectors: [conn("DC_CHADEMO", "CHARGING", 50, 1), conn("DC_CCS2", "AVAILABLE", 50, 2)] },
    ],
  },
  {
    id: "st_morumbi",
    name: "Morumbi Shopping",
    addressLine: "Av. Roque Petroni Jr., 1089",
    city: "São Paulo",
    state: "SP",
    latitude: -23.6225,
    longitude: -46.6997,
    chargePoints: [
      // OFFLINE de propósito: conectores "AVAILABLE" num carregador desconectado NÃO são livres (`isFree` false).
      { id: "stcp_morumbi_1", ocppIdentity: "CP-MORUMBI-01", vendor: "WEG", model: "EVR-60", online: false, connectors: [conn("DC_CCS2", "AVAILABLE", 60, 1), conn("AC_TYPE2", "AVAILABLE", 22, 2)] },
    ],
  },
  {
    id: "st_tatuape",
    name: "Tatuapé Plaza",
    addressLine: "Rua Tuiuti, 2100",
    city: "São Paulo",
    state: "SP",
    latitude: -23.5405,
    longitude: -46.576,
    chargePoints: [
      { id: "stcp_tatuape_1", ocppIdentity: "CP-TATUAPE-01", vendor: "ABB", model: "Terra 54", online: true, connectors: [conn("DC_CCS2", "CHARGING", 60, 1), conn("DC_CCS2", "CHARGING", 60, 2), conn("AC_TYPE2", "PREPARING", 22, 3)] },
    ],
  },
  {
    id: "st_osasco",
    name: "Osasco Plaza",
    addressLine: "Av. dos Autonomistas, 1400",
    city: "Osasco",
    state: "SP",
    latitude: -23.5325,
    longitude: -46.7917,
    chargePoints: [{ id: "stcp_osasco_1", ocppIdentity: "CP-OSASCO-01", vendor: "WEG", model: "EVR-22", online: true, connectors: [conn("AC_TYPE2", "AVAILABLE", 22, 1)] }],
  },
  {
    id: "st_santoandre",
    name: "Santo André — Centro",
    addressLine: "Av. Industrial, 600",
    city: "Santo André",
    state: "SP",
    latitude: -23.6639,
    longitude: -46.5383,
    chargePoints: [
      { id: "stcp_sa_1", ocppIdentity: "CP-SANTOANDRE-01", vendor: "ABB", model: "Terra 54", online: true, connectors: [conn("DC_CCS2", "AVAILABLE", 60, 1), conn("DC_CCS2", "AVAILABLE", 60, 2)] },
      { id: "stcp_sa_2", ocppIdentity: "CP-SANTOANDRE-02", vendor: "WEG", model: "EVR-22", online: true, connectors: [conn("AC_TYPE2", "CHARGING", 22, 1), conn("AC_TYPE2", "AVAILABLE", 22, 2)] },
    ],
  },
  {
    id: "st_guarulhos",
    name: "Guarulhos — Aeroporto",
    addressLine: "Rod. Hélio Smidt, s/n",
    city: "Guarulhos",
    state: "SP",
    latitude: -23.4356,
    longitude: -46.4731,
    chargePoints: [
      { id: "stcp_gru_1", ocppIdentity: "CP-GRU-01", vendor: "ABB", model: "Terra 184", online: true, connectors: [conn("DC_CCS2", "AVAILABLE", 150, 1), conn("DC_CCS2", "AVAILABLE", 150, 2)] },
    ],
  },
  {
    id: "st_sbc",
    name: "São Bernardo — Golden Square",
    addressLine: "Av. Kennedy, 1000",
    city: "São Bernardo do Campo",
    state: "SP",
    latitude: -23.7008,
    longitude: -46.542,
    chargePoints: [{ id: "stcp_sbc_1", ocppIdentity: "CP-SBC-01", vendor: "Siemens", model: "SICHARGE UC100", online: true, connectors: [conn("DC_CCS2", "FAULTED", 100, 1), conn("AC_TYPE2", "AVAILABLE", 22, 2)] }],
  },
  {
    id: "st_cotia",
    name: "Cotia — Raposo Tavares",
    addressLine: "Rod. Raposo Tavares, km 30",
    city: "Cotia",
    state: "SP",
    latitude: -23.6037,
    longitude: -46.9192,
    chargePoints: [{ id: "stcp_cotia_1", ocppIdentity: "CP-COTIA-01", vendor: "WEG", model: "EVR-60", online: true, connectors: [conn("DC_CCS2", "CHARGING", 60, 1)] }],
  },
  {
    id: "st_santos",
    name: "Santos — Orla",
    addressLine: "Av. Presidente Wilson, 200",
    city: "Santos",
    state: "SP",
    latitude: -23.9608,
    longitude: -46.3336,
    chargePoints: [{ id: "stcp_santos_1", ocppIdentity: "CP-SANTOS-01", vendor: "ABB", model: "Terra 54", online: true, connectors: [conn("DC_CCS2", "AVAILABLE", 60, 1), conn("AC_TYPE2", "AVAILABLE", 22, 2)] }],
  },
]

/** `isFree`: a regra única do servidor — carregador online E AVAILABLE. */
const isFree = (online: boolean, status: ConnectorStatus) => online && status === "AVAILABLE"

function summarize(chargePoints: PublicChargePoint[]): PublicSite["connectorSummary"] {
  const groups = new Map<string, PublicConnectorGroup>()
  let total = 0
  let free = 0
  for (const cp of chargePoints) {
    for (const c of cp.connectors) {
      total += 1
      if (c.isFree) free += 1
      const power = c.maxPowerKw === null ? null : Number(c.maxPowerKw)
      const key = `${c.type}|${power}`
      const group = groups.get(key) ?? { type: c.type, maxPowerKw: power, total: 0, free: 0 }
      group.total += 1
      if (c.isFree) group.free += 1
      groups.set(key, group)
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || (b.maxPowerKw ?? 0) - (a.maxPowerKw ?? 0))
  return { total, free, groups: ordered }
}

function fromExtra(station: ExtraStation): PublicSite {
  const chargePoints: PublicChargePoint[] = station.chargePoints.map((cp) => ({
    id: cp.id,
    ocppIdentity: cp.ocppIdentity,
    online: cp.online,
    vendor: cp.vendor,
    model: cp.model,
    connectors: cp.connectors.map<PublicConnector>((c) => ({
      id: c.id,
      connectorId: c.connectorId,
      type: c.type,
      status: c.status,
      maxPowerKw: String(c.maxPowerKw),
      isFree: isFree(cp.online, c.status),
    })),
  }))
  return {
    id: station.id,
    name: station.name,
    addressLine: station.addressLine,
    city: station.city,
    state: station.state,
    latitude: station.latitude,
    longitude: station.longitude,
    chargePoints,
    connectorSummary: summarize(chargePoints),
  }
}

function fromBaseSite(siteId: string): PublicSite | null {
  const site = mockSites.find((s) => s.id === siteId && s.active)
  if (!site) return null
  const chargePoints: PublicChargePoint[] = mockChargePoints
    .filter((cp) => cp.siteId === site.id && cp.active)
    .map((cp) => ({
      id: cp.id,
      ocppIdentity: cp.ocppIdentity,
      online: cp.active,
      vendor: cp.vendor,
      model: cp.model,
      connectors: mockConnectors
        .filter((c) => c.chargePointId === cp.id)
        .map<PublicConnector>((c) => ({
          id: c.id,
          connectorId: c.connectorId,
          type: c.type,
          status: c.status,
          maxPowerKw: c.maxPowerKw,
          isFree: isFree(cp.active, c.status),
        })),
    }))
  return {
    id: site.id,
    name: site.name,
    addressLine: site.addressLine,
    city: site.city,
    state: site.state,
    latitude: site.latitude,
    longitude: site.longitude,
    chargePoints,
    connectorSummary: summarize(chargePoints),
  }
}

/** Todos os sites públicos (base + extras), já no formato do contrato estendido. */
export function buildPublicSites(): PublicSite[] {
  const base = mockSites.map((s) => fromBaseSite(s.id)).filter((s): s is PublicSite => s !== null)
  return [...base, ...extraStations.map(fromExtra)]
}

// ---------------------------------------------------------------------------
// Virada de status pro tempo real (só extras online) — ordem FIXA: a primeira
// vira o carregador mais próximo da Av. Paulista (o E2E depende disso).
// ---------------------------------------------------------------------------

const FLIP_SEQUENCE: Array<{ stationId: string; chargePointId: string; connectorId: number }> = [
  { stationId: "st_paulista", chargePointId: "stcp_paulista_1", connectorId: 1 }, // AVAILABLE → CHARGING (2 de 4 → 1 de 4)
  { stationId: "st_santoandre", chargePointId: "stcp_sa_2", connectorId: 2 },
  { stationId: "st_paulista", chargePointId: "stcp_paulista_1", connectorId: 1 }, // volta a AVAILABLE
  { stationId: "st_guarulhos", chargePointId: "stcp_gru_1", connectorId: 1 },
]
let flipIndex = 0

/** Alterna livre↔carregando do próximo conector da sequência e devolve o que mudou (vira o evento `chargepoint.status`). */
export function flipNextConnector(): { chargePointId: string; connectorId: number; status: ConnectorStatus } | null {
  const step = FLIP_SEQUENCE[flipIndex % FLIP_SEQUENCE.length]
  flipIndex += 1
  const cp = extraStations.find((s) => s.id === step.stationId)?.chargePoints.find((c) => c.id === step.chargePointId)
  const connector = cp?.connectors.find((c) => c.connectorId === step.connectorId)
  if (!cp || !connector) return null
  connector.status = connector.status === "AVAILABLE" ? "CHARGING" : "AVAILABLE"
  return { chargePointId: cp.id, connectorId: connector.connectorId, status: connector.status }
}
