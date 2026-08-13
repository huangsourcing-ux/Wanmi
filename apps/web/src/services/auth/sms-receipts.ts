import type { PayloadRequest } from 'payload'

import { getEnv } from '@/lib/env'
import { createSmsProvider } from '@/providers/aliyunsms'
import type { SmsProvider } from '@/providers/types'

const RECEIPT_BATCH_SIZE = 50
const RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

function safeProviderCode(code: string | undefined): string | undefined {
  if (!code) return undefined
  const normalized = code.trim().toUpperCase()
  return /^[A-Z0-9._-]{1,80}$/u.test(normalized) ? normalized : 'UNKNOWN'
}

export async function reconcileSmsReceipts(
  req: PayloadRequest,
  options: { fixtureProvider?: SmsProvider } = {},
): Promise<{
  checked: number
  delivered: number
  expiredRateBucketsDeleted: number
  failed: number
}> {
  const now = new Date()
  const expiredRateBuckets = await req.payload.delete({
    collection: 'smsRateLimits',
    overrideAccess: true,
    req,
    where: { expiresAt: { less_than: now.toISOString() } },
  })
  if (getEnv().ALIYUN_SMS_MODE !== 'live' && !options.fixtureProvider) {
    return {
      checked: 0,
      delivered: 0,
      expiredRateBucketsDeleted: expiredRateBuckets.docs.length,
      failed: 0,
    }
  }
  const candidates = await req.payload.find({
    collection: 'smsChallenges',
    depth: 0,
    limit: RECEIPT_BATCH_SIZE,
    overrideAccess: true,
    req,
    sort: 'sentAt',
    where: {
      and: [
        { deliveryStatus: { in: ['accepted', 'pending', 'unknown'] } },
        { providerMessageId: { exists: true } },
        { sentAt: { greater_than: new Date(now.getTime() - RECEIPT_MAX_AGE_MS).toISOString() } },
      ],
    },
  })
  const provider = options.fixtureProvider ?? createSmsProvider()
  let checked = 0
  let delivered = 0
  let failed = 0
  for (const challenge of candidates.docs) {
    if (!challenge.providerMessageId || !challenge.sentAt) continue
    const result = await provider.queryReceipt({
      phone: challenge.phone,
      providerMessageId: challenge.providerMessageId,
      sentAt: challenge.sentAt,
      traceId: `sms-receipt-${challenge.id}`,
    })
    checked += 1
    if (!result.ok) {
      await req.payload.update({
        collection: 'smsChallenges',
        data: { deliveryStatus: 'unknown', receiptCheckedAt: now.toISOString() },
        id: challenge.id,
        overrideAccess: true,
        req,
      })
      continue
    }
    if (result.data.status === 'delivered') delivered += 1
    if (result.data.status === 'failed') failed += 1
    await req.payload.update({
      collection: 'smsChallenges',
      data: {
        deliveryFailureCategory: result.data.failureCategory,
        deliveryProviderCode: safeProviderCode(result.data.providerCode),
        deliveryStatus: result.data.status,
        receiptCheckedAt: now.toISOString(),
        receiptRequestId: result.requestId,
      },
      id: challenge.id,
      overrideAccess: true,
      req,
    })
  }
  return {
    checked,
    delivered,
    expiredRateBucketsDeleted: expiredRateBuckets.docs.length,
    failed,
  }
}
