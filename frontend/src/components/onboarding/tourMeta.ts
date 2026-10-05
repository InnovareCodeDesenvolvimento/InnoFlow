import type { Role } from "@/types/api"

/**
 * O MÍNIMO que o shell precisa saber do tour para decidir se abre sozinho: qual tour é de quem e a versão atual de cada roteiro. Fica em arquivo PRÓPRIO e minúsculo porque o `TourProvider`
 * é carregado junto com o shell (PWA/Admin), enquanto os textos do roteiro (`tourScripts.ts`, vários KB) só descem com o chunk lazy do tour, quando ele realmente abre.
 * Subiu a versão de um roteiro? Mude AQUI (é a única fonte: `tourScripts.ts` lê daqui).
 */
export type TourId = "driver" | "admin" | "operator"

export const TOUR_VERSIONS: Record<TourId, number> = { driver: 1, admin: 1, operator: 1 }

/** Qual tour o papel tem. `undefined` = papel sem tour (visitante). */
export function tourIdForRole(role: Role | undefined): TourId | undefined {
  if (role === "DRIVER") return "driver"
  if (role === "ADMIN") return "admin"
  if (role === "OPERATOR") return "operator"
  return undefined
}
