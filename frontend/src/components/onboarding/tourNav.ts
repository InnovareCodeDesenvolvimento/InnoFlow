/** Forma mínima do menu que o tour precisa (casa com `NavGroup` de `components/painel/navegacao`, sem importar o ícone). */
export interface NavGroupLike {
  title: string
  items: readonly { href: string; label: string }[]
}

export interface NavSummary {
  hrefs: readonly string[]
  labels: readonly string[]
  groups: readonly string[]
}

export const EMPTY_NAV: NavSummary = { hrefs: [], labels: [], groups: [] }

/** Resumo estável do menu (o roteiro filtra passos por `hrefs` e escreve "Operacional, Financeiro e Comercial" a partir de `groups`). */
export function summarizeNav(nav: readonly NavGroupLike[]): NavSummary {
  if (nav.length === 0) return EMPTY_NAV
  return {
    hrefs: nav.flatMap((g) => g.items.map((i) => i.href)),
    labels: nav.flatMap((g) => g.items.map((i) => i.label)),
    groups: nav.map((g) => g.title),
  }
}
