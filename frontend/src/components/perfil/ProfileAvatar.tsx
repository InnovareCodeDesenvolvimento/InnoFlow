import { cn } from "@/lib/utils"
import { nameInitial } from "@/lib/profileDisplay"

/**
 * Avatar de iniciais para uso SOBRE superfície escura (cabeçalho do app, faixa do perfil). Decorativo: o nome acessível está no texto ao lado
 * (`aria-hidden`). Sem foto: o produto não tem upload de imagem de perfil.
 */
export function ProfileAvatar({ name, size = "md", className }: { name: string | null | undefined; size?: "sm" | "md"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-white/10 font-black text-white ring-1 ring-white/20",
        size === "sm" ? "h-8 w-8 text-sm" : "h-14 w-14 text-xl",
        className,
      )}
    >
      {nameInitial(name)}
    </span>
  )
}
