/**
 * Motoristas sintéticos da tela Admin → Carteiras (`GET /api/admin/drivers`,
 * `GET .../:id/wallet`, `POST .../wallet/entries`), no formato real do backend
 * (`drivers.routes.ts`). O motorista de teste do PWA (`user_driver`, "Carla
 * Motorista") NÃO é sintético: a carteira dele é a MESMA do PWA (`meData.ts`),
 * então creditar no painel muda o que ele vê no app. Os outros 11 têm saldos e
 * dívidas variados (zero, pequeno, grande, dívida aberta, sessão ativa, extrato
 * longo pra paginação).
 */
import { adjustMockWallet, getMockWallet } from "./meData"
import type { DriverListRow, DriverWalletResponse, WalletEntryRow, WalletEntryType } from "@/types/api"

interface SyntheticDriver {
  id: string
  name: string
  email: string
  openDebtCents: number
  activeSessionId: string | null
  createdAt: string
  /** Do mais ANTIGO ao mais novo; o saldo corrente é calculado daqui. */
  history: Array<{ type: WalletEntryType; amountCents: number; description: string; daysAgo: number }>
}

const daysAgoISO = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const REAL_DRIVER = { id: "user_driver", name: "Carla Motorista", email: "motorista@innoelektron.com", createdAt: daysAgoISO(20) }

const topup = (amountCents: number, daysAgo: number) => ({ type: "TOPUP_PIX" as const, amountCents, description: "Recarga de saldo via Pix", daysAgo })
const charge = (amountCents: number, daysAgo: number, site: string) => ({ type: "CHARGE_DEBIT" as const, amountCents: -amountCents, description: `Recarga em ${site}`, daysAgo })

/** Extrato longo (35 lançamentos) — exercita a paginação do drawer. */
function longHistory() {
  const rows: SyntheticDriver["history"] = [topup(200_000, 60)]
  const sites = ["Shopping Vila Norte", "Outlet Premium Campinas", "Estação Rodovia Anhanguera", "Terminal Rodoviário Barra Funda"]
  for (let i = 0; i < 33; i++) rows.push(charge(1500 + ((i * 731) % 4200), 58 - i, sites[i % sites.length]))
  rows.push({ type: "ADJUSTMENT_CREDIT", amountCents: 2_000, description: "Cortesia por falha do carregador", daysAgo: 3 })
  return rows
}

const SYNTHETIC: SyntheticDriver[] = [
  { id: "drv_02", name: "Rafael Souza", email: "rafael.souza@example.com", openDebtCents: 0, activeSessionId: null, createdAt: daysAgoISO(3), history: [topup(10_000, 3), charge(3_250, 2, "Shopping Vila Norte")] },
  { id: "drv_03", name: "Juliana Alves", email: "juliana.alves@example.com", openDebtCents: 1_850, activeSessionId: null, createdAt: daysAgoISO(9), history: [topup(2_000, 9), charge(2_000, 7, "Outlet Premium Campinas")] },
  { id: "drv_04", name: "Marcos Vinícius Lima", email: "marcos.lima@example.com", openDebtCents: 0, activeSessionId: "sess_demo_1", createdAt: daysAgoISO(30), history: [topup(20_000, 30), charge(4_100, 12, "Terminal Rodoviário Barra Funda")] },
  { id: "drv_05", name: "Patrícia Nunes", email: "patricia.nunes@example.com", openDebtCents: 0, activeSessionId: null, createdAt: daysAgoISO(45), history: longHistory() },
  { id: "drv_06", name: "Eduardo Ferreira", email: "eduardo.ferreira@example.com", openDebtCents: 0, activeSessionId: null, createdAt: daysAgoISO(2), history: [] },
  { id: "drv_07", name: "Aline Barbosa", email: "aline.barbosa@example.com", openDebtCents: 620, activeSessionId: null, createdAt: daysAgoISO(15), history: [topup(1_000, 15), charge(1_000, 14, "Estação Rodovia Anhanguera")] },
  { id: "drv_08", name: "Thiago Rocha", email: "thiago.rocha@example.com", openDebtCents: 0, activeSessionId: null, createdAt: daysAgoISO(60), history: [topup(100_000, 60), { type: "ADJUSTMENT_DEBIT", amountCents: -7_500, description: "Estorno de crédito lançado em duplicidade", daysAgo: 20 }] },
  { id: "drv_09", name: "Bruna Castro", email: "bruna.castro@example.com", openDebtCents: 0, activeSessionId: null, createdAt: daysAgoISO(5), history: [topup(5_000, 5), { type: "REFUND", amountCents: 1_200, description: "Estorno de sessão interrompida", daysAgo: 4 }] },
  { id: "drv_10", name: "Felipe Andrade", email: "felipe.andrade@example.com", openDebtCents: 0, activeSessionId: null, createdAt: daysAgoISO(1), history: [topup(500, 1)] },
  { id: "drv_11", name: "Camila Pires", email: "camila.pires@example.com", openDebtCents: 3_400, activeSessionId: null, createdAt: daysAgoISO(25), history: [topup(3_000, 25), charge(3_000, 21, "Shopping Vila Norte")] },
  { id: "drv_12", name: "Gustavo Ramos", email: "gustavo.ramos@example.com", openDebtCents: 0, activeSessionId: null, createdAt: daysAgoISO(40), history: [topup(15_000, 40), charge(2_800, 30, "Outlet Premium Campinas"), topup(5_000, 8)] },
]

