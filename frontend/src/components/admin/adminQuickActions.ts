import { Activity, LayoutDashboard, ScrollText, TrendingUp, Zap, type LucideIcon } from "lucide-react"
import type { Role } from "@/types/api"

/**
 * Atalhos rápidos — pedido do dono (17/09/2026): "as opções mais usadas"
 * sempre à mão, sem precisar navegar pelos grupos. Vivem no HEADER do painel
 * (`QuickActionsBar`/`QuickActionsDropdown`, ver `Admin/Layout.tsx`), não na
 * sidebar — o dono testou a primeira versão (na sidebar) e achou que
 * misturava "navegação" com "ação"; separar em faixas diferentes ficou mais
 * profissional (ajuste de 17/09/2026, mesmo dia).
 *
 * CURADORIA ESTÁTICA por ora: não existe telemetria de uso real no projeto
 * (seria escopo novo, fora desta rodada) — a lista abaixo é um julgamento de
 * design sobre o que um operador mexe todo dia (monitorar sessão, cadastrar/
 * comandar carregador, ver o caixa do dia, e auditoria pra quem investiga
 * algo). Se o dono quiser, uma versão futura pode aprender com cliques reais
 * e reordenar/sugerir sozinha — não implementado agora.
 *
 * `?period=today` é lido pelas próprias telas (`Faturamento`/`Auditoria`) via
 * `useSearchParams` como preset inicial do `useReportPeriod` — não é um
 * parâmetro novo de contrato, só a mesma UI de período já aceitando entrar
 * "pré-filtrada".
 */
export interface QuickAction {
  label: string
  href: string
  icon: LucideIcon
  hint: string
  /** `undefined` = visível para todo mundo que entra no painel (ADMIN/OPERATOR). */
  adminOnly?: boolean
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Dashboard ao vivo", href: "/admin/dashboard", icon: LayoutDashboard, hint: "Sessões ativas agora" },
  { label: "Pontos de recarga", href: "/admin/charge-points", icon: Zap, hint: "Cadastrar carregador ou disparar comando remoto" },
  { label: "Sessões", href: "/admin/sessoes", icon: Activity, hint: "Analítico de sessões, com detalhe" },
  { label: "Faturamento de hoje", href: "/admin/faturamento?period=today", icon: TrendingUp, hint: "Receita do dia" },
  { label: "Auditoria de hoje", href: "/admin/auditoria?period=today", icon: ScrollText, hint: "O que aconteceu hoje na rede", adminOnly: true },
]

export function getQuickActions(role: Role | undefined): QuickAction[] {
  return QUICK_ACTIONS.filter((a) => !a.adminOnly || role === "ADMIN")
}
