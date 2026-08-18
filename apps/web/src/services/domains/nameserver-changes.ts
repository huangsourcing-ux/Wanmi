import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { normalizeDomain } from '@/lib/domain-name'
import { getEnv } from '@/lib/env'
import { AppError, toProblemDetails } from '@/lib/errors'
import type { WestDigitalWriteProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import {
  nameserverChangeResultSchema,
  nameserverChangeViewSchema,
  nameserverBatchPreviewResultSchema,
  nameserverBatchResultSchema,
  type NameserverBatchPreviewRequest,
  type NameserverBatchRequest,
  type NameserverChangeRequest,
  type NameserverChangeView,
} from '@/schemas/domains'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import { authorizeStepUpGrant } from '@/services/auth/step-up'
import {
  executeWestDigitalWriteOperation,
  queryWestDigitalAsset,
  type WestDigitalWriteOperationInput,
} from '@/services/providers/westdigital-operations'

import { findOwnedDomainAsset } from './domain-assets'
import { decodeBoundChangePreview, signBoundChangePreview } from './change-preview'

type CustomerIdentity = {
  collection: 'customers'
  id: number | string
  status?: string | null
}

type ChangeRecord = {
  asset: number | string | { id: number | string }
  changeKey?: null | string
  completedAt?: null | string
  confirmedNameservers?: null | string[]
  customer: number | string | { id: number | string }
  failureCode?: null | string
  id: number | string
  previousNameservers?: null | string[]
  providerOperation?: null | number | string | { id: number | string }
  requestedAt?: null | string
  requestedById?: null | string
  requestedNameservers: string[]
  status: 'failed' | 'manual_review' | 'pending' | 'succeeded'
}

type BatchAsset = Awaited<ReturnType<typeof findOwnedDomainAsset>> & {
  lastSyncedAt?: null | string
  status?: null | string
  syncVersion?: null | number
}

type BatchEventRecord = {
  asset: number | string | { id: number | string }
  batchKey: string
  customer: number | string | { id: number | string }
  event: 'confirmed' | 'failed' | 'pending_query' | 'requested'
  id: number | string
  itemKey: string
  nameserverChange: number | string | { id: number | string }
  reasonCode?: null | string
}

type NameserverBatchPreviewPayload = {
  assetDigest: string
  assetIds: string[]
  batchKey: string
  customerId: string
  expiresAt: string
  kind: 'nameserver_batch_change'
  nameservers: string[]
  version: 1
}

export type NameserverChangeJobInput = {
  assetId: number
  changeId: number
  operationKey: string
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
    throw new AppError('NAMESERVER_CHANGE_CAS_UNAVAILABLE', '无法原子执行 Name Server 变更', 503)
  }
  return current
}

function normalizeNameservers(values: string[]): string[] {
  const normalized = values.map((value) => {
    const domain = normalizeDomain(value)
    if (!domain.ok || domain.value.ascii !== value.trim().toLowerCase()) {
      throw new AppError('NAMESERVER_INVALID', 'Name Server 格式无效', 400)
    }
    return domain.value.ascii
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new AppError('NAMESERVER_DUPLICATE', 'Name Server 不得重复', 400)
  }
  return normalized
}

function changeKey(assetId: number | string, nameservers: string[]): string {
  return `nameserver:${assetId}:${createHash('sha256').update(nameservers.join('\n')).digest('hex')}`
}

function uniqueAssetIds(assetIds: number[]): number[] {
  const unique = [...new Set(assetIds)]
  if (unique.length !== assetIds.length) {
    throw new AppError('NAMESERVER_BATCH_DUPLICATE_ASSET', '批量 Name Server 资产不得重复', 400)
  }
  return unique.sort((left, right) => left - right)
}

async function loadBatchAssets(
  req: PayloadRequest,
  assetIds: number[],
  customer: CustomerIdentity,
): Promise<BatchAsset[]> {
  return Promise.all(
    assetIds.map((assetId) => findOwnedDomainAsset(req, assetId, customer) as Promise<BatchAsset>),
  )
}

function batchAssetDigest(assets: BatchAsset[], nameservers: string[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        assets: [...assets]
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((asset) => ({
            domainAscii: asset.domainAscii,
            id: String(asset.id),
            lastSyncedAt: asset.lastSyncedAt,
            nameservers: asset.nameservers,
            status: asset.status,
            syncVersion: asset.syncVersion,
          })),
        nameservers,
      }),
    )
    .digest('hex')
}

