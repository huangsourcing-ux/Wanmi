import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { createSmsProvider } from '@/providers/aliyunsms'
import type { SmsFailureCategory, SmsProvider } from '@/providers/types'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { enforceSmsRateLimits } from '@/services/auth/sms-rate-limit'

type AssetRecord = {
  customer: number | string | { id: number | string }
  domainAscii: string
  expiresAt: string
  id: number | string
}

type CustomerRecord = {
  id: number | string
  phone: string
  status: string
}

type ReminderRecord = {
  channel: 'in_app' | 'sms'
  id: number | string
  reminderKey: string
  status: 'delivered' | 'failed' | 'pending' | 'sending' | 'unknown'
}

export type DomainExpiryReminderDependencies = {
  now?: () => Date
  provider: SmsProvider
  thresholds?: number[]
  traceId: string
}

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
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

async function database(req: PayloadRequest) {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as
    | {
        execute(
          statement: ReturnType<typeof sql>,
        ): Promise<{ rows?: Array<{ id: number | string }> }>
      }
    | undefined
  if (!current) {
    throw new AppError('EXPIRY_REMINDER_CAS_UNAVAILABLE', '无法原子认领到期提醒', 503)
  }
  return current
}

function configuredThresholds(): number[] {
  return [...new Set(getEnv().DOMAIN_EXPIRY_REMINDER_DAYS.split(',').map(Number))]
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 365)
    .sort((left, right) => left - right)
}

function dueThreshold(expiresAt: string, now: Date, thresholds: number[]): number | undefined {
  const remainingMs = Date.parse(expiresAt) - now.getTime()
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return undefined
  const remainingDays = Math.ceil(remainingMs / 86_400_000)
  return thresholds.find((threshold) => remainingDays <= threshold)
}

function key(
  assetId: number | string,
  expiresAt: string,
  thresholdDays: number,
  channel: 'in_app' | 'sms',
): string {
  const digest = createHash('sha256')
    .update(`${assetId}:${new Date(expiresAt).toISOString()}:${thresholdDays}:${channel}`)
    .digest('hex')
  return `domain-expiry:${digest}`
}

async function findReminder(req: PayloadRequest, reminderKey: string) {
  const found = await req.payload.find({
    collection: 'domainExpiryReminders',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { reminderKey: { equals: reminderKey } },
  })
  return found.docs[0] as unknown as ReminderRecord | undefined
}

async function prepareReminder(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    channel: 'in_app' | 'sms'
    customerId: number | string
    thresholdDays: number
    traceId: string
  },
): Promise<{ created: boolean; reminder: ReminderRecord }> {
  const reminderKey = key(input.asset.id, input.asset.expiresAt, input.thresholdDays, input.channel)
  const existing = await findReminder(req, reminderKey)
  if (existing) return { created: false, reminder: existing }
  try {
    const reminder = await transaction(req, async () => {
      const created = (await req.payload.create({
        collection: 'domainExpiryReminders',
        data: {
          asset: input.asset.id as never,
          channel: input.channel,
          createdTraceId: input.traceId,
          customer: input.customerId as never,
          deliveredAt: input.channel === 'in_app' ? new Date().toISOString() : undefined,
          expiresAtSnapshot: input.asset.expiresAt,
          reminderKey,
          status: input.channel === 'in_app' ? 'delivered' : 'pending',
          thresholdDays: input.thresholdDays,
        },
        overrideAccess: true,
        req,
      })) as unknown as ReminderRecord
      if (input.channel === 'in_app') {
        await recordAuditEvent(req, {
          action: 'domain.expiry_reminder.recorded',
          actor: { type: 'system' },
          metadata: {
            channel: input.channel,
            outcome: 'delivered',
            thresholdDays: input.thresholdDays,
          },
          targetId: created.id,
        })
      }
      return created
    })
    return { created: true, reminder }
  } catch (error) {
    const raced = await findReminder(req, reminderKey)
    if (raced) return { created: false, reminder: raced }
    throw error
  }
}

