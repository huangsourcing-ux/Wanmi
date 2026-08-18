import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import {
  commitTransaction,
  initTransaction,
  killTransaction,
  type PayloadRequest,
  type Where,
} from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError, toProblemDetails } from '@/lib/errors'
import type { WestDigitalDomainAsset, WestDigitalWriteProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import {
  domainAssetDetailResultSchema,
  domainAssetListResultSchema,
  domainAssetListQuerySchema,
  domainAssetViewSchema,
  type DomainAssetDetailResult,
  type DomainAssetListResult,
  type DomainAssetListQuery,
  type DomainAssetView,
} from '@/schemas/domains'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { assertCustomerAccountCapabilityFromSnapshot } from '@/services/auth/account-state'
import { queryWestDigitalAsset } from '@/services/providers/westdigital-operations'

import {
  assertDomainCapability,
  type DomainCapabilityDeclaration,
  WESTDIGITAL_DOMAIN_CAPABILITIES,
} from './capabilities'

type AssetRecord = {
  customer: number | string | { id: number | string }
  domainAscii: string
  domainLockStatus?: 'locked' | 'unlocked' | 'unknown'
  domainLockUpdatedAt?: null | string
  expiresAt: string
  expiryReminderChannels?: null | Array<'in_app' | 'sms'>
  expiryReminderDays?: null | number[]
  id: number | string
  lastSyncedAt: string
  nameservers?: null | string[]
  realnameTemplate: number | string | { id: number | string }
  registeredAt: string
  registrar: string
  status: 'active' | 'expired' | 'pending' | 'unknown'
  tags?: null | string[]
  syncReviewStatus?: 'matched' | 'none' | 'pending'
  syncVersion?: null | number
  upstreamOwnershipStatus?: 'confirmed' | 'not_owned' | 'unknown'
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
    domainLockStatus: asset.domainLockStatus ?? 'unknown',
    domainLockUpdatedAt: asset.domainLockUpdatedAt
      ? new Date(asset.domainLockUpdatedAt).toISOString()
      : undefined,
    expiresAt: new Date(asset.expiresAt).toISOString(),
    expiryReminderChannels: asset.expiryReminderChannels ?? ['in_app', 'sms'],
    expiryReminderDays: asset.expiryReminderDays ?? [30, 7, 1],
    id: String(asset.id),
    lastSyncedAt: new Date(asset.lastSyncedAt).toISOString(),
    nameservers: asset.nameservers ?? [],
    registeredAt: new Date(asset.registeredAt).toISOString(),
    registrar: asset.registrar,
    status: asset.status,
    tags: asset.tags ?? [],
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
    throw new AppError('DOMAIN_ASSET_SYNC_CAS_UNAVAILABLE', '无法原子记录域名资产同步状态', 503)
  }
  return current
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
  input: DomainAssetListQuery = domainAssetListQuerySchema.parse({}),
): Promise<DomainAssetListResult> {
  assertCustomer(req, customer)
  const filters: Where[] = [{ customer: { equals: customer.id } }]
  if (input.query) filters.push({ domainAscii: { contains: input.query } })
  if (input.status) filters.push({ status: { equals: input.status } })
  if (input.lockStatus) filters.push({ domainLockStatus: { equals: input.lockStatus } })
  if (input.tag) filters.push({ tags: { contains: input.tag } })
  if (input.expiresWithinDays !== undefined) {
    const now = new Date()
    filters.push(
      { expiresAt: { greater_than_equal: now.toISOString() } },
      {
        expiresAt: {
          less_than_equal: new Date(
            now.getTime() + input.expiresWithinDays * 86_400_000,
          ).toISOString(),
        },
      },
    )
  }
  const found = await req.payload.find({
    collection: 'domainAssets',
    depth: 0,
    limit: input.pageSize,
    overrideAccess: false,
    page: input.page,
    req,
    sort: input.sort,
    user: req.user,
    where: { and: filters },
  })
  const items = found.docs.map((document) => publicAsset(document as unknown as AssetRecord))
  return domainAssetListResultSchema.parse({
    data: {
      items,
      page: input.page,
      pageSize: input.pageSize,
      total: found.totalDocs,
      totalPages: found.totalPages,
    },
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

type SyncFacts = {
  expiresAt: string
  nameservers: string[]
  registeredAt: string
  registrar: string
  status: AssetRecord['status']
}

type SyncDifference = { field: keyof SyncFacts; local: unknown; upstream: unknown }

type SyncOutcome = 'difference' | 'matched' | 'not_owned' | 'ownership_unknown'

function normalizedNameservers(values: string[]): string[] {
  return values.map((value) => value.toLowerCase()).sort()
}

function localSyncFacts(asset: AssetRecord): SyncFacts {
  return {
    expiresAt: new Date(asset.expiresAt).toISOString(),
    nameservers: normalizedNameservers(asset.nameservers ?? []),
    registeredAt: new Date(asset.registeredAt).toISOString(),
    registrar: asset.registrar,
    status: asset.status,
  }
}

function upstreamSyncFacts(asset: WestDigitalDomainAsset): SyncFacts {
  const confirmed = confirmedFacts(asset)
  return {
    expiresAt: confirmed.expiresAt,
    nameservers: normalizedNameservers(confirmed.nameservers),
    registeredAt: confirmed.registeredAt,
    registrar: confirmed.registrarCode,
    status: confirmed.status,
  }
}

function factDifferences(local: SyncFacts, upstream: SyncFacts): SyncDifference[] {
  const differences: SyncDifference[] = []
  for (const field of [
    'expiresAt',
    'nameservers',
    'registeredAt',
    'registrar',
    'status',
  ] as const) {
    if (JSON.stringify(local[field]) !== JSON.stringify(upstream[field])) {
      differences.push({ field, local: local[field], upstream: upstream[field] })
    }
  }
  return differences
}

async function recordSyncObservation(
  req: PayloadRequest,
  input: {
    actor: { id: number | string; type: 'customer' } | { type: 'system' }
    asset: AssetRecord
    differences?: SyncDifference[]
    localFacts: SyncFacts
    observedAt: string
    outcome: SyncOutcome
    providerErrorCode?: string
    traceId: string
    upstreamFacts?: SyncFacts
  },
): Promise<AssetRecord> {
  return transaction(req, async () => {
    const event = await req.payload.create({
      collection: 'domainAssetSyncEvents',
      data: {
        asset: input.asset.id as never,
        customer: relationId(input.asset.customer) as never,
        differences: input.differences,
        eventKey: `domain-sync:${input.asset.id}:${input.observedAt}:${input.outcome}:${randomUUID()}`,
        localFacts: input.localFacts,
        observedAt: input.observedAt,
        outcome: input.outcome,
        providerErrorCode: input.providerErrorCode,
        resolutionStatus: input.outcome === 'matched' ? 'not_required' : 'pending',
        traceId: input.traceId,
        upstreamFacts: input.upstreamFacts,
      },
      overrideAccess: true,
      req,
    })
    const ownership =
      input.outcome === 'matched' || input.outcome === 'difference'
        ? 'confirmed'
        : input.outcome === 'not_owned'
          ? 'not_owned'
          : 'unknown'
    const review = input.outcome === 'matched' ? 'matched' : 'pending'
    const blocked = ownership === 'confirmed' ? null : input.observedAt
    const reason =
      ownership === 'not_owned'
        ? 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED'
        : ownership === 'unknown'
          ? 'DOMAIN_UPSTREAM_OWNERSHIP_UNCONFIRMED'
          : null
    const updated = await (
      await database(req)
    ).execute(sql`
      UPDATE domain_assets
      SET upstream_ownership_status = ${ownership},
          sync_review_status = ${review},
          sync_version = sync_version + 1,
          last_ownership_checked_at = ${input.observedAt},
          operation_blocked_at = ${blocked},
          operation_block_reason = ${reason},
          last_synced_at = CASE
            WHEN ${input.outcome} = 'matched' THEN ${input.observedAt}
            ELSE last_synced_at
          END,
          updated_at = NOW()
      WHERE id = ${input.asset.id}
        AND sync_version = ${input.asset.syncVersion ?? 0}
        AND (
          domain_management_lease_key IS NULL
          OR domain_management_lease_expires_at <= NOW()
        )
      RETURNING id
    `)
    if (updated.rows?.[0]?.id === undefined) {
      throw new AppError('DOMAIN_ASSET_SYNC_STATE_CONFLICT', '域名资产同步状态发生并发冲突', 409)
    }
    await recordAuditEvent(req, {
      action: 'domain.asset_sync.observation_recorded',
      actor: input.actor,
      metadata: {
        differenceFields: input.differences?.map((difference) => difference.field),
        outcome: input.outcome,
        providerErrorCode: input.providerErrorCode,
      },
      targetId: event.id,
    })
    return (await req.payload.findByID({
      collection: 'domainAssets',
      depth: 0,
      id: input.asset.id,
      overrideAccess: true,
      req,
    })) as unknown as AssetRecord
  })
}

async function observeDomainAsset(
  req: PayloadRequest,
  asset: AssetRecord,
  input: {
    actor: { id: number | string; type: 'customer' } | { type: 'system' }
    provider: WestDigitalWriteProvider
    traceId: string
  },
) {
  const localFacts = localSyncFacts(asset)
  const queried = await queryWestDigitalAsset(
    req,
    {
      actor: input.actor,
      domainAscii: asset.domainAscii,
      targetId: asset.id,
      traceId: input.traceId,
    },
    input.provider,
  )
  const observedAt = queried.meta?.observedAt ?? new Date().toISOString()
  if (queried.state !== 'ready') {
    const providerErrorCode =
      'problem' in queried ? queried.problem.code : 'DOMAIN_ASSET_SYNC_EMPTY'
    const outcome: SyncOutcome =
      providerErrorCode === 'WESTDIGITAL_ASSET_NOT_IN_ACCOUNT' ? 'not_owned' : 'ownership_unknown'
    const updated = await recordSyncObservation(req, {
      actor: input.actor,
      asset,
      localFacts,
      observedAt,
      outcome,
      providerErrorCode,
      traceId: input.traceId,
    })
    return { outcome, providerErrorCode, queried, updated } as const
  }
  let upstreamFacts: SyncFacts
  try {
    upstreamFacts = upstreamSyncFacts(queried.data)
  } catch {
    const providerErrorCode = 'DOMAIN_ASSET_SYNC_INVALID'
    const outcome = 'ownership_unknown' as const
    const updated = await recordSyncObservation(req, {
      actor: input.actor,
      asset,
      localFacts,
      observedAt,
      outcome,
      providerErrorCode,
      traceId: input.traceId,
    })
    return { outcome, providerErrorCode, queried, updated } as const
  }
  const differences = factDifferences(localFacts, upstreamFacts)
  const outcome = differences.length ? ('difference' as const) : ('matched' as const)
  const updated = await recordSyncObservation(req, {
    actor: input.actor,
    asset,
    differences,
    localFacts,
    observedAt,
    outcome,
    traceId: input.traceId,
    upstreamFacts,
  })
  return { differences, outcome, queried, updated } as const
}

export async function syncCustomerDomainAsset(
  req: PayloadRequest,
  assetId: number | string,
  options: {
    capabilities?: DomainCapabilityDeclaration
    customer: CustomerIdentity
    provider: WestDigitalWriteProvider
    traceId: string
  },
): Promise<DomainAssetDetailResult> {
  assertDomainCapability('asset_sync', options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES)
  const asset = await findOwnedDomainAsset(req, assetId, options.customer)
  const observation = await observeDomainAsset(req, asset, {
    actor: { id: options.customer.id, type: 'customer' },
    provider: options.provider,
    traceId: options.traceId,
  })
  const detail = await detailForAsset(req, observation.updated, options.customer)
  if (observation.outcome === 'matched') return detail
  const code =
    observation.outcome === 'difference'
      ? 'DOMAIN_ASSET_SYNC_DIFFERENCE_PENDING'
      : observation.outcome === 'not_owned'
        ? 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED'
        : 'DOMAIN_UPSTREAM_OWNERSHIP_UNCONFIRMED'
  return domainAssetDetailResultSchema.parse({
    data: detail.data,
    meta: {
      lastSuccessfulAt: new Date(asset.lastSyncedAt).toISOString(),
      observedAt: observation.queried.meta?.observedAt,
      stale: true,
      traceId: options.traceId,
    },
    problem: toProblemDetails(
      new AppError(
        code,
        code === 'DOMAIN_ASSET_SYNC_DIFFERENCE_PENDING'
          ? '本地与上游域名事实不一致，已记录差异并等待处理'
          : code === 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED'
            ? '该域名已不属于当前上游账户，已阻止操作'
            : '无法确认域名仍属于当前上游账户，已阻止操作',
        409,
      ),
      options.traceId,
    ),
    state: 'degraded',
  })
}

export async function runDomainAssetSynchronization(
  req: PayloadRequest,
  provider: WestDigitalWriteProvider,
  traceId: string,
  capabilities: DomainCapabilityDeclaration = WESTDIGITAL_DOMAIN_CAPABILITIES,
) {
  if (req.user) {
    throw new AppError('DOMAIN_ASSET_SYNC_JOB_ONLY', '域名资产全量同步只能由后台任务执行', 403)
  }
  assertDomainCapability('asset_sync', capabilities)
  const counts: Record<SyncOutcome, number> = {
    difference: 0,
    matched: 0,
    not_owned: 0,
    ownership_unknown: 0,
  }
  let page = 1
  while (true) {
    const assets = await req.payload.find({
      collection: 'domainAssets',
      depth: 0,
      limit: 100,
      overrideAccess: true,
      page,
      req,
      sort: 'id',
    })
    for (const document of assets.docs) {
      const asset = document as unknown as AssetRecord
      const observation = await observeDomainAsset(req, asset, {
        actor: { type: 'system' },
        provider,
        traceId: `${traceId}-asset-${asset.id}`,
      })
      counts[observation.outcome] += 1
    }
    if (!assets.hasNextPage) break
    page += 1
  }
  return counts
}

export async function runConfiguredDomainAssetSynchronization(
  req: PayloadRequest,
  traceId: string,
) {
  return runDomainAssetSynchronization(req, createConfiguredWestDigitalWriteAdapter(), traceId)
}

export function domainAssetOwnerId(asset: AssetRecord): number | string {
  return relationId(asset.customer)
}
