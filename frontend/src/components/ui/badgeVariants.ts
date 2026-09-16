import { cva } from "class-variance-authority"

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide",
  {
    variants: {
      variant: {
        neutral: "bg-muted text-muted-foreground",
        primary: "bg-primary/10 text-primary-700",
        success: "bg-success-100 text-success-700",
        warning: "bg-warning-100 text-warning-700",
        danger: "bg-danger-100 text-danger-700",
        info: "bg-info-100 text-info-700",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
)
