import { cva } from "class-variance-authority"

/**
 * `onDark` = pílula de vidro para uso DENTRO de `.surface-dark`; `lime` = "ao vivo"/"novo" (texto noite sobre lima, ~10:1). Os estados
 * (`success`, `warning`, `danger`, `info`) NUNCA usam lima: "livre/sucesso" continua verde `accent-600` para não confundir com "ação".
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide",
  {
    variants: {
      variant: {
        neutral: "bg-muted text-muted-foreground",
        primary: "bg-primary/10 text-primary-700",
        success: "bg-success-100 text-success-700",
        warning: "bg-warning-100 text-warning-700",
        danger: "bg-danger-100 text-danger-700",
        info: "bg-info-100 text-info-700",
        onDark: "bg-white/10 text-white ring-1 ring-white/20",
        lime: "bg-lime text-on-lime",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
)