function verifyNameserverBatchPreview(
  token: string,
  input: {
    assetIds: number[]
    batchKey: string
    customerId: number | string
    nameservers: string[]
  },
): NameserverBatchPreviewPayload {
  const parsed = decodeBoundChangePreview(token, {
    code: 'NAMESERVER_BATCH_PREVIEW_INVALID',
    message: '批量 Name Server 预览无效或已被修改',
  }) as Partial<NameserverBatchPreviewPayload>
  if (
    parsed.version !== 1 ||
    parsed.kind !== 'nameserver_batch_change' ||
    parsed.customerId !== String(input.customerId) ||
    parsed.batchKey !== input.batchKey ||
    !parsed.expiresAt ||
    new Date(parsed.expiresAt).getTime() <= Date.now() ||
    JSON.stringify(parsed.assetIds) !== JSON.stringify(input.assetIds.map(String)) ||
    JSON.stringify(parsed.nameservers) !== JSON.stringify(input.nameservers)
  ) {
    throw new AppError('NAMESERVER_BATCH_PREVIEW_INVALID', '批量 Name Server 预览无效或已过期', 409)
  }
  return parsed as NameserverBatchPreviewPayload
}

async function findBatchEvent(
  req: PayloadRequest,
  eventKey: string,
): Promise<BatchEventRecord | undefined> {
  const found = await req.payload.find({
    collection: 'domainBatchOperationEvents',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { eventKey: { equals: eventKey } },
  })
  return found.docs[0] as unknown as BatchEventRecord | undefined
}

async function appendBatchEvent(
  req: PayloadRequest,
  input: {
    assetId: number | string
    batchKey: string
    changeId: number | string
    customerId: number | string
    event: BatchEventRecord['event']
    itemKey: string
    reasonCode?: string
    traceId: string
  },
): Promise<BatchEventRecord> {
  const eventKey = `${input.batchKey}:${input.itemKey}:${input.event}`
  const existing = await findBatchEvent(req, eventKey)
  if (existing) return existing
  try {
    return (await req.payload.create({
      collection: 'domainBatchOperationEvents',
      data: {
        asset: input.assetId as never,
        batchKey: input.batchKey,
        customer: input.customerId as never,
        event: input.event,
        eventKey,
        itemKey: input.itemKey,
        nameserverChange: input.changeId as never,
        occurredAt: new Date().toISOString(),
        operation: 'nameserver_change',
        reasonCode: input.reasonCode,
        traceId: input.traceId,
      },
      overrideAccess: true,
      req,
    })) as unknown as BatchEventRecord
  } catch (error) {
    const raced = await findBatchEvent(req, eventKey)
    if (raced) return raced
    throw error
  }
}

function view(change: ChangeRecord): NameserverChangeView {
  return nameserverChangeViewSchema.parse({
    completedAt: change.completedAt ? new Date(change.completedAt).toISOString() : undefined,
    confirmedNameservers: change.confirmedNameservers ?? undefined,
    id: String(change.id),
    previousNameservers: change.previousNameservers ?? change.requestedNameservers,
    requestedAt: new Date(change.requestedAt ?? new Date()).toISOString(),
    requestedNameservers: change.requestedNameservers,
    status: change.status,
  })
}

async function loadChange(req: PayloadRequest, changeId: number | string): Promise<ChangeRecord> {
  return (await req.payload.findByID({
    collection: 'nameserverChanges',
    depth: 0,
    id: changeId,
    overrideAccess: true,
    req,
  })) as unknown as ChangeRecord
}

async function findChange(req: PayloadRequest, key: string): Promise<ChangeRecord | undefined> {
  const found = await req.payload.find({
    collection: 'nameserverChanges',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { changeKey: { equals: key } },
  })
  return found.docs[0] as unknown as ChangeRecord | undefined
}

