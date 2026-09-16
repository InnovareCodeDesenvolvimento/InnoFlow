import { Activity, CalendarDays, CreditCard, KeyRound, LayoutDashboard, Landmark, MapPin, Plug, TrendingUp, Wallet, Zap } from "lucide-react"
import type { NavGroup, NavItem } from "@/components/painel/navegacao"
import { flattenNav, matchNavItem } from "@/components/painel/navegacao"
import type { Role } from "@/types/api"

export type AdminNavItem = NavItem
export type AdminNavGroup = NavGroup

const BASE_NAV: NavGroup[] = [
  {
    title: "Retaguarda",
    items: [
      { label: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard, exact: true, hint: "Visão geral do faturamento e da operação" },
      { label: "Financeiro", href: "/admin/financeiro", icon: Landmark, hint: "Faturamento, cartão, carteira e conciliação" },
      { label: "Movimento diário", href: "/admin/movimento-diario", icon: CalendarDays, hint: "Sessões e faturamento por dia e eletroposto" },
      { label: "Faturamento", href: "/admin/faturamento", icon: TrendingUp, hint: "Série temporal de receita, com detalhamento" },
      { label: "Sessões", href: "/admin/sessoes", icon: Activity, hint: "Analítico de sessões, com filtros e detalhe" },
      { label: "Pagamentos", href: "/admin/pagamentos", icon: CreditCard, hint: "Tentativas de cobrança — cartão, Pix e carteira" },
    ],
  },
  {
    title: "Infraestrutura",
    items: [
      { label: "Sites", href: "/admin/sites", icon: MapPin, exact: true, hint: "Endereços dos eletropostos" },
      { label: "Pontos de recarga", href: "/admin/charge-points", icon: Zap, hint: "Carregadores OCPP e comandos remotos" },
      { label: "Conectores", href: "/admin/connectors", icon: Plug, hint: "Tomadas de cada carregador" },
    ],
  },
  {
    title: "Comercial",
    items: [{ label: "Tarifas", href: "/admin/tariffs", icon: Wallet, hint: "Preço por kWh, minuto e taxa de ociosidade" }],
  },
]

/** Item exclusivo de ADMIN — `AuthToken` não tem `operatorId`, então a API restringe a rota inteira a ADMIN (ver `authTokens.ts`). */
const ADMIN_ONLY_ITEM: NavItem = {
  label: "Tokens de autenticação",
  href: "/admin/auth-tokens",
  icon: KeyRound,
  hint: "RFID e tokens de app da rede",
}

/** Navegação efetiva do painel, ajustada por papel: OPERATOR não vê "Tokens de autenticação" — a rota nem responde para ele (403). */
export function getAdminNav(role: Role | undefined): NavGroup[] {
  if (role !== "ADMIN") return BASE_NAV
  return [...BASE_NAV, { title: "Rede", items: [ADMIN_ONLY_ITEM] }]
}

export const ADMIN_NAV_ITEMS: NavItem[] = flattenNav(BASE_NAV)

export function matchAdminNavItem(pathname: string, role: Role | undefined): NavItem | undefined {
  return matchNavItem(getAdminNav(role), pathname)
}
