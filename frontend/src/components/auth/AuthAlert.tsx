import { useEffect, useRef, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { cn } from "@/lib/utils"

/**
 * Aviso das telas de acesso que leva o FOCO ao aparecer. O aviso entra no DOM depois de uma ação (envio com erro, "senha alterada" ao chegar no login) e quem usa teclado
 * ou leitor de tela precisa estar nele; `role="alert"` (erro, anunciado na hora) ou `role="status"` (informativo). Quem quiser refocar o MESMO aviso numa nova tentativa
 * remonta com outra `key`. Sem o anel de foco global: o foco aqui é PROGRAMÁTICO, num bloco que não é controle (o anel de `:focus-visible` apareceria em volta do aviso/título toda vez que a
 * tela abre, sem nenhum Tab). Quem usa o teclado segue de onde o foco está; os controles mantêm o anel.
 */
export function AuthAlert({
  tone,
  icon,
  role,
  className,
  children,
}: {
  tone: "danger" | "success" | "info" | "warning"
  icon: LucideIcon
  role: "alert" | "status"
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <Alert ref={ref} tone={tone} icon={icon} role={role} tabIndex={-1} className={cn("outline-none focus-visible:ring-0 focus-visible:ring-offset-0", className)}>
      {children}
    </Alert>
  )
}