// Estado mutável (ajustes do painel valem enquanto a página não recarrega).
const entriesByDriver = new Map<string, WalletEntryRow[]>()

function entriesFor(driver: SyntheticDriver): WalletEntryRow[] {
  const existing = entriesByDriver.get(driver.id)
  if (existing) return existing
  let running = 0
  const chronological = driver.history.map<WalletEntryRow>((h, i) => {
    running += h.amountCents
    return { id: `${driver.id}_we_${i}`, type: h.type, amountCents: h.amountCents, balanceAfterCents: running, referenceType: null, referenceId: null, description: h.description, createdAt: daysAgoISO(h.daysAgo) }
  })
  const newestFirst = chronological.reverse()
  entriesByDriver.set(driver.id, newestFirst)
  return newestFirst
}

function balanceOf(driver: SyntheticDriver): number {
  return entriesFor(driver)[0]?.balanceAfterCents ?? 0
}

const norm = (t: string) => t.toLowerCase()

/** `GET /api/admin/drivers` — mais novo primeiro; nome por trecho (case-insensitive), e-mail EXATO; `email` omitido para OPERATOR (LGPD). */
export function listDrivers(opts: { search?: string; page: number; pageSize: number; isAdmin: boolean }) {
  const real = getMockWallet(REAL_DRIVER.id, 1, 0)
  const all: Array<DriverListRow & { _email: string }> = [
    { id: REAL_DRIVER.id, name: REAL_DRIVER.name, _email: REAL_DRIVER.email, walletBalanceCents: real.balanceCents, openDebtCents: real.openDebtCents, activeSessionId: null, createdAt: REAL_DRIVER.createdAt },
    ...SYNTHETIC.map((d) => ({ id: d.id, name: d.name, _email: d.email, walletBalanceCents: balanceOf(d), openDebtCents: d.openDebtCents, activeSessionId: d.activeSessionId, createdAt: d.createdAt })),
  ]
  const term = opts.search ? norm(opts.search) : ""
  const filtered = all
    .filter((d) => !term || norm(d.name).includes(term) || norm(d._email) === term)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const start = (opts.page - 1) * opts.pageSize
  const items = filtered.slice(start, start + opts.pageSize).map(({ _email, ...row }) => (opts.isAdmin ? { ...row, email: _email } : row))
  return { items, total: filtered.length, page: opts.page, pageSize: opts.pageSize }
}

export function getDriverWallet(id: string, page: number, pageSize: number): DriverWalletResponse | null {
  if (id === REAL_DRIVER.id) {
    const w = getMockWallet(REAL_DRIVER.id, page, pageSize)
    return { driverId: REAL_DRIVER.id, driverName: REAL_DRIVER.name, balanceCents: w.balanceCents, openDebtCents: w.openDebtCents, entries: w.entries, total: w.total, page, pageSize }
  }
  const driver = SYNTHETIC.find((d) => d.id === id)
  if (!driver) return null
  const entries = entriesFor(driver)
  const start = (page - 1) * pageSize
  return { driverId: driver.id, driverName: driver.name, balanceCents: balanceOf(driver), openDebtCents: driver.openDebtCents, entries: entries.slice(start, start + pageSize), total: entries.length, page, pageSize }
}

/** `POST .../wallet/entries` — `null` = motorista inexistente; `INSUFFICIENT_BALANCE` quando o débito passa do saldo. */
export function adjustDriverWallet(id: string, amountCents: number, description: string): { ok: true; entry: WalletEntryRow } | { ok: false; code: "NOT_FOUND" | "INSUFFICIENT_BALANCE" } {
  if (id === REAL_DRIVER.id) return adjustMockWallet(id, amountCents, description)
  const driver = SYNTHETIC.find((d) => d.id === id)
  if (!driver) return { ok: false, code: "NOT_FOUND" }
  const balance = balanceOf(driver)
  if (balance + amountCents < 0) return { ok: false, code: "INSUFFICIENT_BALANCE" }
  const entry: WalletEntryRow = {
    id: `${driver.id}_adj_${Date.now()}`,
    type: amountCents > 0 ? "ADJUSTMENT_CREDIT" : "ADJUSTMENT_DEBIT",
    amountCents,
    balanceAfterCents: balance + amountCents,
    referenceType: null,
    referenceId: null,
    description,
    createdAt: new Date().toISOString(),
  }
  entriesFor(driver).unshift(entry)
  return { ok: true, entry }
}
