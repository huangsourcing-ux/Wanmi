import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hasAdminOperationScope, isCustomerUser } from '@/access/roles'
import { decryptSecret, hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { MarketingNotificationType, TransactionalNotificationType } from '@/lib/domain'
import { createSmsProvider } from '@/providers/aliyunsms'
import type { SmsProvider } from '@/providers/types'
import {
  createWechatOfficialProvider,
  type WechatOfficialProvider,
} from '@/providers/wechatofficial'
import { maskPhone } from '@/services/auth/client-facts'
import { activeCustomerIdentities, type IdentityRecord } from '@/services/auth/customer-identities'
import { sanitizeSensitiveData } from '@/services/privacy/sanitize-sensitive-data'

type NotificationDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type DeliveryRecord = {
  attemptCount: number
  channel: 'in_app' | 'sms' | 'wechat'
  claimedAt?: null | string
  customer: number | string | { id: number | string }
  deliveryKey: string
  id: number | string
  maxAttempts: number
  outboxEvent: number | string | { id: number | string }
  providerMessageId?: null | string
  recipientEncrypted?: null | string
  recipientIdentityHash: string
  recipientMasked: string
  status: 'dead_letter' | 'delivered' | 'pending' | 'retry_pending' | 'sending' | 'sent'
}

type OutboxRecord = {
  bodySnapshot: string
  category: 'marketing' | 'transactional'
  customer: number | string | { id: number | string }
  eventKey: string
  id: number | string
  notificationType: MarketingNotificationType | TransactionalNotificationType
  subjectSnapshot: string
  templateKey: string
  templateVersion: number
  traceId: string
}

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
}

function numericRelationId(value: number | string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('NOTIFICATION_RELATION_INVALID', '通知关联标识无效', 409)
  }
  return id
}

async function transaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const result = await work()
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}

async function database(req: PayloadRequest): Promise<NotificationDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as NotificationDatabase | undefined
  if (!current) {
    throw new AppError('NOTIFICATION_OUTBOX_CAS_UNAVAILABLE', '通知 outbox 暂时无法安全处理', 503)
  }
  return current
}

function assertImmutableSafeContent(subject: string, body: string): void {
  const sanitized = sanitizeSensitiveData({ body, subject })
  if (sanitized.body !== body || sanitized.subject !== subject) {
    throw new AppError(
      'NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN',
      '通知正文不得包含完整手机号、证件或凭据',
      400,
    )
  }
}

function customerIdentityKey(identity: IdentityRecord): string {
  return `${identity.provider}:${identity.providerInstanceId}:${identity.identifierHash}`
}

function recipientMask(identity: IdentityRecord): string {
  if (identity.provider === 'phone') {
    const env = getEnv()
    const identifier = decryptSecret(
      identity.identifierEncrypted,
      env.CUSTOMER_IDENTITY_ENCRYPTION_KEY ?? env.TOTP_ENCRYPTION_KEY,
    )
    return maskPhone(identifier)
  }
  return `wechat:${identity.identifierHash.slice(0, 8)}…`
}

async function createDelivery(
  req: PayloadRequest,
  input: {
    channel: 'in_app' | 'sms' | 'wechat'
    customerId: number | string
    deliveryKey: string
    identity?: IdentityRecord
    nextAttemptAt: string
    outboxEventId: number | string
  },
): Promise<void> {
  await req.payload.create({
    collection: 'notificationDeliveries',
    data: {
      attemptCount: 0,
      channel: input.channel,
      customer: numericRelationId(input.customerId),
      deliveryKey: input.deliveryKey,
      maxAttempts: 3,
      nextAttemptAt: input.nextAttemptAt,
      outboxEvent: numericRelationId(input.outboxEventId),
      recipientEncrypted: input.identity?.identifierEncrypted,
      recipientIdentityHash: input.identity
        ? input.identity.identifierHash
        : hmac(`in-app:${input.customerId}`, getEnv().SESSION_PEPPER),
      recipientMasked: input.identity ? recipientMask(input.identity) : '站内消息',
      status: 'pending',
    },
    overrideAccess: true,
    req,
  })
}

