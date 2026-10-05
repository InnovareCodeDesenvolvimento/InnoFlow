import { useId, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card"
import { IconBadge } from "@/components/ui/IconBadge"

/**
 * Moldura de UMA seção da tela de perfil: card claro com selo de ícone, título (h2, logo abaixo do h1 da página) e descrição curta. A tela de perfil é só uma
 * pilha dessas seções - nova seção (preferências, privacidade...) é um novo `<ProfileSection>` na pilha de `pages/App/Perfil.tsx`, sem mexer nas existentes.
 * A `<section>` é nomeada pelo título (`aria-labelledby`), o que dá ao leitor de tela uma região por seção.
 */
export function ProfileSection({
  icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: string
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId}>
      <Card>
        <CardHeader className="flex items-start gap-3">
          <IconBadge icon={icon} size="lg" />
          <div className="min-w-0 flex-1">
            <CardTitle as="h2" id={titleId}>
              {title}
            </CardTitle>
            {description && <p className="mt-0.5 text-sm text-ink-softer">{description}</p>}
          </div>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  )
}
