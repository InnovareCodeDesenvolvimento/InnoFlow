import type { ComponentPropsWithoutRef } from "react"
import { cn } from "@/lib/utils"

/** Trecho de código/identificador no meio do texto (variável de ambiente, comando). Quebra em qualquer ponto para nunca estourar a largura a 375 px. */
export function InlineCode({ className, ...props }: ComponentPropsWithoutRef<"code">) {
  return <code className={cn("break-all rounded bg-muted px-1 py-0.5 text-xs text-ink", className)} {...props} />
}
