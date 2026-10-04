import { cva } from "class-variance-authority"

/**
 * Variantes do botão (design system unificado, decisão D2 do dono):
 *  - `lime`    CTA ÚNICO da tela (no máximo um por tela). Fundo lima, texto noite (~10:1). Só vale sobre claro ou escuro, mas NUNCA
 *              como estado ("sucesso" continua verde `accent-600`). Sem a varredura de brilho em loop da landing.
 *  - `primary` salvar/confirmar em formulário e diálogo (petróleo, com sombra tingida). `default` é o MESMO petróleo sem a
 *              sombra tingida — mantido porque 100+ usos dependem dele (migrar por tela nas fases B–D).
 *  - `glass`   secundário SOBRE superfície escura (`.surface-dark`).
 *  - `accent` (verde AA com texto branco), `outline`, `ghost`, `destructive`, `link`: como antes.
 * Hover sobe 1 px só com ponteiro (`hover: hover`) e o toque encolhe (`active:scale`) — feedback tátil, não efeito.
 */
const lift = "[@media(hover:hover)]:hover:-translate-y-px active:scale-[0.97]"
const motion = "transition-[transform,box-shadow,background-color,border-color,color] duration-150 ease-brand"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-700 shadow-sm",
        primary: `bg-primary text-primary-foreground hover:bg-primary-700 shadow-tinted ${motion} ${lift}`,
        lime: `rounded-[var(--radius-control)] bg-lime text-on-lime shadow-lime hover:shadow-lime-lg ${motion} ${lift} [@media(hover:hover)]:hover:-translate-y-0.5`,
        glass: `rounded-[var(--radius-control)] border border-white/25 bg-white/10 text-white hover:bg-white/15 ${motion} ${lift}`,
        accent: "bg-accent text-accent-foreground hover:bg-accent-700 shadow-sm",
        outline: "border border-border bg-surface text-ink hover:bg-muted",
        ghost: "text-ink-soft hover:bg-muted hover:text-ink",
        destructive: "bg-danger text-white hover:bg-danger-700 shadow-sm",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        md: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "h-9 w-9 shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
