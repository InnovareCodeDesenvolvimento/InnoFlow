import { BellRing, Building2, Mail, MessageCircle, type LucideIcon } from "lucide-react"

/**
 * Abas de /admin/configuracoes. Cada aba é uma SUBROTA (`/admin/configuracoes/<id>`, chunk próprio): trocar de aba troca a rota, e cada uma carrega só os seus dados.
 * Fonte única de id, rótulo, ícone, descrição e href (o `App.tsx`, o tour e o checklist apontam para estes caminhos).
 */
export const CONFIG_TAB_IDS = ["geral", "email", "whatsapp", "alertas"] as const
export type ConfigTabId = (typeof CONFIG_TAB_IDS)[number]
export const DEFAULT_CONFIG_TAB: ConfigTabId = "geral"

export const CONFIG_BASE_PATH = "/admin/configuracoes"

export const CONFIG_TABS: ReadonlyArray<{ id: ConfigTabId; label: string; icon: LucideIcon; description: string }> = [
  { id: "geral", label: "Geral", icon: Building2, description: "Dados da empresa que aparecem nos Termos de Uso e na Política de Privacidade." },
  { id: "email", label: "E-mail", icon: Mail, description: "Servidor SMTP dos lembretes e avisos por e-mail, com envio de teste." },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle, description: "Evolution API: o número que envia os avisos ao dono por WhatsApp, com envio de teste." },
  { id: "alertas", label: "Alertas", icon: BellRing, description: "Quem recebe os avisos ao dono por e-mail, a gravidade mínima de cada canal e a janela de repetição." },
]

export function isConfigTabId(value: string | null | undefined): value is ConfigTabId {
  return (CONFIG_TAB_IDS as readonly string[]).includes(value ?? "")
}

export const configTabHref = (tab: ConfigTabId) => `${CONFIG_BASE_PATH}/${tab}`

/** Aba a partir do caminho atual (`/admin/configuracoes/email` -> `email`); `null` fora delas. */
export function configTabFromPathname(pathname: string): ConfigTabId | null {
  if (!pathname.startsWith(`${CONFIG_BASE_PATH}/`)) return null
  const segment = pathname.slice(CONFIG_BASE_PATH.length + 1).split("/")[0]
  return isConfigTabId(segment) ? segment : null
}
