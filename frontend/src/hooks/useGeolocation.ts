import { useEffect } from "react"
import { useGeoStore } from "@/store/geoStore"

/**
 * Geolocalização do motorista (ver `store/geoStore.ts` pras regras de
 * privacidade). O pedido ao aparelho é SEMPRE por ação do usuário (`request`,
 * ligado a um botão) — a única exceção é quando `navigator.permissions` já
 * diz `granted`: aí a posição vem sozinha, sem prompt, ao abrir a tela.
 */
export function useGeolocation() {
  const status = useGeoStore((s) => s.status)
  const position = useGeoStore((s) => s.position)
  const request = useGeoStore((s) => s.request)
  const autoRequestIfGranted = useGeoStore((s) => s.autoRequestIfGranted)

  useEffect(() => {
    void autoRequestIfGranted()
  }, [autoRequestIfGranted])

  return { status, position, request }
}
