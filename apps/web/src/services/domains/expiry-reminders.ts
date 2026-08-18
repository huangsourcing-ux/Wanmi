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
  expiryReminderChannels?: null | Array<'in_app' | 'sms'>
  expiryReminderDays?: null | number[]
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

export type DomainReminderNoticeType =
  | 'expiry'
  | 'automatic_renewal_enabled'
  | 'automatic_renewal_due'
  | 'automatic_renewal_balance_insufficient'
  | 'automatic_renewal_price_changed'
  | 'automatic_renewal_blocked'

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

export function configuredDomainExpiryThresholds(): number[] {
  return [...new Set(getEnv().DOMAIN_EXPIRY_REMINDER_DAYS.split(',').map(Number))]
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 365)
    .sort((left, right) => left - right)
}

function reminderPreferences(
  asset: AssetRecord,
  configured: number[],
): { channels: Array<'in_app' | 'sms'>; days: number[] } {
  const finalThreshold = configured[0]
  const requestedDays = Array.isArray(asset.expiryReminderDays)
    ? asset.expiryReminderDays
    : configured
  const days = [...new Set(requestedDays)]
    .filter((value) => configured.includes(value))
    .concat(finalThreshold === undefined ? [] : [finalThreshold])
  const requestedChannels = Array.isArray(asset.expiryReminderChannels)
    ? asset.expiryReminderChannels
    : ['in_app', 'sms']
  const channels = [...new Set(requestedChannels)].filter(
    (value): value is 'in_app' | 'sms' => value === 'in_app' || value === 'sms',
  )
  return {
    channels: channels.length ? channels : ['in_app'],
    days: [...new Set(days)].sort((left, right) => left - right),
  }
}

function dueThreshold(expiresAt: string, now: Date, thresholds: number[]): number | undefined {
  const remainingMs = Date.parse(expiresAt) - now.getTime()
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return undefined
  const remainingDays = Math.ceil(remainingMs / 86_400_000)
  return thresholds.find((threshold) => remainingDays <= threshold)
}