export async function enqueueTransactionalSecurityNotification(
  req: PayloadRequest,
  input: {
    body: string
    customerId: number
    domainEventType: string
    eventKey: string
    notificationType: TransactionalNotificationType
    subject: string
    templateKey: string
    templateVersion: number
    traceId: string
  },
): Promise<{ deliveryCount: number; outboxEventId: number | string }> {
  assertImmutableSafeContent(input.subject, input.body)
  return transaction(req, async () => {
    const identities = await activeCustomerIdentities(req, input.customerId)
    const outbox = await req.payload.create({
      collection: 'notificationOutboxEvents',
      data: {
        bodySnapshot: input.body,
        category: 'transactional',
        customer: input.customerId,
        domainEventType: input.domainEventType,
        eventKey: input.eventKey,
        messageHash: createHash('sha256')
          .update(`${input.templateKey}:${input.templateVersion}:${input.subject}:${input.body}`)
          .digest('hex'),
        notificationType: input.notificationType,
        subjectSnapshot: input.subject,
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
        traceId: input.traceId,
      },
      overrideAccess: true,
      req,
    })
    const now = new Date().toISOString()
    for (const identity of identities) {
      const channel = identity.provider === 'phone' ? 'sms' : 'wechat'
      await createDelivery(req, {
        channel,
        customerId: input.customerId,
        deliveryKey: `${input.eventKey}:${customerIdentityKey(identity)}`,
        identity,
        nextAttemptAt: now,
        outboxEventId: outbox.id,
      })
    }
    if (identities.length === 0) {
      await createDelivery(req, {
        channel: 'in_app',
        customerId: input.customerId,
        deliveryKey: `${input.eventKey}:in-app-fallback`,
        nextAttemptAt: now,
        outboxEventId: outbox.id,
      })
    }
    return { deliveryCount: Math.max(identities.length, 1), outboxEventId: outbox.id }
  })
}

type ClaimedDelivery = DeliveryRecord & { receiptOnly: boolean }

async function claimDelivery(
  req: PayloadRequest,
  deliveryId: number | string,
  now: Date,
): Promise<ClaimedDelivery | undefined> {
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE notification_deliveries
      SET
        status = 'sending',
        claimed_at = ${now.toISOString()},
        attempt_count = attempt_count + 1,
        updated_at = NOW()
      WHERE id = ${deliveryId}
        AND status IN ('pending', 'retry_pending', 'sent')
        AND next_attempt_at <= ${now.toISOString()}
      RETURNING id, delivery_key, outbox_event_id, customer_id, channel,
        recipient_encrypted, recipient_masked, recipient_identity_hash,
        status, attempt_count, max_attempts, provider_message_id, claimed_at
    `)
    const row = claimed.rows?.[0]
    if (!row) return undefined
    return {
      attemptCount: Number(row.attempt_count),
      channel: String(row.channel) as ClaimedDelivery['channel'],
      claimedAt: new Date(String(row.claimed_at)).toISOString(),
      customer: row.customer_id as number | string,
      deliveryKey: String(row.delivery_key),
      id: row.id as number | string,
      maxAttempts: Number(row.max_attempts),
      outboxEvent: row.outbox_event_id as number | string,
      providerMessageId: row.provider_message_id ? String(row.provider_message_id) : undefined,
      receiptOnly: row.provider_message_id !== null && row.provider_message_id !== undefined,
      recipientEncrypted: row.recipient_encrypted ? String(row.recipient_encrypted) : undefined,
      recipientIdentityHash: String(row.recipient_identity_hash),
      recipientMasked: String(row.recipient_masked),
      status: 'sending',
    }
  })
}

async function claimStaleDelivery(
  req: PayloadRequest,
  deliveryId: number | string,
  staleBefore: Date,
  now: Date,
): Promise<ClaimedDelivery | undefined> {
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE notification_deliveries
      SET claimed_at = ${now.toISOString()}, updated_at = NOW()
      WHERE id = ${deliveryId}
        AND status = 'sending'
        AND claimed_at <= ${staleBefore.toISOString()}
      RETURNING id, delivery_key, outbox_event_id, customer_id, channel,
        recipient_encrypted, recipient_masked, recipient_identity_hash,
        status, attempt_count, max_attempts, provider_message_id, claimed_at
    `)
    const row = claimed.rows?.[0]
    if (!row) return undefined
    return {
      attemptCount: Number(row.attempt_count),
      channel: String(row.channel) as ClaimedDelivery['channel'],
      claimedAt: new Date(String(row.claimed_at)).toISOString(),
      customer: row.customer_id as number | string,
      deliveryKey: String(row.delivery_key),
      id: row.id as number | string,
      maxAttempts: Number(row.max_attempts),
      outboxEvent: row.outbox_event_id as number | string,
      providerMessageId: row.provider_message_id ? String(row.provider_message_id) : undefined,
      receiptOnly: row.provider_message_id !== null && row.provider_message_id !== undefined,
      recipientEncrypted: row.recipient_encrypted ? String(row.recipient_encrypted) : undefined,
      recipientIdentityHash: String(row.recipient_identity_hash),
      recipientMasked: String(row.recipient_masked),
      status: 'sending',
    }
  })
}

