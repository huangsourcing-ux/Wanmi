import { z } from 'zod'
import { ORDER_STATUSES } from '@/lib/domain'
import { createResultSchema } from '@/schemas/api'

const moneyMinorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const paymentCreateRequestSchema = z.strictObject({
  channel: z.enum(['native', 'h5', 'balance']),
})

export const paymentSessionSchema = z.discriminatedUnion('channel', [
  z.strictObject({
    channel: z.literal('native'),
    codeUrl: z.string().startsWith('weixin://'),
    expiresAt: z.iso.datetime({ offset: true }),
    merchantOrderNumber: z.string().min(1).max(32),
  }),
  z.strictObject({
    channel: z.literal('h5'),
    expiresAt: z.iso.datetime({ offset: true }),
    h5Url: z.url(),
    merchantOrderNumber: z.string().min(1).max(32),
  }),
  z.strictObject({
    amountMinor: moneyMinorSchema,
    channel: z.literal('balance'),
    currency: z.literal('CNY'),
    orderNumber: z.string().min(1).max(80),
    status: z.literal('paid'),
  }),
])

export const paymentSessionResultSchema = createResultSchema(paymentSessionSchema)

export const paymentStatusSchema = z.strictObject({
  amountMinor: moneyMinorSchema,
  currency: z.literal('CNY'),
  orderNumber: z.string().min(1).max(80),
  status: z.enum(ORDER_STATUSES),
})

export const paymentStatusResultSchema = createResultSchema(paymentStatusSchema)

export type PaymentCreateRequest = z.infer<typeof paymentCreateRequestSchema>
export type PaymentSessionResult = z.infer<typeof paymentSessionResultSchema>
export type PaymentStatusResult = z.infer<typeof paymentStatusResultSchema>
