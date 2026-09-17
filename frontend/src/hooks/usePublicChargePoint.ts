import { useQuery } from "@tanstack/react-query"
import { publicChargePointsService } from "@/services/publicChargePoints"

export const publicChargePointKeys = {
  detail: (ocppIdentity: string | undefined) => ["publicChargePoint", ocppIdentity] as const,
}

/**
 * `GET /api/public/charge-points/:ocppIdentity` — a tela pós-QR. Refetch
 * curto (15s): status do conector e disponibilidade podem mudar entre o
 * instante do scan e o toque em "Iniciar recarga" (outro motorista chegou
 * primeiro).
 */
export function usePublicChargePoint(ocppIdentity: string | undefined) {
  return useQuery({
    queryKey: publicChargePointKeys.detail(ocppIdentity),
    queryFn: () => publicChargePointsService.get(ocppIdentity as string),
    enabled: !!ocppIdentity,
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })
}
