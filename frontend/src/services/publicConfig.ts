import { api } from "./api"
import type { PublicClientConfig } from "@/types/api"

export const publicConfigService = {
  /** `GET /api/public/config` — sem auth. `googleClientId: null` = login com Google desligado neste ambiente. */
  async get(): Promise<PublicClientConfig> {
    const { data } = await api.get<PublicClientConfig>("/api/public/config")
    return data
  },
}
