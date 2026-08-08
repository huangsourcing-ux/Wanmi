import type { PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import { MockWestDigitalProvider } from '@/providers/westdigital'

import { transitionOrder } from './order-state'

export type FulfillmentInput = {
  operationKey: string
  orderId: number
  simulate?: 'success' | 'timeout-after-submit' | 'timeout-before-submit'
  traceId: string
}

export async function runMockFulfillment(req: PayloadRequest, input: FulfillmentInput) {
  const existing = await req.payload.find({
    collection: 'providerOperations',
    limit: 1,
    overrideAccess: true,
    req,
    where: { operationKey: { equals: input.operationKey } },
  })
  const recorded = existing.docs[0]

  if (recorded?.status === 'succeeded') {
    return { idempotentReplay: true, operationId: recorded.id, status: 'succeeded' as const }
  }
  if (recorded && ['submitted', 'unknown'].includes(recorded.status)) {
    return { idempotentReplay: true, operationId: recorded.id, status: recorded.status }
  }

  const operation =
    recorded ??
    (await req.payload.create({
      collection: 'providerOperations',
      data: {
        attemptCount: 0,
        maxAttempts: 3,
        operation: 'register',
        operationKey: input.operationKey,
        order: input.orderId,
        provider: 'westdigital',
        status: 'prepared',
        targetId: String(input.orderId),
        targetType: 'order',
      },
      overrideAccess: true,
      req,
    }))

  const order = await req.payload.findByID({
    collection: 'orders',
    id: input.orderId,
    overrideAccess: true,
    req,
  })
  if (order.status === 'paid') {
    await transitionOrder(req, order.id, 'fulfilling', {
      actorType: 'system',
      evidence: { operationKey: input.operationKey },
      reasonCode: 'COMMERCE_JOB_ACCEPTED',
    })
  } else if (order.status !== 'fulfilling') {
    throw new AppError('ORDER_NOT_FULFILLABLE', '订单当前状态不能履约', 409)
  }

  if (input.simulate === 'timeout-before-submit') {
    throw new AppError('PROVIDER_NOT_SUBMITTED', '服务商请求确认未提交，可以按业务键安全重试', 503)
  }

  const provider = new MockWestDigitalProvider()
  const submitted = await provider.submitOperation({
    operationKey: input.operationKey,
    traceId: input.traceId,
  })
  if (!submitted.ok) throw new AppError('PROVIDER_SUBMIT_FAILED', '服务商请求未提交', 503)

  await req.payload.update({
    collection: 'providerOperations',
    id: operation.id,
    data: {
      providerRequestId: submitted.data.providerRequestId,
      status: input.simulate === 'timeout-after-submit' ? 'unknown' : 'submitted',
      submittedAt: submitted.observedAt,
    },
    overrideAccess: true,
    req,
  })

  if (input.simulate === 'timeout-after-submit') {
    await transitionOrder(req, order.id, 'manual_review', {
      actorType: 'system',
      evidence: {
        operationKey: input.operationKey,
        providerRequestId: submitted.data.providerRequestId,
      },
      note: '写请求已发出但响应结果不明；只允许后续查询，禁止自动重提。',
      reasonCode: 'PROVIDER_STATUS_UNKNOWN',
    })
    return { idempotentReplay: false, operationId: operation.id, status: 'unknown' as const }
  }

  await req.payload.update({
    collection: 'providerOperations',
    id: operation.id,
    data: {
      lastCheckedAt: new Date().toISOString(),
      safeResult: { registered: true },
      status: 'succeeded',
    },
    overrideAccess: true,
    req,
  })
  const assets = await req.payload.find({
    collection: 'domainAssets',
    limit: 1,
    overrideAccess: true,
    req,
    where: { domainAscii: { equals: order.domainAscii } },
  })
  if (!assets.docs[0]) {
    const now = new Date()
    await req.payload.create({
      collection: 'domainAssets',
      data: {
        customer: typeof order.customer === 'object' ? order.customer.id : order.customer,
        domainAscii: order.domainAscii,
        expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
        lastSyncedAt: now.toISOString(),
        nameservers: ['ns1.mock.invalid', 'ns2.mock.invalid'],
        realnameTemplate:
          typeof order.realnameTemplate === 'object'
            ? order.realnameTemplate.id
            : order.realnameTemplate,
        registeredAt: now.toISOString(),
        registrar: 'westdigital-mock',
        status: 'active',
      },
      overrideAccess: true,
      req,
    })
  }
  await transitionOrder(req, order.id, 'succeeded', {
    actorType: 'provider',
    evidence: { operationKey: input.operationKey, registered: true },
    reasonCode: 'PROVIDER_CONFIRMED_SUCCESS',
  })
  return { idempotentReplay: false, operationId: operation.id, status: 'succeeded' as const }
}
