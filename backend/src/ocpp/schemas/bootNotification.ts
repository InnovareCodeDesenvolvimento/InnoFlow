import { z } from 'zod'

export const bootNotificationReqSchema = z.object({
  chargePointVendor: z.string().min(1).max(20),
  chargePointModel: z.string().min(1).max(20),
  chargePointSerialNumber: z.string().max(25).optional(),
  chargeBoxSerialNumber: z.string().max(25).optional(),
  firmwareVersion: z.string().max(50).optional(),
  iccid: z.string().max(20).optional(),
  imsi: z.string().max(20).optional(),
  meterType: z.string().max(25).optional(),
  meterSerialNumber: z.string().max(25).optional(),
})

export type BootNotificationReq = z.infer<typeof bootNotificationReqSchema>