async function loadOutbox(req: PayloadRequest, id: number | string): Promise<OutboxRecord> {
  return (await req.payload.findByID({
    collection: 'notificationOutboxEvents',
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })) as unknown as OutboxRecord
}

async function providerSentAt(req: PayloadRequest, deliveryId: number | string): Promise<string> {
  const receipt = await req.payload.find({
    collection: 'notificationProviderReceipts',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    sort: 'observedAt',
    where: {
      and: [{ delivery: { equals: deliveryId } }, { outcome: { equals: 'accepted' } }],
    },
  })
  const sentAt = receipt.docs[0]?.observedAt
  if (!sentAt) {
    throw new AppError('NOTIFICATION_SEND_RECEIPT_MISSING', '通知发送时间回执缺失', 409)
  }
  return sentAt
}

function decryptedRecipient(delivery: DeliveryRecord): string {
  if (!delivery.recipientEncrypted) {
    throw new AppError('NOTIFICATION_RECIPIENT_UNAVAILABLE', '通知接收渠道不可用', 409)
  }
  const env = getEnv()
  return decryptSecret(
    delivery.recipientEncrypted,
    env.CUSTOMER_IDENTITY_ENCRYPTION_KEY ?? env.TOTP_ENCRYPTION_KEY,
  )
}

function retryAt(now: Date, attempt: number): string {
  const delaySeconds = Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1))
  return new Date(now.getTime() + delaySeconds * 1_000).toISOString()
}

async function ensureInAppFallback(
  req: PayloadRequest,
  delivery: DeliveryRecord,
  now: Date,
): Promise<void> {
  if (delivery.channel !== 'sms') return
  const customerId = numericRelationId(relationId(delivery.customer))
  const outboxEventId = numericRelationId(relationId(delivery.outboxEvent))
  const deliveryKey = `${delivery.deliveryKey}:in-app-fallback`
  await (
    await database(req)
  ).execute(sql`
    INSERT INTO notification_deliveries (
      delivery_key, outbox_event_id, customer_id, channel,
      recipient_encrypted, recipient_masked, recipient_identity_hash,
      status, attempt_count, max_attempts, next_attempt_at, updated_at, created_at
    ) VALUES (
      ${deliveryKey}, ${outboxEventId}, ${customerId}, 'in_app',
      NULL, '站内消息', ${hmac(`in-app:${customerId}`, getEnv().SESSION_PEPPER)},
      'pending', 0, 3, ${now.toISOString()}, NOW(), NOW()
    )
    ON CONFLICT (delivery_key) DO NOTHING
  `)
}