async function prepareChange(
  req: PayloadRequest,
  input: {
    asset: Awaited<ReturnType<typeof findOwnedDomainAsset>>
    customer: CustomerIdentity
    nameservers: string[]
    traceId: string
  },
): Promise<ChangeRecord> {
  const key = changeKey(input.asset.id, input.nameservers)
  const existing = await findChange(req, key)
  if (existing) return existing
  try {
    return await transaction(req, async () => {
      const created = (await req.payload.create({
        collection: 'nameserverChanges',
        data: {
          asset: input.asset.id as never,
          changeKey: key,
          createdTraceId: input.traceId,
          customer: input.customer.id as never,
          previousNameservers: input.asset.nameservers ?? [],
          requestedAt: new Date().toISOString(),
          requestedById: String(input.customer.id),
          requestedByType: 'customer',
          requestedNameservers: input.nameservers,
          status: 'pending',
        },
        overrideAccess: true,
        req,
      })) as unknown as ChangeRecord
      await recordAuditEvent(req, {
        action: 'domain.nameserver.change_recorded',
        actor: { id: input.customer.id, type: 'customer' },
        metadata: {
          after: input.nameservers,
          before: input.asset.nameservers,
          domainAscii: input.asset.domainAscii,
          outcome: 'requested',
          requestedAt: created.requestedAt,
        },
        targetId: created.id,
      })
      return created
    })
  } catch (error) {
    const raced = await findChange(req, key)
    if (raced) return raced
    throw error
  }
}

async function enqueueChange(
  req: PayloadRequest,
  change: ChangeRecord,
  traceId: string,
): Promise<{ idempotentReplay: boolean; jobId?: number | string }> {
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE nameserver_changes
      SET job_queued_at = NOW(), updated_at = NOW()
      WHERE id = ${change.id}
        AND status = 'pending'
        AND job_queued_at IS NULL
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) return { idempotentReplay: true }
    const operationKey = `nameserver-change:${change.id}`
    const job = await req.payload.jobs.queue({
      input: {
        assetId: Number(relationId(change.asset)),
        changeId: Number(change.id),
        operationKey,
        traceId,
      },
      overrideAccess: true,
      queue: 'commerce',
      req,
      workflow: 'nameserverChange',
    })
    return { idempotentReplay: false, jobId: job.id }
  })
}

export async function requestCustomerNameserverChange(
  req: PayloadRequest,
  assetId: number | string,
  input: NameserverChangeRequest,
  options: { customer: CustomerIdentity; traceId: string },
) {
  return transaction(req, async () => {
    await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
    if (input.confirmed !== true) {
      throw new AppError('NAMESERVER_CONFIRMATION_REQUIRED', 'Name Server 变更需要二次确认', 400)
    }
    await authorizeStepUpGrant(req, {
      customerId: options.customer.id,
      deviceId: input.deviceId,
      headers: req.headers,
      purpose: 'nameserver_change',
      stepUpToken: input.stepUpToken,
    })
    const asset = await findOwnedDomainAsset(req, assetId, options.customer)
    const nameservers = normalizeNameservers(input.nameservers)
    const change = await prepareChange(req, {
      asset,
      customer: options.customer,
      nameservers,
      traceId: options.traceId,
    })
    await enqueueChange(req, change, options.traceId)
    return nameserverChangeResultSchema.parse({
      data: view(await loadChange(req, change.id)),
      meta: { dataSource: 'local', traceId: options.traceId },
      state: 'ready',
    })
  })
}

export async function previewCustomerNameserverBatchChange(
  req: PayloadRequest,
  input: NameserverBatchPreviewRequest,
  options: { customer: CustomerIdentity; traceId: string },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const assetIds = uniqueAssetIds(input.assetIds)
  const nameservers = normalizeNameservers(input.nameservers)
  const assets = await loadBatchAssets(req, assetIds, options.customer)
  const expiresAt = new Date(
    Date.now() + getEnv().DNS_RECORD_PREVIEW_TTL_SECONDS * 1_000,
  ).toISOString()
  const previewToken = signBoundChangePreview({
    assetDigest: batchAssetDigest(assets, nameservers),
    assetIds: assetIds.map(String),
    batchKey: input.batchKey,
    customerId: String(options.customer.id),
    expiresAt,
    kind: 'nameserver_batch_change',
    nameservers,
    version: 1,
  } satisfies NameserverBatchPreviewPayload)
  return nameserverBatchPreviewResultSchema.parse({
    data: {
      batchKey: input.batchKey,
      expiresAt,
      items: assets.map((asset) => ({
        assetId: String(asset.id),
        currentNameservers: asset.nameservers,
        domainAscii: asset.domainAscii,
        requestedNameservers: nameservers,
      })),
      previewToken,
    },
    meta: { dataSource: 'local', traceId: options.traceId },
    state: 'ready',
  })
}

