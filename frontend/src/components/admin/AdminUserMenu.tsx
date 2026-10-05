import { Route } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/DropdownMenu"

/**
 * Menu do usuário do Admin (rodapé da sidebar): o avatar e o nome viram o gatilho de um menu com "Rever tour". O gatilho tem EXATAMENTE a mesma caixa de antes (mesmas classes, nenhum
 * ícone novo), então a sidebar não muda um pixel — é o que mantém a regressão visual do Admin intacta. O botão "Sair" continua ao lado, fora do menu.
 * `onReplayTour` ausente = sem menu (usuário sem tour): volta a ser só avatar + nome.
 */
export function AdminUserMenu({
  name,
  subtitle,
  collapsed,
  onReplayTour,
}: {
  name: string | undefined
  subtitle: string
  collapsed: boolean
  onReplayTour: (() => void) | undefined
}) {
  const initial = (name ?? "A").charAt(0).toUpperCase()
  const avatarClass = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15 text-sm font-black text-white"

  if (!onReplayTour) {
    return collapsed ? (
      <div className={avatarClass} aria-hidden="true" title={name}>
        {initial}
      </div>
    ) : (
      <>
        <div className={avatarClass} aria-hidden="true">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-white">{name}</p>
          <p className="truncate text-[11px] text-white/70">{subtitle}</p>
        </div>
      </>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {collapsed ? (
          <button type="button" className={avatarClass} title={name} aria-label={`Menu do usuário: ${name ?? ""}`}>
            {initial}
          </button>
        ) : (
          <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left" aria-label={`Menu do usuário: ${name ?? ""}`}>
            <span className={avatarClass} aria-hidden="true">
              {initial}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-white">{name}</span>
              <span className="block truncate text-[11px] text-white/70">{subtitle}</span>
            </span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuLabel>Ajuda</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onReplayTour}>
          <Route className="h-4 w-4" aria-hidden="true" />
          Rever tour
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