async function recordOutcome(
  req: PayloadRequest,
  delivery: ClaimedDelivery,
  input: {
    now: Date
    outcome: 'accepted' | 'delivered' | 'failed' | 'unknown'
    providerCode?: string
    providerMessageId?: string
    providerRequestId?: string
    retryableKnown?: boolean
  },
): Promise<'dead_letter' | 'delivered' | 'retry_pending' | 'sent'> {
  return transaction(req, async () => {
    const receiptPollingExhausted =
      input.outcome === 'accepted' &&
      delivery.receiptOnly &&
      delivery.attemptCount >= delivery.maxAttempts
    const canRetry =
      input.outcome === 'failed' &&
      input.retryableKnown === true &&
      delivery.attemptCount < delivery.maxAttempts
    const status =
      input.outcome === 'delivered'
        ? 'delivered'
        : receiptPollingExhausted
          ? 'dead_letter'
          : input.outcome === 'accepted'
            ? 'sent'
            : canRetry
              ? 'retry_pending'
              : 'dead_letter'
    await req.payload.create({
      collection: 'notificationProviderReceipts',
      data: {
        attemptNumber: Math.max(1, delivery.attemptCount),
        channel: delivery.channel,
        delivery: numericRelationId(delivery.id),
        observedAt: input.now.toISOString(),
        outcome: input.outcome,
        providerCode: receiptPollingExhausted
          ? 'NOTIFICATION_RECEIPT_PENDING_EXHAUSTED'
          : input.providerCode,
        providerMessageId: input.providerMessageId,
        providerRequestId: input.providerRequestId,
        receiptKey: `${delivery.deliveryKey}:${Math.max(1, delivery.attemptCount)}:${delivery.receiptOnly ? 'receipt' : 'send'}:${input.outcome}:${input.now.toISOString()}`,
      },
      overrideAccess: true,
      req,
    })
    const updated = await (
      await database(req)
    ).execute(sql`
      UPDATE notification_deliveries
      SET
        status = ${status},
        next_attempt_at = ${
          status === 'delivered'
            ? input.now.toISOString()
            : status === 'dead_letter'
              ? input.now.toISOString()
              : retryAt(input.now, delivery.attemptCount)
        },
        provider_request_id = ${input.providerRequestId ?? null},
        provider_message_id = ${input.providerMessageId ?? delivery.providerMessageId ?? null},
        provider_code = ${
          receiptPollingExhausted
            ? 'NOTIFICATION_RECEIPT_PENDING_EXHAUSTED'
            : (input.providerCode ?? null)
        },
        delivered_at = ${status === 'delivered' ? input.now.toISOString() : null},
        dead_lettered_at = ${status === 'dead_letter' ? input.now.toISOString() : null},
        updated_at = NOW()
      WHERE id = ${delivery.id}
        AND status = 'sending'
        AND attempt_count = ${delivery.attemptCount}
        AND claimed_at = ${delivery.claimedAt}
      RETURNING id
    `)
    if (updated.rows?.[0]?.id === undefined) {
      throw new AppError('NOTIFICATION_DELIVERY_STATE_CONFLICT', '通知投递状态已变化', 409)
    }
    if (input.outcome === 'failed' || input.outcome === 'unknown' || receiptPollingExhausted) {
      await ensureInAppFallback(req, delivery, input.now)
    }
    return status
  })
}

export type NotificationDeliveryDependencies = {
  now?: () => Date
  smsProvider?: SmsProvider
  wechatProvider?: WechatOfficialProvider
}

async function deliverClaimed(
  req: PayloadRequest,
  delivery: ClaimedDelivery,
  dependencies: NotificationDeliveryDependencies,
) {
  const now = (dependencies.now ?? (() => new Date()))()
  if (delivery.channel === 'in_app') {
    return recordOutcome(req, delivery, { now, outcome: 'delivered' })
  }
  const outbox = await loadOutbox(req, relationId(delivery.outboxEvent))
  if (outbox.category !== 'transactional') {
    throw new AppError('NOTIFICATION_CATEGORY_UNSUPPORTED', '当前投递任务只处理交易类通知', 409)
  }
  const recipient = decryptedRecipient(delivery)
  if (delivery.channel === 'sms') {
    const provider = dependencies.smsProvider ?? createSmsProvider()
    if (delivery.receiptOnly && delivery.providerMessageId) {
      const receipt = await provider.queryReceipt({
        phone: recipient,
        providerMessageId: delivery.providerMessageId,
        sentAt: await providerSentAt(req, delivery.id),
        traceId: `${outbox.traceId}:${delivery.deliveryKey}:receipt`,
      })
      if (!receipt.ok) {
        return recordOutcome(req, delivery, {
          now,
          outcome: receipt.error.statusKnown ? 'failed' : 'unknown',
          providerCode: receipt.error.code,
          providerRequestId: receipt.requestId,
          retryableKnown: receipt.error.retryable && receipt.error.statusKnown,
        })
      }
      if (receipt.data.status === 'pending') {
        return recordOutcome(req, delivery, {
          now,
          outcome: 'accepted',
          providerMessageId: delivery.providerMessageId,
          providerRequestId: receipt.requestId,
        })
      }
      return recordOutcome(req, delivery, {
        now,
        outcome: receipt.data.status === 'delivered' ? 'delivered' : 'failed',
        providerCode: receipt.data.providerCode,
        providerMessageId: delivery.providerMessageId,
        providerRequestId: receipt.requestId,
        retryableKnown: receipt.data.status === 'failed',
      })
    }
    if (!provider.sendIdentityChanged) {
      return recordOutcome(req, delivery, {
        now,
        outcome: 'failed',
        providerCode: 'SMS_SECURITY_NOTICE_UNAVAILABLE',
      })
    }
    const sent = await provider.sendIdentityChanged({
      phone: recipient,
      traceId: `${outbox.traceId}:${delivery.deliveryKey}`,
    })
    if (!sent.ok) {
      return recordOutcome(req, delivery, {
        now,
        outcome: sent.error.statusKnown ? 'failed' : 'unknown',
        providerCode: sent.error.code,
        providerRequestId: sent.requestId,
        retryableKnown: sent.error.retryable && sent.error.statusKnown,
      })
    }
    return recordOutcome(req, delivery, {
      now,
      outcome: sent.data.deliveryStatus === 'delivered' ? 'delivered' : 'accepted',
      providerMessageId: sent.data.providerMessageId,
      providerRequestId: sent.requestId,
    })
  }
  try {
    const result = await (
      dependencies.wechatProvider ?? createWechatOfficialProvider()
    ).sendSecurityNotice({
      content: `${outbox.subjectSnapshot}\n${outbox.bodySnapshot}`,
      openid: recipient,
      traceId: `${outbox.traceId}:${delivery.deliveryKey}`,
    })
    return recordOutcome(req, delivery, {
      now,
      outcome: 'delivered',
      providerRequestId: result.requestId,
    })
  } catch {
    return recordOutcome(req, delivery, {
      now,
      outcome: 'unknown',
      providerCode: 'WECHAT_SECURITY_NOTICE_UNKNOWN',
    })
  }
}

