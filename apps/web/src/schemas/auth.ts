import { z } from 'zod'

export const smsRequestSchema = z.object({
  deviceId: z.string().min(16).max(128),
  phone: z.string().trim().min(11).max(16),
})

export const smsVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  deviceId: z.string().min(16).max(128),
})

export const logoutSchema = z.object({
  scope: z.enum(['current', 'all']).default('current'),
})

export type SmsRequestInput = z.infer<typeof smsRequestSchema>
export type SmsVerifyInput = z.infer<typeof smsVerifySchema>
