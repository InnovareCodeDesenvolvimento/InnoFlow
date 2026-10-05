import { LocateFixed, Loader2, LocateOff } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { IconBadge } from "@/components/ui/IconBadge"
import type { GeoStatus } from "@/store/geoStore"

/** Mensagens claras em PT-BR pra cada estado que NÃO é sucesso — nunca bloqueia a tela por causa de permissão. */
const GEO_MESSAGES: Record<Exclude<GeoStatus, "idle" | "requesting" | "granted">, { title: string; hint: string }> = {
  denied: {
    title: "Localização bloqueada",
    hint: "Você negou o acesso. Para ver o mais próximo, libere a localização nas configurações do navegador — ou busque por cidade ou endereço abaixo.",
  },
  unavailable: {
    title: "Localização indisponível",
    hint: "Não conseguimos saber onde você está neste aparelho. Busque por cidade ou endereço abaixo.",
  },
  timeout: {
    title: "A localização demorou demais",
    hint: "Passaram 10 segundos sem resposta do aparelho. Tente de novo (ao ar livre costuma ser mais rápido) ou busque por cidade ou endereço.",
  },
}

/**
 * Convite/estado da geolocalização. O pedido ao aparelho SÓ acontece no clique
 * (`onRequest`) — nunca ao abrir a tela sozinho (exceto o caminho automático
 * já autorizado, tratado em `useGeolocation`). Sem permissão a lista funciona
 * igual (ordenada por nome, com busca): este componente é um convite, não um
 * portão.
 *
 * `compact`: uma linha só (usado depois que a posição já existe, pra atualizar).
 */
export function LocationPrompt({
  status,
  hasPosition,
  onRequest,
  compact = false,
}: {
  status: GeoStatus
  hasPosition: boolean
  onRequest: () => void
  compact?: boolean
}) {
  if (status === "requesting") {
    return (
      <div role="status" className="flex items-center gap-2.5 rounded-card bg-primary/5 px-4 py-3 text-sm font-semibold text-primary-700">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Obtendo sua localização…
      </div>
    )
  }

  if (status === "granted" && hasPosition) {
    if (!compact) return null
    return (
      <div className="flex items-center justify-between gap-3 text-xs text-ink-softer">
        <span className="flex items-center gap-1.5 font-semibold text-accent-700">
          <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
          Usando sua localização
        </span>
        <button type="button" onClick={onRequest} className="min-h-11 px-2 font-semibold text-primary hover:underline">
          Atualizar
        </button>
      </div>
    )
  }

  if (status === "denied" || status === "unavailable" || status === "timeout") {
    const msg = GEO_MESSAGES[status]
    return (
      <div role="alert" className="rounded-card border border-warning-100 bg-warning-50 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-warning-700">
          <LocateOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          {msg.title}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">{msg.hint}</p>
        {status !== "unavailable" && (
          <Button type="button" variant="outline" size="sm" className="mt-3 min-h-11" onClick={onRequest}>
            <LocateFixed className="h-4 w-4" aria-hidden="true" />
            Tentar de novo
          </Button>
        )}
      </div>
    )
  }

  // idle (ou granted sem posição, que não deveria acontecer): o convite.
  return (
    <div className="card-elevated p-4">
      <div className="flex items-start gap-3">
        <IconBadge icon={LocateFixed} size="lg" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">Veja o eletroposto mais próximo</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-softer">
            Sua posição exata fica só neste aparelho. Para buscar, enviamos apenas uma região aproximada (cerca de 11 km).
          </p>
        </div>
      </div>
      <Button type="button" variant="lime" className="mt-3 min-h-11 w-full" onClick={onRequest}>
        <LocateFixed className="h-4 w-4" aria-hidden="true" />
        Usar minha localização
      </Button>
    </div>
  )
}