export async function runNotificationDeliveries(
  req: PayloadRequest,
  dependencies: NotificationDeliveryDependencies = {},
) {
  const now = (dependencies.now ?? (() => new Date()))()
  const staleBefore = new Date(now.getTime() - 5 * 60_000)
  const candidates = await req.payload.find({
    collection: 'notificationDeliveries',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    req,
    sort: 'nextAttemptAt',
    where: {
      or: [
        {
          and: [
            { status: { in: ['pending', 'retry_pending', 'sent'] } },
            { nextAttemptAt: { less_than_equal: now.toISOString() } },
          ],
        },
        {
          and: [
            { status: { equals: 'sending' } },
            { claimedAt: { less_than_equal: staleBefore.toISOString() } },
          ],
        },
      ],
    },
  })
  const summary = { claimed: 0, deadLetter: 0, delivered: 0, retryPending: 0, sent: 0 }
  for (const candidate of candidates.docs) {
    const wasStale = candidate.status === 'sending'
    const claimed = wasStale
      ? await claimStaleDelivery(req, candidate.id, staleBefore, now)
      : await claimDelivery(req, candidate.id, now)
    if (!claimed) continue
    summary.claimed += 1
    let status: Awaited<ReturnType<typeof deliverClaimed>>
    if (wasStale) {
      status = await recordOutcome(req, claimed, {
        now,
        outcome: 'unknown',
        providerCode: 'NOTIFICATION_WORKER_INTERRUPTED',
      })
    } else {
      try {
        status = await deliverClaimed(req, claimed, dependencies)
      } catch {
        status = await recordOutcome(req, claimed, {
          now,
          outcome: 'unknown',
          providerCode: 'NOTIFICATION_DELIVERY_UNKNOWN',
        })
      }
    }
    if (status === 'dead_letter') summary.deadLetter += 1
    if (status === 'delivered') summary.delivered += 1
    if (status === 'retry_pending') summary.retryPending += 1
    if (status === 'sent') summary.sent += 1
  }
  return summary
}