function nameserverBatchItem(asset: BatchAsset, change: ChangeRecord) {
  return {
    assetId: String(asset.id),
    changeId: String(change.id),
    domainAscii: asset.domainAscii,
    itemKey: change.changeKey ?? changeKey(asset.id, change.requestedNameservers),
    reasonCode: change.failureCode ?? undefined,
    status:
      change.status === 'succeeded'
        ? ('succeeded' as const)
        : change.status === 'failed'
          ? ('failed' as const)
          : ('pending_query' as const),
  }
}

function nameserverBatchResult(
  batchKey: string,
  items: Array<
    | ReturnType<typeof nameserverBatchItem>
    | {
        assetId: string
        domainAscii: string
        itemKey: string
        reasonCode: string
        status: 'failed'
      }
  >,
  traceId: string,
) {
  const data = { batchKey, items }
  if (items.every((item) => item.status === 'succeeded')) {
    return nameserverBatchResultSchema.parse({
      data,
      meta: { dataSource: 'local', traceId },
      state: 'ready',
    })
  }
  return nameserverBatchResultSchema.parse({
    data,
    meta: { dataSource: 'local', traceId },
    problem: toProblemDetails(
      new AppError(
        'NAMESERVER_BATCH_PARTIAL',
        '批量 Name Server 操作包含失败或待查询条目，逐条状态已返回',
        503,
      ),
      traceId,
    ),
    state: 'partial',
  })
}

export async function requestCustomerNameserverBatchChange(
  req: PayloadRequest,
  input: NameserverBatchRequest,
  options: { customer: CustomerIdentity; traceId: string },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  if (!input.previewToken) {
    throw new AppError('NAMESERVER_BATCH_PREVIEW_REQUIRED', '批量 Name Server 需要变更预览', 400)
  }
  if (input.confirmed !== true) {
    throw new AppError('NAMESERVER_CONFIRMATION_REQUIRED', 'Name Server 变更需要二次确认', 400)
  }
  if (!input.deviceId || !input.stepUpToken) {
    throw new AppError('STEP_UP_GRANT_REQUIRED', '批量 Name Server 需要 step-up 授权', 403)
  }
  await authorizeStepUpGrant(req, {
    customerId: options.customer.id,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: 'nameserver_change',
    stepUpToken: input.stepUpToken,
  })
  const assetIds = uniqueAssetIds(input.assetIds)
  const nameservers = normalizeNameservers(input.nameservers)
  const preview = verifyNameserverBatchPreview(input.previewToken, {
    assetIds,
    batchKey: input.batchKey,
    customerId: options.customer.id,
    nameservers,
  })
  const assets = await loadBatchAssets(req, assetIds, options.customer)
  if (batchAssetDigest(assets, nameservers) !== preview.assetDigest) {
    throw new AppError(
      'NAMESERVER_BATCH_PREVIEW_STALE',
      'Name Server 目标资产已变化，请重新预览',
      409,
    )
  }
  const items = []
  for (const [index, asset] of assets.entries()) {
    const itemKey = changeKey(asset.id, nameservers)
    let change: ChangeRecord | undefined
    try {
      change = await prepareChange(req, {
        asset,
        customer: options.customer,
        nameservers,
        traceId: `${options.traceId}-item-${index + 1}`,
      })
      await appendBatchEvent(req, {
        assetId: asset.id,
        batchKey: input.batchKey,
        changeId: change.id,
        customerId: options.customer.id,
        event: 'requested',
        itemKey,
        traceId: `${options.traceId}-item-${index + 1}`,
      })
      await enqueueChange(req, change, `${options.traceId}-item-${index + 1}`)
      const current = await loadChange(req, change.id)
      const item = nameserverBatchItem(asset, current)
      await appendBatchEvent(req, {
        assetId: asset.id,
        batchKey: input.batchKey,
        changeId: change.id,
        customerId: options.customer.id,
        event:
          item.status === 'succeeded'
            ? 'confirmed'
            : item.status === 'failed'
              ? 'failed'
              : 'pending_query',
        itemKey,
        reasonCode: item.reasonCode,
        traceId: `${options.traceId}-item-${index + 1}`,
      })
      items.push(item)
    } catch (error) {
      const problem = toProblemDetails(error, `${options.traceId}-item-${index + 1}`)
      if (change) {
        const failed = await completeFailure(req, change, asset.id, {
          actorId: String(options.customer.id),
          failureCode: problem.code,
          manualReview: false,
          traceId: `${options.traceId}-item-${index + 1}`,
        })
        await appendBatchEvent(req, {
          assetId: asset.id,
          batchKey: input.batchKey,
          changeId: failed.id,
          customerId: options.customer.id,
          event: 'failed',
          itemKey,
          reasonCode: problem.code,
          traceId: `${options.traceId}-item-${index + 1}`,
        })
      }
      items.push({
        assetId: String(asset.id),
        domainAscii: asset.domainAscii,
        itemKey,
        reasonCode: problem.code,
        status: 'failed' as const,
      })
    }
  }
  return nameserverBatchResult(input.batchKey, items, options.traceId)
}

