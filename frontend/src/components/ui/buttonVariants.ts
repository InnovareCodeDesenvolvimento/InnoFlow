import { cva } from "class-variance-authority"

/**
 * Variantes do botão (design system unificado, decisão D2 do dono):
 *  - `lime`    CTA ÚNICO da tela (no máximo um por tela). Fundo lima, texto noite (~10:1). Só vale sobre claro ou escuro, mas NUNCA
 *              como estado ("sucesso" continua verde `accent-600`). Sem a varredura de brilho em loop da landing.
 *  - `primary` salvar/confirmar em formulário e diálogo (petróleo, com sombra tingida). `default` é igual a `primary` desde a F-D (era o petróleo sem a
 *              sombra tingida; os 100+ usos sem variante migraram juntos).
 *  - `glass`   secundário SOBRE superfície escura (`.surface-dark`).
 *  - `accent` (verde AA com texto branco), `outline`, `ghost`, `destructive`, `link`: como antes.
 * Hover sobe 1 px só com ponteiro (`hover: hover`) e o toque encolhe (`active:scale`) — feedback tátil, não efeito.
 */
// O raio mora em CADA variante (não na base): `buttonVariants()` é usado direto em <Link> (sem tailwind-merge), então base + variante com raios arbitrários diferentes
// competiriam pela ordem do CSS — e o `lime`/`glass` (raio de controle 14 px) perdia para o da base. `--field-radius` = `--radius-control` (14 px) no app inteiro desde a F-D (antes: 12 px fora do PWA).
const lift = "[@media(hover:hover)]:hover:-translate-y-px active:scale-[0.97]"
const motion = "transition-[transform,box-shadow,background-color,border-color,color] duration-150 ease-brand"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        // `default` = `primary` (F-D): salvar/confirmar em petróleo com sombra tingida. As ~100 telas/diálogos do Admin que usam `<Button>` sem variante migram sozinhas.
        default: `rounded-[var(--field-radius)] bg-primary text-primary-foreground hover:bg-primary-700 shadow-tinted ${motion} ${lift}`,
        primary: `rounded-[var(--field-radius)] bg-primary text-primary-foreground hover:bg-primary-700 shadow-tinted ${motion} ${lift}`,
        lime: `rounded-[var(--radius-control)] bg-lime text-on-lime shadow-lime hover:shadow-lime-lg ${motion} ${lift} [@media(hover:hover)]:hover:-translate-y-0.5`,
        glass: `rounded-[var(--radius-control)] border border-white/25 bg-white/10 text-white hover:bg-white/15 ${motion} ${lift}`,
        accent: "rounded-[var(--field-radius)] bg-accent text-accent-foreground hover:bg-accent-700 shadow-sm",
        outline: "rounded-[var(--field-radius)] border border-border bg-surface text-ink hover:bg-muted",
        ghost: "rounded-[var(--field-radius)] text-ink-soft hover:bg-muted hover:text-ink",
        destructive: "rounded-[var(--field-radius)] bg-danger text-white hover:bg-danger-700 shadow-sm",
        link: "rounded-[var(--field-radius)] text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        md: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "h-9 w-9 shrink-0",
        // Alvo de toque: 44 px abaixo de `sm` (640), o tamanho normal do Admin de `sm` para cima. `touch` = `default`, `touch-sm` = `sm`, `field` = ao lado de um `Input` (mesma altura do campo: 46 px com fonte 16, 42 com 14).
        touch: "h-11 px-4 py-2 sm:h-10",
        "touch-sm": "h-11 px-3 text-xs sm:h-8",
        field: "h-[2.875rem] px-4 py-2 sm:h-[2.625rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
