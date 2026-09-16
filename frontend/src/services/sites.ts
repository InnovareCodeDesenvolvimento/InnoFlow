import { api } from "./api"
import type {
  CreateSiteInput,
  PaginatedResponse,
  PaginationParams,
  PublicSite,
  PublicSitesQuery,
  Site,
  UpdateSiteInput,
} from "@/types/api"

export const sitesService = {
  // ---- Público (GET /api/sites, sem auth) ----------------------------------
  async listPublic(params: PublicSitesQuery = {}): Promise<PaginatedResponse<PublicSite>> {
    const { data } = await api.get<PaginatedResponse<PublicSite>>("/api/sites", { params })
    return data
  },

  // ---- Admin (GET/POST/PATCH/DELETE /api/admin/sites) ----------------------
  async list(params: PaginationParams = {}): Promise<PaginatedResponse<Site>> {
    const { data } = await api.get<PaginatedResponse<Site>>("/api/admin/sites", { params })
    return data
  },

  async get(id: string): Promise<Site> {
    const { data } = await api.get<Site>(`/api/admin/sites/${id}`)
    return data
  },

  async create(payload: CreateSiteInput): Promise<Site> {
    const { data } = await api.post<Site>("/api/admin/sites", payload)
    return data
  },

  async update(id: string, payload: UpdateSiteInput): Promise<Site> {
    const { data } = await api.patch<Site>(`/api/admin/sites/${id}`, payload)
    return data
  },

  /** Soft delete (`active: false`) — o backend devolve 204 sem corpo. */
  async remove(id: string): Promise<void> {
    await api.delete(`/api/admin/sites/${id}`)
  },
}
