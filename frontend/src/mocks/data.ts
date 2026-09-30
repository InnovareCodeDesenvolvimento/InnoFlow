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

export const mockOperators = [
  { id: OPERATOR_A_ID, name: "InnovareCharge Sudeste", active: true },
  { id: OPERATOR_B_ID, name: "Posto Estrada Real Ltda.", active: true },
]

export interface MockUser extends User {
  password: string
}

/** `operatorName` espelha o join `Operator.name` que o backend faz em `/api/auth/login` — nunca hardcoded solto, sempre derivado de `mockOperators` para não divergir. */
function operatorNameFor(operatorId: string | null): string | null {
  return operatorId ? (mockOperators.find((o) => o.id === operatorId)?.name ?? null) : null
}

export const mockUsers: MockUser[] = [
  { id: "user_admin", name: "Ana Admin", email: "admin@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  {
    id: "user_operator",
    name: "Beto Operador",
    email: "operador@innoelektron.com",
    role: "OPERATOR",
    operatorId: OPERATOR_A_ID,
    operatorName: operatorNameFor(OPERATOR_A_ID),
    password: "senha1234",
  },
  // Motorista — conta única de rede, sem operatorId (ver PROGRESSO.md). Usado
  // pelo PWA do motorista (`/c/...`, `/app/*`, ver `mocks/meData.ts`).
  { id: "user_driver", name: "Carla Motorista", email: "motorista@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
  // Motorista com DÍVIDA em aberto (F5.1 — recarga Pix) — conta separada da de cima de
  // propósito: `user_driver` é usada por `pwa-fluxo-recarga.spec.ts` com saldo/dívida
  // exatos (50,00 / 0), então semear dívida nela quebraria aquele teste. `getWalletState`
  // (`mocks/meData.ts`) reconhece este id e nasce com `openDebtCents` > 0.
  { id: "user_driver_devedor", name: "Diego Devedor", email: "devedor@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
  // Motorista com CARTÕES pré-cadastrados (F5.4 — pagamento na recarga) — conta
  // separada de `user_driver` de propósito: registrar um cartão via UI e depois
  // navegar de verdade (`page.goto`) pra `/c/:id` perde o estado do mock (cada
  // navegação recarrega o módulo que roda os handlers do MSW, ver
  // `.claude/agent-memory/lyra/` da F5.4) — pré-semear aqui é a única forma
  // determinística de testar o SELETOR de pagamento ponta a ponta.
  // `getPaymentMethods` (`mocks/meData.ts`) reconhece este id e nasce com 4
  // cartões, um por gatilho de holderName (aprovado/recusa/gateway/parcial).
  { id: "user_driver_cartoes", name: "Paula Cartões", email: "cartoes@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
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
  {
    id: "site_3",
    operatorId: OPERATOR_A_ID,
    name: "Terminal Rodoviário Barra Funda",
    addressLine: "Av. Auro Soares de Moura Andrade, 664",
    city: "São Paulo",
    state: "SP",
    postalCode: "01156-001",
    country: "BR",
    latitude: -23.5265,
    longitude: -46.6656,
    timezone: "America/Sao_Paulo",
    openingHours: null,
    active: true,
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  },
  {
    id: "site_4",
    operatorId: OPERATOR_A_ID,
    name: "Outlet Premium Campinas",
    addressLine: "Rod. Dom Pedro I, km 103",
    city: "Campinas",
    state: "SP",
    postalCode: "13098-330",
    country: "BR",
    latitude: -22.9099,
    longitude: -47.0181,
    timezone: "America/Sao_Paulo",
    openingHours: null,
    active: true,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  },
  {
    id: "site_5",
    operatorId: OPERATOR_A_ID,
    name: "Estação Rodovia Anhanguera",
    addressLine: "Rod. Anhanguera, km 98",
    city: "Jundiaí",
    state: "SP",
    postalCode: "13208-900",
    country: "BR",
    latitude: -23.1857,
    longitude: -46.8847,
    timezone: "America/Sao_Paulo",
    openingHours: null,
    active: true,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
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
  {
    id: "cp_3",
    operatorId: OPERATOR_A_ID,
    siteId: "site_3",
    ocppIdentity: "CP-BARRA-FUNDA-01",
    vendor: "ABB",
    model: "Terra 184",
    serialNumber: "SN-003",
    firmwareVersion: "1.4.2",
    active: true,
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  },
  {
    id: "cp_4",
    operatorId: OPERATOR_A_ID,
    siteId: "site_4",
    ocppIdentity: "CP-OUTLET-CAMPINAS-01",
    vendor: "Siemens",
    model: "SICHARGE UC100",
    serialNumber: "SN-004",
    firmwareVersion: "3.1.0",
    active: true,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  },
  {
    id: "cp_5",
    operatorId: OPERATOR_A_ID,
    siteId: "site_5",
    ocppIdentity: "CP-ANHANGUERA-01",
    vendor: "WEG",
    model: "EVR-60",
    serialNumber: "SN-005",
    firmwareVersion: "2.0.1",
    active: true,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
  },
]

export const mockConnectors: Connector[] = [
  { id: "conn_1", operatorId: OPERATOR_A_ID, chargePointId: "cp_1", connectorId: 1, type: "DC_CCS2", status: "AVAILABLE", maxPowerKw: "60", createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z" },
  { id: "conn_2", operatorId: OPERATOR_A_ID, chargePointId: "cp_1", connectorId: 2, type: "AC_TYPE2", status: "CHARGING", maxPowerKw: "22", createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z" },
  { id: "conn_3", operatorId: OPERATOR_B_ID, chargePointId: "cp_2", connectorId: 1, type: "DC_CHADEMO", status: "FAULTED", maxPowerKw: "50", createdAt: "2026-08-02T12:00:00.000Z", updatedAt: "2026-08-02T12:00:00.000Z" },
  { id: "conn_4", operatorId: OPERATOR_A_ID, chargePointId: "cp_3", connectorId: 1, type: "DC_CCS2", status: "CHARGING", maxPowerKw: "120", createdAt: "2026-08-03T12:00:00.000Z", updatedAt: "2026-08-03T12:00:00.000Z" },
  { id: "conn_5", operatorId: OPERATOR_A_ID, chargePointId: "cp_3", connectorId: 2, type: "DC_CCS2", status: "AVAILABLE", maxPowerKw: "120", createdAt: "2026-08-03T12:00:00.000Z", updatedAt: "2026-08-03T12:00:00.000Z" },
  { id: "conn_6", operatorId: OPERATOR_A_ID, chargePointId: "cp_4", connectorId: 1, type: "AC_TYPE2", status: "AVAILABLE", maxPowerKw: "22", createdAt: "2026-08-04T12:00:00.000Z", updatedAt: "2026-08-04T12:00:00.000Z" },
  { id: "conn_7", operatorId: OPERATOR_A_ID, chargePointId: "cp_5", connectorId: 1, type: "DC_CCS2", status: "UNAVAILABLE", maxPowerKw: "60", createdAt: "2026-08-05T12:00:00.000Z", updatedAt: "2026-08-05T12:00:00.000Z" },
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
  {
    id: "tariff_2",
    operatorId: OPERATOR_A_ID,
    name: "Expressa Rodovia",
    model: "PER_KWH",
    pricePerKwh: "2.4900",
    pricePerMinute: null,
    sessionFeeCents: 0,
    minChargeCents: 1000,
    idleFeePerMinute: 80,
    idleGracePeriodSeconds: 180,
    currency: "BRL",
    active: true,
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  },
  {
    id: "tariff_3",
    operatorId: OPERATOR_B_ID,
    name: "Padrão Posto",
    model: "PER_KWH",
    pricePerKwh: "1.7900",
    pricePerMinute: null,
    sessionFeeCents: 0,
    minChargeCents: 500,
    idleFeePerMinute: 40,
    idleGracePeriodSeconds: 300,
    currency: "BRL",
    active: true,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
  },
]

/** Pool de motoristas sintéticos — usado só pelo gerador de sessões (ver `reportsData.ts`), nunca pelo CRUD de `User`. */
export const mockDrivers = [
  { name: "Carla Mendes", email: "carla.mendes@example.com" },
  { name: "Rafael Souza", email: "rafael.souza@example.com" },
  { name: "Juliana Alves", email: "juliana.alves@example.com" },
  { name: "Marcos Vinícius Lima", email: "marcos.lima@example.com" },
  { name: "Patrícia Nunes", email: "patricia.nunes@example.com" },
  { name: "Eduardo Ferreira", email: "eduardo.ferreira@example.com" },
  { name: "Aline Barbosa", email: "aline.barbosa@example.com" },
  { name: "Thiago Rocha", email: "thiago.rocha@example.com" },
  { name: "Bruna Castro", email: "bruna.castro@example.com" },
  { name: "Felipe Andrade", email: "felipe.andrade@example.com" },
  { name: "Camila Pires", email: "camila.pires@example.com" },
  { name: "Gustavo Ramos", email: "gustavo.ramos@example.com" },
]

export const mockAuthTokens: AuthToken[] = [
  { id: "tok_1", idTag: "RFID0001", type: "RFID", status: "ACCEPTED", userId: null, expiresAt: null, createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z" },
]