export async function queryCustomerNameserverBatchChange(
  req: PayloadRequest,
  batchKey: string,
  options: { customer: CustomerIdentity; traceId: string },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const found = await req.payload.find({
    collection: 'domainBatchOperationEvents',
    depth: 0,
    limit: 20,
    overrideAccess: false,
    req,
    sort: 'asset',
    user: options.customer as never,
    where: {
      and: [
        { batchKey: { equals: batchKey } },
        { customer: { equals: options.customer.id } },
        { event: { equals: 'requested' } },
        { operation: { equals: 'nameserver_change' } },
      ],
    },
  })
  const events = found.docs as unknown as BatchEventRecord[]
  if (events.length < 2) {
    throw new AppError('NAMESERVER_BATCH_NOT_FOUND', '未找到可查询的批量 Name Server 任务', 404)
  }
  const items = []
  for (const [index, event] of events.entries()) {
    const asset = (await findOwnedDomainAsset(
      req,
      relationId(event.asset),
      options.customer,
    )) as BatchAsset
    const change = await loadChange(req, relationId(event.nameserverChange))
    const item = nameserverBatchItem(asset, change)
    const itemKey = change.changeKey ?? changeKey(asset.id, change.requestedNameservers)
    await appendBatchEvent(req, {
      assetId: asset.id,
      batchKey,
      changeId: change.id,
      customerId: options.customer.id,
      event:
        item.status === 'succeeded'
          ? 'confirmed'
          : item.status === 'failed'
            ? 'failed'
            : 'pending_query',
      itemKey,
      reasonCode: item.reasonCode,
      traceId: `${options.traceId}-query-${index + 1}`,
    })
    items.push(item)
  }
  return nameserverBatchResult(batchKey, items, options.traceId)
}

export async function enqueueNameserverReviewQuery(
  req: PayloadRequest,
  changeId: number | string,
  traceId: string,
) {
  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可重新查询 Name Server 状态', 403)
  }
  const actor = req.user
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE nameserver_changes
      SET review_job_queued_at = NOW(), updated_at = NOW()
      WHERE id = ${changeId}
        AND status = 'manual_review'
        AND review_job_queued_at IS NULL
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      const current = await loadChange(req, changeId)
      if (current.status !== 'manual_review') {
        throw new AppError(
          'NAMESERVER_CHANGE_NOT_REVIEWABLE',
          '该 Name Server 变更无需重新查询',
          409,
        )
      }
      return { idempotentReplay: true }
    }
    const change = await loadChange(req, changeId)
    const operationKey = `nameserver-change:${change.id}`
    const job = await req.payload.jobs.queue({
      input: {
        assetId: Number(relationId(change.asset)),
        changeId: Number(change.id),
        operationKey,
        traceId,
      },
      overrideAccess: true,
      queue: 'commerce',
      req,
      workflow: 'nameserverChange',
    })
    await recordAuditEvent(req, {
      action: 'domain.nameserver.change_recorded',
      actor: { id: actor.id, type: 'admin' },
      metadata: { operationKey, outcome: 'review_query_queued' },
      targetId: change.id,
    })
    return { idempotentReplay: false, jobId: job.id }
  })
}

