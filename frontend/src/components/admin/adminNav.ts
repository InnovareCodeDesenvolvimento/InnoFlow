import { Activity, CalendarDays, CreditCard, KeyRound, LayoutDashboard, Landmark, MapPin, Plug, ScrollText, TrendingUp, Wallet, Zap } from "lucide-react"
import type { NavGroup, NavItem } from "@/components/painel/navegacao"
import { flattenNav, matchNavItem } from "@/components/painel/navegacao"
import type { Role } from "@/types/api"

export type AdminNavItem = NavItem
export type AdminNavGroup = NavGroup

/**
 * Agrupado por SETOR (pedido do dono, 17/09/2026) — antes um único grupo
 * "Retaguarda" misturava operação (sessões, carregadores) com financeiro
 * (faturamento, pagamentos), o que não ajuda quem está procurando algo às
 * pressas. "Rede" continua à parte (ver `getAdminNav`): não é operação do
 * dia a dia, é administração da PLATAFORMA — só ADMIN vê.
 */
const BASE_NAV: NavGroup[] = [
  {
    title: "Operacional",
    items: [
      { label: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard, exact: true, hint: "Visão geral do faturamento e da operação" },
      { label: "Sessões", href: "/admin/sessoes", icon: Activity, hint: "Monitoramento e analítico de sessões de recarga" },
      { label: "Pontos de recarga", href: "/admin/charge-points", icon: Zap, hint: "Carregadores OCPP e comandos remotos" },
      { label: "Conectores", href: "/admin/connectors", icon: Plug, hint: "Tomadas de cada carregador" },
      { label: "Sites", href: "/admin/sites", icon: MapPin, exact: true, hint: "Endereços dos eletropostos" },
    ],
  },
  {
    title: "Financeiro",
    items: [
      { label: "Financeiro", href: "/admin/financeiro", icon: Landmark, hint: "Faturamento, cartão, carteira e conciliação" },
      { label: "Faturamento", href: "/admin/faturamento", icon: TrendingUp, hint: "Série temporal de receita, com detalhamento" },
      { label: "Movimento diário", href: "/admin/movimento-diario", icon: CalendarDays, hint: "Sessões e faturamento por dia e eletroposto" },
      { label: "Pagamentos", href: "/admin/pagamentos", icon: CreditCard, hint: "Tentativas de cobrança — cartão, Pix e carteira" },
    ],
  },
  {
    title: "Comercial",
    items: [{ label: "Tarifas", href: "/admin/tariffs", icon: Wallet, hint: "Preço por kWh, minuto e taxa de ociosidade" }],
  },
]

/**
 * Itens exclusivos de ADMIN — "administração da rede/plataforma", não
 * operação do dia a dia. `AuthToken` não tem `operatorId` (rota ADMIN-only
 * de verdade, ver `authTokens.ts`); `AuditLog` é ADMIN-only por decisão de
 * produto (rastreabilidade da rede inteira, ver `decisoes-audit-log.md`).
 */
const ADMIN_ONLY_ITEMS: NavItem[] = [
  { label: "Tokens de autenticação", href: "/admin/auth-tokens", icon: KeyRound, hint: "RFID e tokens de app da rede" },
  { label: "Auditoria", href: "/admin/auditoria", icon: ScrollText, hint: "Quem fez o quê, onde e como" },
]

/** Navegação efetiva do painel, ajustada por papel: OPERATOR não vê o grupo "Rede" — as rotas nem respondem para ele (403). */
export function getAdminNav(role: Role | undefined): NavGroup[] {
  if (role !== "ADMIN") return BASE_NAV
  return [...BASE_NAV, { title: "Rede", items: ADMIN_ONLY_ITEMS }]
}

export const ADMIN_NAV_ITEMS: NavItem[] = flattenNav(BASE_NAV)

export function matchAdminNavItem(pathname: string, role: Role | undefined): NavItem | undefined {
  return matchNavItem(getAdminNav(role), pathname)
}
