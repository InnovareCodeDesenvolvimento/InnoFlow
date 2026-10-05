import { api } from "./api"
import type {
  BackupConfigDTO,
  BackupGoogleStartResponse,
  BackupRunDTO,
  BackupRunsResponse,
  BackupStatusDTO,
  BackupTestDestinationResponse,
  GenerateBackupKeyRequest,
  GeneratedBackupKeyResponse,
  UpdateBackupConfigRequest,
} from "@/types/api"

const BASE = "/api/admin/backup"

/**
 * `/api/admin/backup` — backup automático do banco (Admin > Backups). ADMIN-only (403 `FORBIDDEN` para OPERATOR). Contrato literal: `docs/CONTRATO-BACKUP-ADMIN.md`.
 * Segredos (chave de acesso/segredo do bucket, Client Secret do Google) e a chave do backup são só de escrita: o GET devolve só os `*Set`/impressão digital.
 * Erros por `code`: ver `parseBackupError` em `lib/backup.ts`. Os POSTs sem corpo mandam `{}` (o schema do servidor é `.strict()`).
 */
export const backupService = {
  async getConfig(): Promise<BackupConfigDTO> {
    const { data } = await api.get<BackupConfigDTO>(`${BASE}/config`)
    return data
  },

  /** Só o que mudou (campo ausente = "não mexer"). Devolve o DTO já atualizado. Step-up (`currentPassword`) conforme `exigeSenha` em `lib/backup.ts`. */
  async updateConfig(payload: UpdateBackupConfigRequest): Promise<BackupConfigDTO> {
    const { data } = await api.put<BackupConfigDTO>(`${BASE}/config`, payload)
    return data
  },

  async getStatus(): Promise<BackupStatusDTO> {
    const { data } = await api.get<BackupStatusDTO>(`${BASE}/status`)
    return data
  },

  /** 201. A chave inteira só vem AQUI, uma vez: quem chama é responsável por não guardá-la em lugar nenhum além do estado local da tela. */
  async generateKey(payload: GenerateBackupKeyRequest): Promise<GeneratedBackupKeyResponse> {
    const { data } = await api.post<GeneratedBackupKeyResponse>(`${BASE}/key`, payload)
    return data
  },

  /** 202 com a execução em `QUEUED`: acompanhe com `getRun`/`getStatus`. */
  async run(): Promise<BackupRunDTO> {
    const { data } = await api.post<BackupRunDTO>(`${BASE}/run`, {})
    return data
  },

  /** 202, idem `run`. */
  async verify(): Promise<BackupRunDTO> {
    const { data } = await api.post<BackupRunDTO>(`${BASE}/verify`, {})
    return data
  },

  /** SEMPRE 200 com o RESULTADO (`ok: false` não é erro da rota). Usa a configuração SALVA. */
  async testDestination(): Promise<BackupTestDestinationResponse> {
    const { data } = await api.post<BackupTestDestinationResponse>(`${BASE}/test-destination`, {})
    return data
  },

  async listRuns(params: { page: number; pageSize: number }): Promise<BackupRunsResponse> {
    const { data } = await api.get<BackupRunsResponse>(`${BASE}/runs`, { params })
    return data
  },

  async getRun(id: string): Promise<BackupRunDTO> {
    const { data } = await api.get<BackupRunDTO>(`${BASE}/runs/${encodeURIComponent(id)}`)
    return data
  },

  async googleStart(payload: { currentPassword: string }): Promise<BackupGoogleStartResponse> {
    const { data } = await api.post<BackupGoogleStartResponse>(`${BASE}/google/start`, payload)
    return data
  },

  async googleDisconnect(payload: { currentPassword: string }): Promise<BackupConfigDTO> {
    const { data } = await api.post<BackupConfigDTO>(`${BASE}/google/disconnect`, payload)
    return data
  },
}
