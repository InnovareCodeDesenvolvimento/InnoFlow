import { z } from 'zod'

// Heartbeat.req não carrega payload de negócio — aceita objeto vazio (ou com
// campos extras desconhecidos, sem travar em cima de implementações que
// mandem algo a mais do que o spec exige).
export const heartbeatReqSchema = z.object({}).passthrough()

export type HeartbeatReq = z.infer<typeof heartbeatReqSchema>
