import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import {
  domainAssetPreferenceResultSchema,
  type DomainAssetTagsRequest,
  type DomainExpiryReminderPreferencesRequest,
} from '@/schemas/domains'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'

import { findOwnedDomainAsset } from './domain-assets'
import { appendManagementEvent, type DomainManagedAssetRecord } from './domain-management'
import { configuredDomainExpiryThresholds } from './expiry-reminders'

type CustomerIdentity = {
  collection: 'customers'
  id: number | string
  status?: null | string
}

async function transaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const value = await work()
    if (started) await commitTransaction(req)
    return value
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}

function assertCustomerPrincipal(req: PayloadRequest, customer: CustomerIdentity): void {
  if (!isCustomerUser(req.user) || String(req.user.id) !== String(customer.id)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
}

function normalizedReminderDays(input: DomainExpiryReminderPreferencesRequest): number[] {
  const configured = configuredDomainExpiryThresholds()
  if (!configured.length) {
    throw new AppError('DOMAIN_EXPIRY_REMINDER_CONFIG_INVALID', '域名到期提醒配置不可用', 503)
  }
  if (input.thresholdDays.some((value) => !configured.includes(value))) {
    throw new AppError(
      'DOMAIN_EXPIRY_REMINDER_THRESHOLD_UNSUPPORTED',
      '提醒提前天数必须来自当前可选档位',
      400,
    )
  }
  const finalThreshold = configured[0]!
  if (!input.thresholdDays.includes(finalThreshold)) {
    throw new AppError(
      'DOMAIN_EXPIRY_FINAL_REMINDER_REQUIRED',
      `距到期 ${finalThreshold} 天的最后一档提醒不可关闭`,
      400,
    )
  }
  return [...input.thresholdDays].sort((left, right) => left - right)
}

export async function updateCustomerDomainTags(
  req: PayloadRequest,
  assetId: number | string,
  input: DomainAssetTagsRequest,
  options: { customer: CustomerIdentity; traceId: string },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(
    req,
    assetId,
    options.customer,
  )) as DomainManagedAssetRecord & { tags?: null | string[] }
  const tags = [...input.tags].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const previous = asset.tags ?? []
  await transaction(req, async () => {
    await req.payload.update({
      collection: 'domainAssets',
      data: { tags },
      id: asset.id,
      overrideAccess: true,
      req,
    })
    await appendManagementEvent(req, {
      asset,
      customerId: options.customer.id,
      event: 'confirmed',
      eventRoot: `domain-tags:${asset.id}:${input.idempotencyKey}`,
      operation: 'tags_update',
      operationKey: input.idempotencyKey,
      previousValue: { tags: previous },
      requestedValue: { tags },
      traceId: options.traceId,
    })
  })
  return domainAssetPreferenceResultSchema.parse({
    data: { assetIds: [String(asset.id)], updated: 1 },
    state: 'ready',
  })
}

export async function updateCustomerDomainExpiryReminderPreferences(
  req: PayloadRequest,
  input: DomainExpiryReminderPreferencesRequest,
  options: { customer: CustomerIdentity; traceId: string },
) {
  assertCustomerPrincipal(req, options.customer)
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const thresholdDays = normalizedReminderDays(input)
  const visible = await req.payload.find({
    collection: 'domainAssets',
    depth: 0,
    overrideAccess: false,
    pagination: false,
    req,
    user: req.user,
    where: {
      and: [{ customer: { equals: options.customer.id } }, { id: { in: input.assetIds } }],
    },
  })
  if (visible.docs.length !== input.assetIds.length) {
    throw new AppError(
      'DOMAIN_ASSET_BATCH_OWNERSHIP_MISMATCH',
      '批量请求包含不存在或不属于当前用户的域名',
      404,
    )
  }
  const assets = visible.docs as unknown as Array<
    DomainManagedAssetRecord & {
      expiryReminderChannels?: null | Array<'in_app' | 'sms'>
      expiryReminderDays?: null | number[]
    }
  >
  await transaction(req, async () => {
    for (const asset of assets) {
      await req.payload.update({
        collection: 'domainAssets',
        data: {
          expiryReminderChannels: input.channels,
          expiryReminderDays: thresholdDays,
        },
        id: asset.id,
        overrideAccess: true,
        req,
      })
      await appendManagementEvent(req, {
        asset,
        customerId: options.customer.id,
        event: 'confirmed',
        eventRoot: `expiry-reminder-preferences:${input.batchKey}:${asset.id}`,
        operation: 'expiry_reminder_preferences_update',
        operationKey: input.batchKey,
        previousValue: {
          channels: asset.expiryReminderChannels ?? ['in_app', 'sms'],
          thresholdDays: asset.expiryReminderDays ?? configuredDomainExpiryThresholds(),
        },
        requestedValue: { channels: input.channels, thresholdDays },
        traceId: options.traceId,
      })
    }
  })
  const assetIds = assets.map((asset) => String(asset.id))
  return domainAssetPreferenceResultSchema.parse({
    data: { assetIds, updated: assetIds.length },
    state: 'ready',
  })
}