async function ensureManualReview(
  req: PayloadRequest,
  change: ChangeRecord,
  assetId: number | string,
  reasonCode: string,
  evidence: Record<string, unknown>,
) {
  const existing = await req.payload.find({
    collection: 'manualReviews',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ nameserverChange: { equals: change.id } }, { status: { equals: 'open' } }],
    },
  })
  if (!existing.totalDocs) {
    await req.payload.create({
      collection: 'manualReviews',
      data: {
        domainAsset: assetId as never,
        evidence,
        nameserverChange: change.id as never,
        reasonCode,
        status: 'open',
      },
      overrideAccess: true,
      req,
    })
  }
}

async function completeFailure(
  req: PayloadRequest,
  change: ChangeRecord,
  assetId: number | string,
  input: {
    actorId: string
    failureCode: string
    manualReview: boolean
    operationId?: string
    traceId: string
  },
) {
  const next = input.manualReview ? 'manual_review' : 'failed'
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE nameserver_changes
      SET status = ${next}, last_checked_at = NOW(), updated_at = NOW()
      WHERE id = ${change.id}
        AND status IN ('pending', 'manual_review')
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) return loadChange(req, change.id)
    const updated = (await req.payload.update({
      collection: 'nameserverChanges',
      data: {
        failureCode: input.failureCode,
        lastCheckedAt: new Date().toISOString(),
        providerOperation: input.operationId ? (Number(input.operationId) as never) : undefined,
        reviewJobQueuedAt: input.manualReview ? null : undefined,
      },
      id: change.id,
      overrideAccess: true,
      req,
    })) as unknown as ChangeRecord
    if (input.manualReview) {
      await ensureManualReview(req, updated, assetId, 'nameserver.provider_status_unknown', {
        operationId: input.operationId,
        traceId: input.traceId,
      })
    }
    await recordAuditEvent(req, {
      action: 'domain.nameserver.change_recorded',
      actor: { id: input.actorId, type: 'customer' },
      metadata: {
        after: change.requestedNameservers,
        before: change.previousNameservers,
        failureCode: input.failureCode,
        outcome: next,
      },
      targetId: change.id,
    })
    return updated
  })
}

async function completeSuccess(
  req: PayloadRequest,
  change: ChangeRecord,
  asset: Awaited<ReturnType<typeof findOwnedDomainAsset>>,
  confirmed: {
    expiresAt: string
    nameservers: string[]
    registeredAt: string
    registrarCode: string
    status: 'active' | 'expired' | 'pending' | 'unknown'
  },
  input: { actorId: string; operationId: string },
) {
  return transaction(req, async () => {
    const changed = await (
      await database(req)
    ).execute(sql`
      UPDATE nameserver_changes
      SET status = 'succeeded', completed_at = NOW(), last_checked_at = NOW(), updated_at = NOW()
      WHERE id = ${change.id}
        AND status IN ('pending', 'manual_review')
      RETURNING id
    `)
    if (changed.rows?.[0]?.id === undefined) return loadChange(req, change.id)
    const completedAt = new Date().toISOString()
    const updated = (await req.payload.update({
      collection: 'nameserverChanges',
      data: {
        completedAt,
        confirmedNameservers: confirmed.nameservers,
        failureCode: null,
        lastCheckedAt: completedAt,
        providerOperation: Number(input.operationId) as never,
      },
      id: change.id,
      overrideAccess: true,
      req,
    })) as unknown as ChangeRecord
    await req.payload.update({
      collection: 'domainAssets',
      data: {
        expiresAt: confirmed.expiresAt,
        lastSyncedAt: completedAt,
        nameservers: confirmed.nameservers,
        registeredAt: confirmed.registeredAt,
        registrar: confirmed.registrarCode,
        status: confirmed.status,
      },
      id: asset.id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'domain.nameserver.change_recorded',
      actor: { id: input.actorId, type: 'customer' },
      metadata: {
        after: confirmed.nameservers,
        before: change.previousNameservers,
        completedAt,
        outcome: 'succeeded',
      },
      targetId: change.id,
    })
    return updated
  })
}

