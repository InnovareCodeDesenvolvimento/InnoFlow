import logoIcon from "@/assets/landing/logo-icon-96.webp?url"
import { cn } from "@/lib/utils"

/**
 * Marca: ícone (webp 96 px) + "InnoFlow" em 800. `tone="dark"` = texto branco, para superfície escura (cabeçalho do app, painel de auth);
 * `tone="light"` = texto `ink`, para fundo claro. Decorativo por padrão: o link/botão ao redor é quem tem o nome acessível
 * (a landing usa `aria-label="InnoFlow, início"`); o ícone leva `alt=""`.
 */
export function Logo({ tone = "dark", size = 36, showName = true, className }: { tone?: "dark" | "light"; size?: number; showName?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <img src={logoIcon} alt="" width={size} height={size} decoding="async" className="shrink-0" style={{ width: size, height: size }} />
      {showName && <span className={cn("text-lg font-extrabold tracking-tight", tone === "dark" ? "text-white" : "text-ink")}>InnoFlow</span>}
    </span>
  )
}
