import { create } from "zustand"
import type { LatLng } from "@/lib/geo"

/**
 * Posição do motorista — SÓ EM MEMÓRIA, de propósito. Sem `persist`, sem
 * localStorage, sem URL, sem cache do TanStack persistido, nada no service
 * worker (`/api/**` já é NetworkOnly): recarregar a página esquece a posição
 * e, se a permissão já estiver `granted`, o app pergunta de novo ao aparelho
 * em silêncio (LGPD — `decisoes-mapa-eletropostos.md` item 4). Store global
 * (e não estado de componente) só pra Home e Mapa compartilharem a mesma
 * posição sem pedir de novo ao navegar entre elas.
 */
export type GeoStatus = "idle" | "requesting" | "granted" | "denied" | "unavailable" | "timeout"

/** 10 s de timeout, sem GPS de alta precisão (bateria; basta saber o bairro), aceita posição de até 60 s atrás. */
export const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }

interface GeoState {
  status: GeoStatus
  position: LatLng | null
  /** Já checamos se a permissão estava `granted` (só tentamos o pedido automático uma vez por sessão). */
  autoChecked: boolean
  /** Pede ao aparelho — SÓ chamar por ação do usuário (botão) ou pelo caminho automático já autorizado. */
  request: () => void
  /** Pedido automático APENAS se `navigator.permissions` já disser `granted` (não abre prompt do navegador sozinho). */
  autoRequestIfGranted: () => Promise<void>
  reset: () => void
}

export const useGeoStore = create<GeoState>((set, get) => ({
  status: "idle",
  position: null,
  autoChecked: false,

  request: () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      set({ status: "unavailable" })
      return
    }
    set({ status: "requesting" })
    navigator.geolocation.getCurrentPosition(
      (pos) => set({ status: "granted", position: { lat: pos.coords.latitude, lng: pos.coords.longitude } }),
      (err) => {
        // PERMISSION_DENIED = 1, POSITION_UNAVAILABLE = 2, TIMEOUT = 3.
        if (err.code === 1) set({ status: "denied", position: null }) // permissão revogada: esquece a posição antiga
        else set({ status: err.code === 3 ? "timeout" : "unavailable" })
      },
      GEO_OPTIONS,
    )
  },

  autoRequestIfGranted: async () => {
    if (get().autoChecked) return
    set({ autoChecked: true })
    try {
      const permission = await navigator.permissions?.query({ name: "geolocation" as PermissionName })
      if (permission?.state === "granted") get().request()
    } catch {
      // Permissions API ausente/recusada (Safari antigo): sem pedido automático — o botão continua disponível.
    }
  },

  reset: () => set({ status: "idle", position: null, autoChecked: false }),
}))