export async function runNameserverChange(
  req: PayloadRequest,
  input: NameserverChangeJobInput,
  provider: WestDigitalWriteProvider,
) {
  let change = await loadChange(req, input.changeId)
  if (change.status === 'succeeded' || change.status === 'failed') return view(change)
  const customer = (await req.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: relationId(change.customer),
    overrideAccess: true,
    req,
  })) as CustomerIdentity
  const asset = (await req.payload.findByID({
    collection: 'domainAssets',
    depth: 0,
    id: input.assetId,
    overrideAccess: true,
    req,
  })) as Awaited<ReturnType<typeof findOwnedDomainAsset>>
  if (String(relationId(asset.customer)) !== String(customer.id)) {
    throw new AppError('DOMAIN_ASSET_OWNERSHIP_MISMATCH', '域名资产归属不一致', 409)
  }
  const actorId = change.requestedById ?? String(customer.id)

  if (!change.providerOperation) {
    const before = await queryWestDigitalAsset(
      req,
      {
        actor: { id: actorId, type: 'customer' },
        domainAscii: asset.domainAscii,
        targetId: asset.id,
        traceId: `${input.traceId}-preflight`,
      },
      provider,
    )
    if (before.state !== 'ready') {
      change = await completeFailure(req, change, asset.id, {
        actorId,
        failureCode: 'problem' in before ? before.problem.code : 'WESTDIGITAL_ASSET_NOT_FOUND',
        manualReview: true,
        traceId: input.traceId,
      })
      return view(change)
    }
    change = (await req.payload.update({
      collection: 'nameserverChanges',
      data: { previousNameservers: before.data.nameservers },
      id: change.id,
      overrideAccess: true,
      req,
    })) as unknown as ChangeRecord
  }

  const writeInput: WestDigitalWriteOperationInput = {
    actor: { id: actorId, type: 'customer' },
    domainAscii: asset.domainAscii,
    nameservers: change.requestedNameservers,
    operation: 'nameserver',
    targetId: asset.id,
    traceId: input.traceId,
  }
  let operation
  try {
    operation = await executeWestDigitalWriteOperation(req, writeInput, provider)
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      !['DOMAIN_UPSTREAM_ASSET_NOT_OWNED', 'DOMAIN_UPSTREAM_OWNERSHIP_UNCONFIRMED'].includes(
        error.code,
      )
    ) {
      throw error
    }
    change = await completeFailure(req, change, asset.id, {
      actorId,
      failureCode: error.code,
      manualReview: error.code === 'DOMAIN_UPSTREAM_OWNERSHIP_UNCONFIRMED',
      traceId: input.traceId,
    })
    return view(change)
  }
  const operationData = 'data' in operation ? operation.data : undefined
  if (operation.state === 'error') {
    change = await completeFailure(req, change, asset.id, {
      actorId,
      failureCode: operation.problem.code,
      manualReview: false,
      operationId: operationData?.operationId,
      traceId: input.traceId,
    })
    return view(change)
  }
  if (operation.state !== 'ready' || !operationData || operationData.status !== 'succeeded') {
    change = await completeFailure(req, change, asset.id, {
      actorId,
      failureCode: 'WESTDIGITAL_STATUS_UNKNOWN',
      manualReview: true,
      operationId: operationData?.operationId,
      traceId: input.traceId,
    })
    return view(change)
  }

  const confirmed = await queryWestDigitalAsset(
    req,
    {
      actor: { id: actorId, type: 'customer' },
      domainAscii: asset.domainAscii,
      targetId: asset.id,
      traceId: `${input.traceId}-confirm`,
    },
    provider,
  )
  const requested = new Set(change.requestedNameservers)
  if (
    confirmed.state !== 'ready' ||
    !change.requestedNameservers.every((nameserver) =>
      new Set(confirmed.data.nameservers).has(nameserver),
    ) ||
    requested.size !== change.requestedNameservers.length
  ) {
    change = await completeFailure(req, change, asset.id, {
      actorId,
      failureCode:
        confirmed.state === 'ready'
          ? 'NAMESERVER_CONFIRMATION_MISMATCH'
          : 'problem' in confirmed
            ? confirmed.problem.code
            : 'WESTDIGITAL_ASSET_NOT_FOUND',
      manualReview: true,
      operationId: operationData.operationId,
      traceId: input.traceId,
    })
    return view(change)
  }
  change = await completeSuccess(req, change, asset, confirmed.data, {
    actorId,
    operationId: operationData.operationId,
  })
  return view(change)
}

export async function runConfiguredNameserverChange(
  req: PayloadRequest,
  input: NameserverChangeJobInput,
) {
  return runNameserverChange(req, input, createConfiguredWestDigitalWriteAdapter())
}
