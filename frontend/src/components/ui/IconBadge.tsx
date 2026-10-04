import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Selo de ícone (quadrado arredondado tingido). Substitui 4 implementações iguais: PageHeader, DialogHeader, EmptyState, StatCard.
 * Decorativo por definição: `aria-hidden` sempre — o significado está no texto ao lado.
 *
 * Tamanhos (= os de hoje): `sm` 32 px (StatCard), `md` 36 px (DialogHeader), `lg` 44 px (PageHeader), `xl` 48 px (EmptyState).
 * Tons: `primary` (padrão), `muted`, `lime` e `onDark` (os dois últimos para uso sobre `.surface-dark`).
 */
const SIZE = {
  sm: { box: "h-8 w-8 rounded-lg", icon: "h-4 w-4" },
  md: { box: "h-9 w-9 rounded-xl", icon: "h-4 w-4" },
  lg: { box: "h-11 w-11 rounded-2xl", icon: "h-5 w-5" },
  xl: { box: "h-12 w-12 rounded-2xl", icon: "h-6 w-6" },
} as const

const TONE = {
  primary: "bg-primary/10 text-primary",
  muted: "bg-muted text-ink-subtle",
  lime: "bg-lime/15 text-lime ring-1 ring-lime/25",
  onDark: "bg-white/10 text-white ring-1 ring-white/15",
} as const

export function IconBadge({
  icon: Icon,
  size = "md",
  tone = "primary",
  tinted = false,
  className,
}: {
  icon: LucideIcon
  size?: keyof typeof SIZE
  tone?: keyof typeof TONE
  /** Sombra tingida da marca (selos de cabeçalho). */
  tinted?: boolean
  className?: string
}) {
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center", SIZE[size].box, TONE[tone], tinted && "shadow-tinted", className)}
      aria-hidden="true"
    >
      <Icon className={SIZE[size].icon} />
    </span>
  )
}
