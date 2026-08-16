import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError, toProblemDetails } from '@/lib/errors'
import type { WestDigitalDomainAsset, WestDigitalWriteProvider } from '@/providers/types'
import {
  domainAssetDetailResultSchema,
  domainAssetListResultSchema,
  domainAssetViewSchema,
  type DomainAssetDetailResult,
  type DomainAssetListResult,
  type DomainAssetView,
} from '@/schemas/domains'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { assertCustomerAccountCapabilityFromSnapshot } from '@/services/auth/account-state'
import { queryWestDigitalAsset } from '@/services/providers/westdigital-operations'

type AssetRecord = {
  customer: number | string | { id: number | string }
  domainAscii: string
  expiresAt: string
  id: number | string
  lastSyncedAt: string
  nameservers?: null | string[]
  realnameTemplate: number | string | { id: number | string }
  registeredAt: string
  registrar: string
  status: 'active' | 'expired' | 'pending' | 'unknown'
}

type CustomerIdentity = {
  collection: 'customers'
  id: number | string
  status?: string | null
}

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
}

function assertCustomer(req: PayloadRequest, customer: CustomerIdentity): void {
  if (!isCustomerUser(req.user) || String(req.user.id) !== String(customer.id)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
  assertCustomerAccountCapabilityFromSnapshot(req.user, 'login')
}

function publicAsset(asset: AssetRecord): DomainAssetView {
  return domainAssetViewSchema.parse({
    domainAscii: asset.domainAscii,
    expiresAt: new Date(asset.expiresAt).toISOString(),
    id: String(asset.id),
    lastSyncedAt: new Date(asset.lastSyncedAt).toISOString(),
    nameservers: asset.nameservers ?? [],
    registeredAt: new Date(asset.registeredAt).toISOString(),
    registrar: asset.registrar,
    status: asset.status,
  })
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

export async function findOwnedDomainAsset(
  req: PayloadRequest,
  assetId: number | string,
  customer: CustomerIdentity,
): Promise<AssetRecord> {
  assertCustomer(req, customer)
  const visible = await req.payload.find({
    collection: 'domainAssets',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req,
    user: req.user,
    where: {
      and: [{ id: { equals: assetId } }, { customer: { equals: customer.id } }],
    },
  })
  if (!visible.docs[0]) throw new AppError('DOMAIN_ASSET_NOT_FOUND', '未找到域名资产', 404)
  return (await req.payload.findByID({
    collection: 'domainAssets',
    depth: 0,
    id: visible.docs[0].id,
    overrideAccess: true,
    req,
  })) as unknown as AssetRecord
}

export async function listCustomerDomainAssets(
  req: PayloadRequest,
  customer: CustomerIdentity,
): Promise<DomainAssetListResult> {
  assertCustomer(req, customer)
  const found = await req.payload.find({
    collection: 'domainAssets',
    depth: 0,
    limit: 100,
    overrideAccess: false,
    req,
    sort: 'expiresAt',
    user: req.user,
    where: { customer: { equals: customer.id } },
  })
  const items = found.docs.map((document) => publicAsset(document as unknown as AssetRecord))
  return domainAssetListResultSchema.parse({
    data: { items, total: found.totalDocs },
    state: items.length ? 'ready' : 'empty',
  })
}

async function detailForAsset(
  req: PayloadRequest,
  asset: AssetRecord,
  customer: CustomerIdentity,
): Promise<Extract<DomainAssetDetailResult, { state: 'ready' }>> {
  const [reminders, changes] = await Promise.all([
    req.payload.find({
      collection: 'domainExpiryReminders',
      depth: 0,
      limit: 50,
      overrideAccess: false,
      req,
      sort: '-createdAt',
      user: req.user,
      where: {
        and: [{ asset: { equals: asset.id } }, { customer: { equals: customer.id } }],
      },
    }),
    req.payload.find({
      collection: 'nameserverChanges',
      depth: 0,
      limit: 50,
      overrideAccess: false,
      req,
      sort: '-requestedAt',
      user: req.user,
      where: {
        and: [{ asset: { equals: asset.id } }, { customer: { equals: customer.id } }],
      },
    }),
  ])
  const parsed = domainAssetDetailResultSchema.parse({
    data: {
      asset: publicAsset(asset),
      nameserverChanges: changes.docs.map((change) => ({
        completedAt: change.completedAt ? new Date(change.completedAt).toISOString() : undefined,
        confirmedNameservers: change.confirmedNameservers ?? undefined,
        id: String(change.id),
        previousNameservers: change.previousNameservers ?? change.requestedNameservers,
        requestedAt: new Date(change.requestedAt ?? change.createdAt).toISOString(),
        requestedNameservers: change.requestedNameservers,
        status: change.status,
      })),
      reminders: reminders.docs.map((reminder) => ({
        channel: reminder.channel,
        deliveredAt: reminder.deliveredAt
          ? new Date(reminder.deliveredAt).toISOString()
          : undefined,
        expiresAtSnapshot: new Date(reminder.expiresAtSnapshot).toISOString(),
        id: String(reminder.id),
        status: reminder.status,
        thresholdDays: reminder.thresholdDays,
      })),
    },
    state: 'ready',
  })
  if (parsed.state !== 'ready') throw new Error('Unexpected domain asset detail state')
  return parsed
}

export async function getCustomerDomainAsset(
  req: PayloadRequest,
  assetId: number | string,
  customer: CustomerIdentity,
): Promise<DomainAssetDetailResult> {
  return detailForAsset(req, await findOwnedDomainAsset(req, assetId, customer), customer)
}

function confirmedFacts(asset: WestDigitalDomainAsset): WestDigitalDomainAsset {
  return {
    ...asset,
    expiresAt: new Date(asset.expiresAt).toISOString(),
    nameservers: domainAssetViewSchema.shape.nameservers.parse(asset.nameservers),
    registeredAt: new Date(asset.registeredAt).toISOString(),
  }
}

export async function syncCustomerDomainAsset(
  req: PayloadRequest,
  assetId: number | string,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalWriteProvider
    traceId: string
  },
): Promise<DomainAssetDetailResult> {
  const asset = await findOwnedDomainAsset(req, assetId, options.customer)
  const queried = await queryWestDigitalAsset(
    req,
    {
      actor: { id: options.customer.id, type: 'customer' },
      domainAscii: asset.domainAscii,
      targetId: asset.id,
      traceId: options.traceId,
    },
    options.provider,
  )
  if (queried.state !== 'ready') {
    const stale = await detailForAsset(req, asset, options.customer)
    const problem =
      'problem' in queried
        ? queried.problem
        : toProblemDetails(
            new AppError('DOMAIN_ASSET_SYNC_EMPTY', '上游未返回可确认的域名资产', 503),
            options.traceId,
          )
    return domainAssetDetailResultSchema.parse({
      data: stale.data,
      meta: {
        ...queried.meta,
        lastSuccessfulAt: new Date(asset.lastSyncedAt).toISOString(),
        stale: true,
      },
      problem,
      state: 'degraded',
    })
  }

  let facts: WestDigitalDomainAsset
  try {
    facts = confirmedFacts(queried.data)
  } catch {
    const stale = await detailForAsset(req, asset, options.customer)
    return domainAssetDetailResultSchema.parse({
      data: stale.data,
      meta: {
        lastSuccessfulAt: new Date(asset.lastSyncedAt).toISOString(),
        observedAt: queried.meta?.observedAt,
        stale: true,
        traceId: options.traceId,
      },
      problem: toProblemDetails(
        new AppError('DOMAIN_ASSET_SYNC_INVALID', '上游资产事实无法安全确认', 503),
        options.traceId,
      ),
      state: 'degraded',
    })
  }

  const updated = await transaction(req, async () => {
    const document = (await req.payload.update({
      collection: 'domainAssets',
      data: {
        expiresAt: facts.expiresAt,
        lastSyncedAt: queried.meta?.observedAt ?? new Date().toISOString(),
        nameservers: facts.nameservers,
        registeredAt: facts.registeredAt,
        registrar: facts.registrarCode,
        status: facts.status,
      },
      id: asset.id,
      overrideAccess: true,
      req,
    })) as unknown as AssetRecord
    await recordAuditEvent(req, {
      action: 'domain.asset.synced',
      actor: { id: options.customer.id, type: 'customer' },
      metadata: {
        domainAscii: asset.domainAscii,
        observedAt: queried.meta?.observedAt,
        outcome: 'succeeded',
      },
      targetId: asset.id,
    })
    return document
  })
  return detailForAsset(req, updated, options.customer)
}

export function domainAssetOwnerId(asset: AssetRecord): number | string {
  return relationId(asset.customer)
}