export async function updateNotificationPreference(
  req: PayloadRequest,
  input: {
    category: 'marketing' | 'transactional'
    enabled: boolean
    notificationType: MarketingNotificationType | TransactionalNotificationType
  },
) {
  if (!isCustomerUser(req.user)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
  if (input.category !== 'marketing') {
    throw new AppError(
      'TRANSACTIONAL_NOTIFICATION_UNSUBSCRIBE_FORBIDDEN',
      '交易类通知不可退订',
      409,
    )
  }
  if (!['product_updates', 'promotions'].includes(input.notificationType)) {
    throw new AppError('MARKETING_NOTIFICATION_TYPE_INVALID', '营销通知类型无效', 400)
  }
  const type = input.notificationType as MarketingNotificationType
  return transaction(req, async () => {
    const found = await req.payload.find({
      collection: 'notificationMarketingPreferences',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { customer: { equals: req.user!.id } },
    })
    const current = new Set(
      ((found.docs[0] as { enabledMarketingTypes?: MarketingNotificationType[] } | undefined)
        ?.enabledMarketingTypes ?? [
        'product_updates',
        'promotions',
      ]) as MarketingNotificationType[],
    )
    if (input.enabled) current.add(type)
    else current.delete(type)
    const enabledMarketingTypes = [...current].sort()
    const document = found.docs[0]
      ? await req.payload.update({
          collection: 'notificationMarketingPreferences',
          data: { enabledMarketingTypes },
          id: found.docs[0].id,
          overrideAccess: true,
          req,
        })
      : await req.payload.create({
          collection: 'notificationMarketingPreferences',
          data: { customer: req.user!.id, enabledMarketingTypes },
          overrideAccess: true,
          req,
        })
    return { enabledMarketingTypes: document.enabledMarketingTypes ?? [], updated: true }
  })
}

export async function listAdminNotificationDeliveries(req: PayloadRequest) {
  if (!hasAdminOperationScope(req.user, 'funds_operations')) {
    throw new AppError('ADMIN_FUNDS_OPERATION_SCOPE_REQUIRED', '需要资金操作权限', 403)
  }
  const deliveries = await req.payload.find({
    collection: 'notificationDeliveries',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    req,
    sort: '-createdAt',
  })
  return deliveries.docs.map((raw) => {
    const delivery = raw as unknown as DeliveryRecord & {
      createdAt?: string
      providerCode?: string
    }
    return {
      channel: delivery.channel,
      createdAt: delivery.createdAt,
      id: delivery.id,
      providerCode: delivery.providerCode,
      recipient: delivery.recipientMasked,
      status: delivery.status,
    }
  })
}

export async function listCustomerNotifications(req: PayloadRequest) {
  if (!isCustomerUser(req.user)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
  const customerId = numericRelationId(req.user.id)
  const events = await req.payload.find({
    collection: 'notificationOutboxEvents',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    req,
    sort: '-createdAt',
    where: { customer: { equals: customerId } },
  })
  const ids = events.docs.map((event) => event.id)
  const readStates = ids.length
    ? await req.payload.find({
        collection: 'notificationReadStates',
        depth: 0,
        limit: ids.length,
        overrideAccess: true,
        req,
        where: {
          and: [{ customer: { equals: customerId } }, { outboxEvent: { in: ids } }],
        },
      })
    : { docs: [] }
  const readByEvent = new Map(
    readStates.docs.map((state) => [String(relationId(state.outboxEvent)), state.readAt]),
  )
  return events.docs.map((event) => ({
    body: event.bodySnapshot,
    category: event.category,
    createdAt: event.createdAt,
    id: event.id,
    notificationType: event.notificationType,
    readAt: readByEvent.get(String(event.id)) ?? null,
    subject: event.subjectSnapshot,
    templateVersion: event.templateVersion,
  }))
}

export async function markCustomerNotificationRead(
  req: PayloadRequest,
  outboxEventId: number | string,
) {
  if (!isCustomerUser(req.user)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
  const customerId = numericRelationId(req.user.id)
  return transaction(req, async () => {
    const visible = await req.payload.find({
      collection: 'notificationOutboxEvents',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [{ id: { equals: outboxEventId } }, { customer: { equals: customerId } }],
      },
    })
    if (!visible.docs[0]) {
      throw new AppError('NOTIFICATION_NOT_FOUND', '未找到通知', 404)
    }
    const readAt = new Date().toISOString()
    const inserted = await (
      await database(req)
    ).execute(sql`
      INSERT INTO notification_read_states (
        read_key, outbox_event_id, customer_id, read_at, updated_at, created_at
      ) VALUES (
        ${`${customerId}:${outboxEventId}`}, ${outboxEventId}, ${customerId}, ${readAt}, NOW(), NOW()
      )
      ON CONFLICT (outbox_event_id, customer_id) DO NOTHING
      RETURNING id, read_at
    `)
    const existing = inserted.rows?.[0]
    if (existing) return { readAt: String(existing.read_at), updated: true }
    const found = await (
      await database(req)
    ).execute(sql`
      SELECT read_at
      FROM notification_read_states
      WHERE outbox_event_id = ${outboxEventId} AND customer_id = ${customerId}
    `)
    return { readAt: String(found.rows?.[0]?.read_at), updated: false }
  })
}
