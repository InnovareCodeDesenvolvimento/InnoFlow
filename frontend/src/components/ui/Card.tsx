import { type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { cardVariants } from "./cardVariants"

type CardProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants>

function Card({ className, variant, ...props }: CardProps) {
  return <div className={cn(cardVariants({ variant }), className)} {...props} />
}

function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pb-3 sm:p-6 sm:pb-3", className)} {...props} />
}

/** `as`: nível do título. `h3` é o padrão (cards dentro de uma tela com seções); use `h2` quando o card é uma seção de 1º nível logo abaixo do h1 (evita pular de h1 para h3). */
function CardTitle({ className, as: Tag = "h3", ...props }: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" }) {
  return <Tag className={cn("text-base font-bold text-ink", className)} {...props} />
}

function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <p className={cn("mt-1 text-sm text-ink-softer", className)} {...props} />
}

function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />
}

function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
