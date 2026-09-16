import { cn } from "@/lib/utils"

type CardProps = React.HTMLAttributes<HTMLDivElement>

function Card({ className, ...props }: CardProps) {
  return <div className={cn("card-elevated", className)} {...props} />
}

function CardHeader({ className, ...props }: CardProps) {
  return <div className={cn("p-5 pb-3 sm:p-6 sm:pb-3", className)} {...props} />
}

function CardTitle({ className, ...props }: CardProps) {
  return <h3 className={cn("text-base font-bold text-ink", className)} {...props} />
}

function CardDescription({ className, ...props }: CardProps) {
  return <p className={cn("mt-1 text-sm text-ink-softer", className)} {...props} />
}

function CardContent({ className, ...props }: CardProps) {
  return <div className={cn("p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />
}

function CardFooter({ className, ...props }: CardProps) {
  return <div className={cn("flex items-center gap-2 p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
