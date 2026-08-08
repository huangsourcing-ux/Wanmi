import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

const moneyMinorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const orderCreateRequestSchema = z.strictObject({
  quoteRef: z.string().uuid(),
  realnameTemplateId: z.number().int().positive(),
})

export const publicOrderSchema = z.strictObject({
  amountMinor: moneyMinorSchema,
  currency: z.literal('CNY'),
  domainAscii: z.string().min(1).max(253),
  orderNumber: z.string().min(1).max(80),
  quoteExpiresAt: z.iso.datetime(),
  quoteRef: z.string().uuid(),
  status: z.literal('pending_payment'),
  years: z.number().int().min(1).max(10),
})

export const orderCreationResultSchema = createResultSchema(publicOrderSchema)

export type OrderCreateRequest = z.infer<typeof orderCreateRequestSchema>
export type OrderCreationResult = z.infer<typeof orderCreationResultSchema>
export type PublicOrder = z.infer<typeof publicOrderSchema>
