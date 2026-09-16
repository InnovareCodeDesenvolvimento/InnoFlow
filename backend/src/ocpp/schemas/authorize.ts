import { z } from 'zod'
import { idTagSchema } from './common'

export const authorizeReqSchema = z.object({
  idTag: idTagSchema,
})

export type AuthorizeReq = z.infer<typeof authorizeReqSchema>
