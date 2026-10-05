import { cva } from "class-variance-authority"

/**
 * Variantes do Card (design system unificado):
 *  - `surface`  padrão: o card claro de sempre (`.card-elevated`). A sombra tingida da marca (o "premium" de 17/09) entra por tela até a F-D.
 *  - `inverse`  MOMENTO DE MARCA: degradê petróleo, texto claro e escopo `.surface-dark` (os filhos trocam de tom sozinhos). No máximo UM por tela,
 *               sempre o elemento mais importante dela (saldo, recarga ao vivo, cabeçalho do recibo, KPI-herói).
 *  - `glass`    vidro translúcido — só DENTRO de uma superfície escura.
 *  - `outline`  tracejado — só para "drop zone"; estado vazio NÃO é tracejado (use `EmptyState tone="quiet"`).
 * `className` ganha de qualquer um deles (as classes de DS estão em `@layer components`).
 */
export const cardVariants = cva("", {
  variants: {
    variant: {
      surface: "card-elevated",
      inverse: "surface-dark relative overflow-hidden rounded-card bg-gradient-to-br from-primary-950 to-primary-800 shadow-tinted-card ring-1 ring-white/10",
      glass: "glass rounded-card",
      outline: "rounded-card border border-dashed border-border-strong bg-muted/30",
    },
  },
  defaultVariants: { variant: "surface" },
})
