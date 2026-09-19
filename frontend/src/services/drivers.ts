import { api } from "./api"
import type {
  DriversListQuery,
  DriversListResponse,
  DriverWalletQuery,
  DriverWalletResponse,
  WalletAdjustmentRequest,
  WalletEntryRow,
} from "@/types/api"

/**
 * `GET/POST /api/admin/drivers*` — motorista é conta de REDE (sem `operatorId`).
 * OPERATOR e ADMIN listam e consultam extrato; só ADMIN ajusta saldo.
 */
export const driversService = {
  /** OPERATOR: `search` com ≥ 3 caracteres é obrigatório (400 `VALIDATION_ERROR` sem isso). `email` só vem para ADMIN. */
  async list(params: DriversListQuery): Promise<DriversListResponse> {
    const { data } = await api.get<DriversListResponse>("/api/admin/drivers", { params })
    return data
  },

  /** Extrato paginado. Abrir o extrato de UM motorista é auditado no backend (`forceAudit`). */
  async wallet(driverId: string, params: DriverWalletQuery): Promise<DriverWalletResponse> {
    const { data } = await api.get<DriverWalletResponse>(`/api/admin/drivers/${driverId}/wallet`, { params })
    return data
  },

  /** ADMIN ONLY. 201 com o lançamento criado; 409 `INSUFFICIENT_BALANCE` se o débito passar do saldo. */
  async adjust(driverId: string, payload: WalletAdjustmentRequest): Promise<WalletEntryRow> {
    const { data } = await api.post<WalletEntryRow>(`/api/admin/drivers/${driverId}/wallet/entries`, payload)
    return data
  },
}