async function claimSms(req: PayloadRequest, reminder: ReminderRecord): Promise<boolean> {
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE domain_expiry_reminders
      SET status = 'sending', attempted_at = NOW(), updated_at = NOW()
      WHERE id = ${reminder.id}
        AND channel = 'sms'
        AND status = 'pending'
      RETURNING id
    `)
    return claimed.rows?.[0]?.id !== undefined
  })
}

function failureCategory(code: string): SmsFailureCategory {
  const normalized = code.replace(/^SMS_/, '').toLowerCase()
  return ['balance_insufficient', 'invalid_number', 'rate_limited', 'template_unapproved'].includes(
    normalized,
  )
    ? (normalized as SmsFailureCategory)
    : 'unknown'
}

async function recordSmsOutcome(
  req: PayloadRequest,
  reminder: ReminderRecord,
  input:
    | {
        deliveredAt?: string
        providerMessageId?: string
        providerRequestId?: string
        status: 'delivered' | 'unknown'
      }
    | {
        failureCategory: SmsFailureCategory
        providerCode: string
        providerRequestId?: string
        status: 'failed'
      },
) {
  return transaction(req, async () => {
    const updated = await req.payload.update({
      collection: 'domainExpiryReminders',
      data: input,
      id: reminder.id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'domain.expiry_reminder.recorded',
      actor: { type: 'system' },
      metadata: {
        channel: 'sms',
        failureCategory: 'failureCategory' in input ? input.failureCategory : undefined,
        outcome: input.status,
      },
      targetId: reminder.id,
    })
    return updated
  })
}

async function sendSmsReminder(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    customer: CustomerRecord
    reminder: ReminderRecord
    provider: SmsProvider
    thresholdDays: number
    traceId: string
  },
): Promise<'delivered' | 'failed' | 'skipped' | 'unknown'> {
  if (!(await claimSms(req, input.reminder))) return 'skipped'
  const env = getEnv()
  try {
    await enforceSmsRateLimits(req.payload, {
      deviceHash: hmac(`domain-expiry:asset:${input.asset.id}`, env.SESSION_PEPPER),
      ipHash: hmac('domain-expiry:background-worker', env.SESSION_PEPPER),
      phoneHash: hmac(input.customer.phone, env.SESSION_PEPPER),
    })
  } catch (error) {
    const code =
      error instanceof AppError && error.status === 429 ? 'SMS_RATE_LIMITED' : 'SMS_UNKNOWN'
    await recordSmsOutcome(req, input.reminder, {
      failureCategory: failureCategory(code),
      providerCode: code,
      status: 'failed',
    })
    return 'failed'
  }
  const result = await input.provider.sendDomainExpiry({
    daysRemaining: input.thresholdDays,
    domainAscii: input.asset.domainAscii,
    expiresOn: input.asset.expiresAt.slice(0, 10),
    phone: input.customer.phone,
    traceId: input.traceId,
  })
  if (!result.ok) {
    await recordSmsOutcome(req, input.reminder, {
      failureCategory: failureCategory(result.error.code),
      providerCode: result.error.code,
      providerRequestId: result.requestId,
      status: 'failed',
    })
    return 'failed'
  }
  const status = result.data.deliveryStatus === 'delivered' ? 'delivered' : 'unknown'
  await recordSmsOutcome(req, input.reminder, {
    deliveredAt: status === 'delivered' ? new Date().toISOString() : undefined,
    providerMessageId: result.data.providerMessageId,
    providerRequestId: result.requestId,
    status,
  })
  return status
}

export async function runDomainExpiryReminders(
  req: PayloadRequest,
  dependencies: DomainExpiryReminderDependencies,
) {
  const now = (dependencies.now ?? (() => new Date()))()
  const thresholds = dependencies.thresholds ?? configuredThresholds()
  if (!thresholds.length) return { delivered: 0, failed: 0, scanned: 0, skipped: 0, unknown: 0 }
  const maxThreshold = Math.max(...thresholds)
  const assets = await req.payload.find({
    collection: 'domainAssets',
    depth: 0,
    limit: 500,
    overrideAccess: true,
    req,
    sort: 'expiresAt',
    where: {
      and: [
        { expiresAt: { greater_than_equal: now.toISOString() } },
        {
          expiresAt: {
            less_than_equal: new Date(now.getTime() + maxThreshold * 86_400_000).toISOString(),
          },
        },
        { status: { in: ['active', 'pending'] } },
      ],
    },
  })
  const summary = { delivered: 0, failed: 0, scanned: assets.totalDocs, skipped: 0, unknown: 0 }
  for (const document of assets.docs) {
    const asset = document as unknown as AssetRecord
    const thresholdDays = dueThreshold(asset.expiresAt, now, thresholds)
    if (thresholdDays === undefined) continue
    const customer = (await req.payload.findByID({
      collection: 'customers',
      depth: 0,
      id: relationId(asset.customer),
      overrideAccess: true,
      req,
    })) as CustomerRecord
    if (customer.status !== 'active') continue
    await prepareReminder(req, {
      asset,
      channel: 'in_app',
      customerId: customer.id,
      thresholdDays,
      traceId: dependencies.traceId,
    })
    const sms = await prepareReminder(req, {
      asset,
      channel: 'sms',
      customerId: customer.id,
      thresholdDays,
      traceId: dependencies.traceId,
    })
    const outcome = await sendSmsReminder(req, {
      asset,
      customer,
      provider: dependencies.provider,
      reminder: sms.reminder,
      thresholdDays,
      traceId: `${dependencies.traceId}:${asset.id}:${thresholdDays}`,
    })
    summary[outcome] += 1
  }
  return summary
}

export async function runConfiguredDomainExpiryReminders(req: PayloadRequest, traceId: string) {
  return runDomainExpiryReminders(req, { provider: createSmsProvider(), traceId })
}
