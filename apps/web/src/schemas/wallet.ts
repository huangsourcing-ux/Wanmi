import { z } from 'zod'

import { WALLET_TOP_UP_STATUSES } from '@/collections/wallet'
import { createResultSchema } from '@/schemas/api'

const positiveFenSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const walletTopUpCreateRequestSchema = z.strictObject({
  amountFen: positiveFenSchema,
  fundingSource: z.literal('wechat'),
})

export const walletTopUpOrderSchema = z.strictObject({
  amountFen: positiveFenSchema,
  currency: z.literal('CNY'),
  status: z.enum(WALLET_TOP_UP_STATUSES),
  topUpOrderNumber: z.string().min(1).max(32),
})

export const walletTopUpOrderResultSchema = createResultSchema(walletTopUpOrderSchema)

export type WalletTopUpCreateRequest = z.infer<typeof walletTopUpCreateRequestSchema>
export type WalletTopUpOrderResult = z.infer<typeof walletTopUpOrderResultSchema>
