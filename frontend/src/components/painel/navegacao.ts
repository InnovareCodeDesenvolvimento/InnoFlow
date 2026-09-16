import type { LucideIcon } from "lucide-react"

/**
 * Vocabulário de navegação do painel admin — sidebar e drawer mobile
 * compartilham a mesma fonte, para "adicionei a rota e esqueci do menu" não
 * acontecer.
 */

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  /** Casa a rota por igualdade (e não por prefixo) — usado no item índice. */
  exact?: boolean
  hint?: string
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

export function flattenNav(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((g) => g.items)
}

/** Item cuja rota casa com o pathname atual — o mais específico (href mais longo) vence. */
export function matchNavItem(groups: NavGroup[], pathname: string): NavItem | undefined {
  return [...flattenNav(groups)]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => (item.exact ? pathname === item.href || pathname === `${item.href}/` : pathname.startsWith(item.href)))
}