function expiryKey(
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

function automaticRenewalKey(input: {
  assetId: number | string
  dedupeKey: string
  expiresAt: string
  noticeType: Exclude<DomainReminderNoticeType, 'expiry'>
  channel: 'in_app' | 'sms'
}): string {
  const digest = createHash('sha256')
    .update(
      `${input.assetId}:${new Date(input.expiresAt).toISOString()}:${input.noticeType}:${input.dedupeKey}:${input.channel}`,
    )
    .digest('hex')
  return `automatic-renewal-notice:${digest}`
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
    amountFen?: number
    asset: AssetRecord
    authorizedMaxAmountFen?: number
    channel: 'in_app' | 'sms'
    customerId: number | string
    dedupeKey?: string
    mandateId?: number | string
    noticeType?: DomainReminderNoticeType
    thresholdDays: number
    traceId: string
  },
): Promise<{ created: boolean; reminder: ReminderRecord }> {
  const noticeType = input.noticeType ?? 'expiry'
  const reminderKey =
    noticeType === 'expiry'
      ? expiryKey(input.asset.id, input.asset.expiresAt, input.thresholdDays, input.channel)
      : automaticRenewalKey({
          assetId: input.asset.id,
          channel: input.channel,
          dedupeKey: input.dedupeKey ?? `${input.mandateId ?? 'none'}:${noticeType}`,
          expiresAt: input.asset.expiresAt,
          noticeType,
        })
  const existing = await findReminder(req, reminderKey)
  if (existing) return { created: false, reminder: existing }
  try {
    const reminder = await transaction(req, async () => {
      const created = (await req.payload.create({
        collection: 'domainExpiryReminders',
        data: {
          asset: input.asset.id as never,
          amountFen: input.amountFen,
          authorizedMaxAmountFen: input.authorizedMaxAmountFen,
          channel: input.channel,
          createdTraceId: input.traceId,
          customer: input.customerId as never,
          deliveredAt: input.channel === 'in_app' ? new Date().toISOString() : undefined,
          expiresAtSnapshot: input.asset.expiresAt,
          mandate: input.mandateId as never,
          noticeType,
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
            noticeType,
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

export async function sendAutomaticRenewalReminder(
  req: PayloadRequest,
  input: {
    amountFen?: number
    asset: Pick<AssetRecord, 'domainAscii' | 'expiresAt' | 'id'>
    authorizedMaxAmountFen?: number
    customerId: number | string
    daysRemaining: number
    dedupeKey?: string
    mandateId: number | string
    noticeType: Exclude<DomainReminderNoticeType, 'expiry'>
    provider?: SmsProvider
    traceId: string
  },
) {
  const asset = (await req.payload.findByID({
    collection: 'domainAssets',
    depth: 0,
    id: input.asset.id,
    overrideAccess: true,
    req,
  })) as unknown as AssetRecord
  if (
    asset.domainAscii !== input.asset.domainAscii ||
    asset.expiresAt !== input.asset.expiresAt ||
    String(relationId(asset.customer)) !== String(input.customerId)
  ) {
    throw new AppError(
      'AUTOMATIC_RENEWAL_NOTICE_ASSET_CHANGED',
      '自动续费提醒的域名资产已变化',
      409,
    )
  }
  const customer = (await req.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: input.customerId,
    overrideAccess: true,
    req,
  })) as CustomerRecord
  const channels = reminderPreferences(asset, configuredDomainExpiryThresholds()).channels
  const outcomes: Array<'delivered' | 'failed' | 'skipped' | 'unknown'> = []
  for (const channel of channels) {
    const prepared = await prepareReminder(req, {
      amountFen: input.amountFen,
      asset,
      authorizedMaxAmountFen: input.authorizedMaxAmountFen,
      channel,
      customerId: input.customerId,
      dedupeKey: input.dedupeKey,
      mandateId: input.mandateId,
      noticeType: input.noticeType,
      thresholdDays: input.daysRemaining,
      traceId: input.traceId,
    })
    if (channel === 'in_app') {
      outcomes.push(prepared.created ? 'delivered' : 'skipped')
      continue
    }
    outcomes.push(
      await sendSmsReminder(req, {
        asset,
        customer,
        provider: input.provider ?? createSmsProvider(),
        reminder: prepared.reminder,
        thresholdDays: input.daysRemaining,
        traceId: input.traceId,
      }),
    )
  }
  return {
    delivered: outcomes.filter((outcome) => outcome === 'delivered').length,
    failed: outcomes.filter((outcome) => outcome === 'failed').length,
    skipped: outcomes.filter((outcome) => outcome === 'skipped').length,
    unknown: outcomes.filter((outcome) => outcome === 'unknown').length,
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
  const thresholds = dependencies.thresholds ?? configuredDomainExpiryThresholds()
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
    const preferences = reminderPreferences(asset, thresholds)
    const thresholdDays = dueThreshold(asset.expiresAt, now, preferences.days)
    if (thresholdDays === undefined) continue
    const customer = (await req.payload.findByID({
      collection: 'customers',
      depth: 0,
      id: relationId(asset.customer),
      overrideAccess: true,
      req,
    })) as CustomerRecord
    if (customer.status !== 'active' && customer.status !== 'restricted') continue
    if (preferences.channels.includes('in_app')) {
      await prepareReminder(req, {
        asset,
        channel: 'in_app',
        customerId: customer.id,
        thresholdDays,
        traceId: dependencies.traceId,
      })
    }
    if (preferences.channels.includes('sms')) {
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
  }
  return summary
}

export async function runConfiguredDomainExpiryReminders(req: PayloadRequest, traceId: string) {
  return runDomainExpiryReminders(req, { provider: createSmsProvider(), traceId })
}
