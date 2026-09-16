/**
 * Dados em memória do MSW — só para validar os CONTRATOS no navegador
 * enquanto o backend real (Postgres/Redis via EasyPanel) não está acessível
 * deste ambiente. Formato idêntico ao que a Vega documentou nas rotas
 * (`backend/src/api/routes/*.ts`) — não é fixture de teste automatizado,
 * é sessão de dev manual (`VITE_USE_MOCKS=true npm run dev`).
 */
import type { AuthToken, ChargePoint, Connector, Site, Tariff, User } from "@/types/api"

export const OPERATOR_A_ID = "operator_a_cuid000000000001"
export const OPERATOR_B_ID = "operator_b_cuid000000000002"

export interface MockUser extends User {
  password: string
}

export const mockUsers: MockUser[] = [
  { id: "user_admin", name: "Ana Admin", email: "admin@innoelektron.com", role: "ADMIN", operatorId: null, password: "senha1234" },
  { id: "user_operator", name: "Beto Operador", email: "operador@innoelektron.com", role: "OPERATOR", operatorId: OPERATOR_A_ID, password: "senha1234" },
]

export const mockSites: Site[] = [
  {
    id: "site_1",
    operatorId: OPERATOR_A_ID,
    name: "Shopping Vila Norte",
    addressLine: "Av. das Nações, 1200",
    city: "São Paulo",
    state: "SP",
    postalCode: "01000-000",
    country: "BR",
    latitude: -23.55052,
    longitude: -46.633309,
    timezone: "America/Sao_Paulo",
    openingHours: null,
    active: true,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  },
  {
    id: "site_2",
    operatorId: OPERATOR_B_ID,
    name: "Posto Estrada Real",
    addressLine: "Rod. BR-040, km 12",
    city: "Juiz de Fora",
    state: "MG",
    postalCode: "36000-000",
    country: "BR",
    latitude: -21.7642,
    longitude: -43.3496,
    timezone: "America/Sao_Paulo",
    openingHours: null,
    active: true,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
  },
]

export const mockChargePoints: ChargePoint[] = [
  {
    id: "cp_1",
    operatorId: OPERATOR_A_ID,
    siteId: "site_1",
    ocppIdentity: "CP-VILA-NORTE-01",
    vendor: "ABB",
    model: "Terra 54",
    serialNumber: "SN-001",
    firmwareVersion: "1.4.2",
    active: true,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  },
  {
    id: "cp_2",
    operatorId: OPERATOR_B_ID,
    siteId: "site_2",
    ocppIdentity: "CP-ESTRADA-REAL-01",
    vendor: "WEG",
    model: "EVR-22",
    serialNumber: "SN-002",
    firmwareVersion: "2.0.1",
    active: true,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
  },
]

export const mockConnectors: Connector[] = [
  { id: "conn_1", operatorId: OPERATOR_A_ID, chargePointId: "cp_1", connectorId: 1, type: "DC_CCS2", status: "AVAILABLE", maxPowerKw: "60", createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z" },
  { id: "conn_2", operatorId: OPERATOR_A_ID, chargePointId: "cp_1", connectorId: 2, type: "AC_TYPE2", status: "CHARGING", maxPowerKw: "22", createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z" },
  { id: "conn_3", operatorId: OPERATOR_B_ID, chargePointId: "cp_2", connectorId: 1, type: "DC_CHADEMO", status: "FAULTED", maxPowerKw: "50", createdAt: "2026-08-02T12:00:00.000Z", updatedAt: "2026-08-02T12:00:00.000Z" },
]

export const mockTariffs: Tariff[] = [
  {
    id: "tariff_1",
    operatorId: OPERATOR_A_ID,
    name: "Padrão DC",
    model: "PER_KWH",
    pricePerKwh: "1.9900",
    pricePerMinute: null,
    sessionFeeCents: 200,
    minChargeCents: 500,
    idleFeePerMinute: 50,
    idleGracePeriodSeconds: 300,
    currency: "BRL",
    active: true,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  },
]

export const mockAuthTokens: AuthToken[] = [
  { id: "tok_1", idTag: "RFID0001", type: "RFID", status: "ACCEPTED", userId: null, expiresAt: null, createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z" },
]
