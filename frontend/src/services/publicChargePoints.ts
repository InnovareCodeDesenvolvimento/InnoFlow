import { api } from "./api"
import type { PublicChargePointCard } from "@/types/api"

/** `GET /api/public/charge-points/:ocppIdentity` — sem auth, é a tela pós-QR. */
export const publicChargePointsService = {
  async get(ocppIdentity: string): Promise<PublicChargePointCard> {
    const { data } = await api.get<PublicChargePointCard>(`/api/public/charge-points/${encodeURIComponent(ocppIdentity)}`)
    return data
  },
}
