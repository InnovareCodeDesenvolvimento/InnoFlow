/**
 * Dados em memória do MSW — só para validar os CONTRATOS no navegador
 * enquanto o backend real (Postgres/Redis via EasyPanel) não está acessível
 * deste ambiente. Formato idêntico ao que a Vega documentou nas rotas
 * (`backend/src/api/routes/*.ts`) — não é fixture de teste automatizado,
 * é sessão de dev manual (`VITE_USE_MOCKS=true npm run dev`).
 */
import type { AuthToken, ChargePoint, Connector, Site, Tariff, TariffAssignment, User } from "@/types/api"

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
  // Admins de CENÁRIO do Gateway de pagamento (F5.5) — o estado do mock vive por usuário
  // (`mocks/paymentGatewayData.ts`), então cada conta nasce num cenário determinístico para o E2E.
  { id: "user_admin_gateway_pronto", name: "Gil Gateway", email: "gateway-pronto@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_gateway_producao", name: "Paulo Produção", email: "gateway-producao@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_gateway_sem_chave", name: "Sônia Sem-Chave", email: "gateway-sem-chave@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_gateway_falhas", name: "Fábio Falhas", email: "gateway-falhas@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_gateway_ilegivel", name: "Ivo Ilegível", email: "gateway-ilegivel@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  // F5.7: segredos que o servidor não decifra (GET 200 com `secretsDecryptable:false`), sandbox em servidor de produção
  // (`sandboxRestricted:true`) e troca de ambiente bloqueada por pagamentos em andamento (409 `GATEWAY_HAS_INFLIGHT_PAYMENTS`).
  { id: "user_admin_gateway_ilegivel_segredos", name: "Sílvia Segredos", email: "gateway-ilegivel-segredos@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_gateway_sandbox_publico", name: "Sandra Sandbox", email: "gateway-sandbox-publico@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  // Admins de CENÁRIO da tela Comunicação (N-7) — o estado do mock vive por usuário (`mocks/communicationData.ts`); cada conta nasce num cenário determinístico para o E2E.
  { id: "user_admin_comunicacao_pronta", name: "Cláudia Comunicação", email: "comunicacao-pronta@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_comunicacao_vazia", name: "Vera Vazia", email: "comunicacao-vazia@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_comunicacao_sem_chave", name: "Sérgio Sem-Chave", email: "comunicacao-sem-chave@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_comunicacao_ilegivel", name: "Iara Ilegível", email: "comunicacao-ilegivel@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_comunicacao_indisponivel", name: "Ítalo Indisponível", email: "comunicacao-indisponivel@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_comunicacao_rede_privada", name: "Rui Rede-Privada", email: "comunicacao-rede-privada@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_gateway_em_andamento", name: "Emílio Andamento", email: "gateway-em-andamento@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  // Admins de CENÁRIO da tela Backups — o estado do mock vive por usuário (`mocks/backupData.ts`); cada conta nasce num cenário determinístico para o E2E. `admin@` = primeiro uso (sem destino nem chave).
  { id: "user_admin_backup_s3", name: "Beto Bucket", email: "backup-s3@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_drive", name: "Dora Drive", email: "backup-drive@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_drive_desconectado", name: "Davi Desconectado", email: "backup-drive-desconectado@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_atrasado", name: "Alice Atrasada", email: "backup-atrasado@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_nunca", name: "Nuno Nunca", email: "backup-nunca@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_andamento", name: "Ana Andamento", email: "backup-andamento@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_sem_chave", name: "Silas Sem-Chave", email: "backup-sem-chave@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_ilegivel", name: "Ilda Ilegível", email: "backup-ilegivel@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
  { id: "user_admin_backup_indisponivel", name: "Ivan Indisponível", email: "backup-indisponivel@innoelektron.com", role: "ADMIN", operatorId: null, operatorName: null, password: "senha1234" },
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
  // Motorista de um mundo em que o ADMIN DESLIGOU o cartão e o Pix no gateway (F5.5):
  // `PAYMENT_METHOD_DISABLED` + `details: [{ method, reason: "GATEWAY_DISABLED" }]` nas 4 rotas
  // afetadas (`mocks/meData.ts`, `isGatewayDisabledFor`). Nasce com 1 cartão padrão salvo (o seletor
  // aparece) e saldo normal (a carteira continua funcionando). Conta separada de propósito: ligar o
  // cenário nos motoristas existentes quebraria os E2E de cartão/Pix.
  { id: "user_driver_gateway_off", name: "Gabi Gateway-Off", email: "gateway-off@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
  // F5.7: servidor de produção em SANDBOX e motorista fora da lista de testadores — as mesmas rotas respondem
  // `reason: "SANDBOX_RESTRICTED"` (a PWA mostra o mesmo "indisponível no momento"). Nasce com 1 cartão, como o `gateway-off@`.
  { id: "user_driver_gateway_restrito", name: "Rita Restrita", email: "gateway-restrito@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
  // F5.9 (sessão travada): histórico PRÉ-SEMEADO com 3 recibos (em confirmação WALLET, em confirmação CARD, encerrado pelo
  // servidor) + 1 sessão ATIVA em `FAULTED`. Conta separada pelo mesmo motivo das outras: o estado do mock vive na página,
  // então semear nos motoristas existentes quebraria os E2E de sessão/recarga (`seedStuckDemoSessions` em `mocks/meData.ts`).
  // C1.2: sessão de tokenização com `scriptUrl` do SOP REAL (host da Cielo) em vez do marcador `mock` - exercita no E2E o caminho
  // `bpSop_silentOrderPost` (o script em si é interceptado/substituído pelo teste; nada vai à Cielo). Conta separada de propósito, como as outras.
  { id: "user_driver_sop_real", name: "Sônia SOP", email: "sop-real@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
  // I-7 (cartão exige identidade verificada): conta só com SENHA (nunca entrou pelo Google) - `cardEligibility` volta GOOGLE_LOGIN_REQUIRED até vincular o Google
  // (o mock vincula ao clicar em "Continuar com o Google (mock)" ESTANDO logada nesta conta). Nasce com 2 cartões, que a tela mostra desabilitados.
  { id: "user_driver_so_senha", name: "Sofia Só-Senha", email: "so-senha@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234", hasPassword: true },
  // L1.2 (perfil): conta com telefone e CPF JÁ salvos (o CPF volta mascarado: "***.982.247-**") - exercita "Alterar CPF" e a edição do telefone. Conta separada de propósito,
  // como as outras: o estado do mock vive na página e os E2E de perfil mudam nome/senha.
  { id: "user_driver_perfil", name: "Paula Perfil", email: "perfil@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234", hasPassword: true },
  // L1.2: conta SÓ-GOOGLE (sem senha: `hasPassword: false`) - a tela mostra "Definir senha", sem o campo de senha atual. Só entra pelo Google (mock: `localStorage["mock:google-as"]="user_driver_so_google"`).
  { id: "user_driver_so_google", name: "Gael Google", email: "so-google@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "", hasPassword: false },
  // I-7: bloqueio TEMPORÁRIO por recusas em excesso (`TEMPORARILY_BLOCKED`, `blockedUntil` = ~47 min depois de a página carregar). Nasce com 1 cartão.
  { id: "user_driver_bloqueado", name: "Bruno Bloqueado", email: "bloqueado-cartao@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
  // L1.8: chargeback registrado pelo ADMIN - `cardEligibility` volta CHARGEBACK_BLOCKED e o cartão (cadastro, tokenização, iniciar com CARD) responde 403 `CARD_CHARGEBACK_BLOCKED`.
  // Pix e carteira seguem normais. Nasce com 2 cartões (aparecem desabilitados). Conta separada de propósito: o estado do mock vive na página e os E2E de cartão dependem de elegível.
  { id: "user_driver_chargeback", name: "Cléber Chargeback", email: "chargeback@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234", hasPassword: true },
  { id: "user_driver_travado", name: "Tiago Travado", email: "travado@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234" },
  // L1.4/L1.9 (privacidade): personas da exclusão de conta e do aceite dos termos (ver o cabeçalho de `mocks/legalData.ts`). Contas separadas de propósito: a exclusão ANONIMIZA a conta no
  // mock (o login com a senha antiga passa a falhar), então não pode ser feita em motorista que outro E2E usa.
  { id: "user_driver_exclusao", name: "Edu Exclusão", email: "exclusao@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234", hasPassword: true },
  { id: "user_driver_exclusao_zero", name: "Zeca Zero", email: "exclusao-zero@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234", hasPassword: true },
  { id: "user_driver_exclusao_google", name: "Gui Google-Exclusão", email: "exclusao-google@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "", hasPassword: false },
  { id: "user_driver_termos", name: "Téo Termos", email: "termos@innoelektron.com", role: "DRIVER", operatorId: null, operatorName: null, password: "senha1234", hasPassword: true },
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

/** `Date.now() - ms` em ISO. Só alimenta `lastSeenAt`/`connectedAt`/`disconnectedAt` dos carregadores de demo; a tela usa o `online` pronto, nunca recalcula por estas datas. */
const msAgo = (ms: number) => new Date(Date.now() - ms).toISOString()

/**
 * `online` é decisão do SERVIDOR (lote 1): aqui é um valor fixo por carregador. cp_1/cp_2/cp_3 online; cp_4 (Outlet Campinas, conector livre) CAIU há 2 h e cp_5 nunca
 * reportou - são os que mostram o aviso "offline" no diálogo de iniciar recarga e recusam o POST com `CHARGE_POINT_OFFLINE`.
 */
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
    online: true,
    lastSeenAt: msAgo(20_000),
    connectedAt: msAgo(3 * 3_600_000),
    disconnectedAt: null,
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
    online: true,
    lastSeenAt: msAgo(20_000),
    connectedAt: msAgo(3 * 3_600_000),
    disconnectedAt: null,
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
    online: true,
    lastSeenAt: msAgo(20_000),
    connectedAt: msAgo(3 * 3_600_000),
    disconnectedAt: null,
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
    online: false,
    lastSeenAt: msAgo(2 * 3_600_000),
    connectedAt: msAgo(5 * 3_600_000),
    disconnectedAt: msAgo(2 * 3_600_000 - 60_000),
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
    online: false,
    lastSeenAt: null,
    connectedAt: null,
    disconnectedAt: null,
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

/**
 * Vínculos de tarifa semeados de propósito para cobrir os estados da tela "Tarifas do carregador":
 *  - cp_1: tarifa do LOCAL (tariff_1) + uma tomada (conn_2) com tarifa própria de prioridade maior -> "varia por tomada";
 *  - cp_3: tarifa do CARREGADOR (tariff_2) -> uniforme;
 *  - cp_4 e cp_5 (operador A) e cp_2 (operador B): SEM vínculo nenhum -> "Sem tarifa" (o QR não inicia recarga);
 *  - ta_hist: vínculo ENCERRADO (validTo no passado) do site_3 — aparece só em "mostrar encerrados".
 * A data do encerrado é relativa ao carregamento da página, para "encerrado" não envelhecer.
 */
const DAY_MS = 24 * 60 * 60 * 1000
export const mockTariffAssignments: TariffAssignment[] = [
  { id: "ta_1", operatorId: OPERATOR_A_ID, tariffId: "tariff_1", scope: "SITE", connectorId: null, chargePointId: null, siteId: "site_1", priority: 0, validFrom: "2026-08-01T12:00:00.000Z", validTo: null, createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z" },
  { id: "ta_2", operatorId: OPERATOR_A_ID, tariffId: "tariff_2", scope: "CHARGE_POINT", connectorId: null, chargePointId: "cp_3", siteId: null, priority: 0, validFrom: "2026-08-03T12:00:00.000Z", validTo: null, createdAt: "2026-08-03T12:00:00.000Z", updatedAt: "2026-08-03T12:00:00.000Z" },
  { id: "ta_3", operatorId: OPERATOR_A_ID, tariffId: "tariff_2", scope: "CONNECTOR", connectorId: "conn_2", chargePointId: null, siteId: null, priority: 5, validFrom: "2026-08-04T12:00:00.000Z", validTo: null, createdAt: "2026-08-04T12:00:00.000Z", updatedAt: "2026-08-04T12:00:00.000Z" },
  { id: "ta_hist", operatorId: OPERATOR_A_ID, tariffId: "tariff_1", scope: "SITE", connectorId: null, chargePointId: null, siteId: "site_3", priority: 0, validFrom: "2026-07-01T12:00:00.000Z", validTo: new Date(Date.now() - 20 * DAY_MS).toISOString(), createdAt: "2026-07-01T12:00:00.000Z", updatedAt: "2026-07-01T12:00:00.000Z" },
]
