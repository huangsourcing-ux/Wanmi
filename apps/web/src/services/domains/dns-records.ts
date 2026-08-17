import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hmac, safeEqualHex } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError, toProblemDetails } from '@/lib/errors'
import type { ProviderResult } from '@/lib/domain'
import type {
  WestDigitalDnsRecord,
  WestDigitalDnsRecordInput,
  WestDigitalDnsRecordPage,
  WestDigitalManagedProvider,
} from '@/providers/types'
import { westDigitalDnsLineCode, westDigitalDnsLineLabel } from '@/providers/westdigital-dns'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import type { Result } from '@/schemas/api'
import {
  dnsRecordBatchDeleteResultSchema,
  dnsRecordBatchPreviewResultSchema,
  dnsRecordDetailResultSchema,
  dnsRecordListResultSchema,
  dnsRecordMutationResultSchema,
  type DnsRecordAddRequest,
  type DnsRecordBatchDeleteRequest,
  type DnsRecordBatchPreviewRequest,
  type DnsRecordDeleteRequest,
  type DnsRecordModifyRequest,
  type DnsRecordMutationView,
  type DnsRecordStatusRequest,
  type ManagedDnsRecord,
  type ManagedDnsRecordType,
} from '@/schemas/dns-management'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import { authorizeStepUpGrant } from '@/services/auth/step-up'
import {
  executeWestDigitalWriteOperation,
  generateWestDigitalDnsBusinessOperationKey,
  generateWestDigitalOperationKey,
  type WestDigitalWriteOperationInput,
} from '@/services/providers/westdigital-operations'

import { findOwnedDomainAsset } from './domain-assets'

const DNS_MUTATION_LEASE_SECONDS = 600

type CustomerIdentity = {
  collection: 'customers'
  id: number | string
  status?: null | string
}

type AssetRecord = Awaited<ReturnType<typeof findOwnedDomainAsset>> & {
  customer: number | string | { id: number | string }
  dnsChangeCount?: null | number
  dnsChangeWindowStartedAt?: null | string
  dnsMutationLeaseExpiresAt?: null | string
  dnsMutationLeaseKey?: null | string
}

type ChangeEventRecord = {
  beforeRecord?: WestDigitalDnsRecord
  id: number | string
  operation: 'add' | 'delete' | 'modify' | 'pause' | 'resume'
  providerRecordId?: string
  requestedRecord?: WestDigitalDnsRecordInput
}

type ProviderOperationRecord = {
  id: number | string
  operationKey: string
  providerRequestId?: null | string
  safeResult?: unknown
  status: 'failed' | 'prepared' | 'submitted' | 'succeeded' | 'unknown'
}

type QueryInput = {
  host?: string
  limit: number
  page: number
  providerRecordId?: string
  type?: ManagedDnsRecordType
  value?: string
}

type RiskFields = {
  confirmed?: boolean
  deviceId?: string
  stepUpToken?: string
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
        ): Promise<{ rows?: Array<Record<string, unknown>> }>
      }
    | undefined
  if (!current) {
    throw new AppError('DNS_RECORD_CAS_UNAVAILABLE', '无法原子执行 DNS 解析变更', 503)
  }
  return current
}

function publicRecord(record: WestDigitalDnsRecord): ManagedDnsRecord {
  return {
    ...record,
    lineLabel: westDigitalDnsLineLabel(record.lineCode),
  }
}

function providerRecord(input: DnsRecordAddRequest): WestDigitalDnsRecordInput {
  return {
    host: input.host,
    lineCode: westDigitalDnsLineCode(input.line),
    priority: input.priority,
    ttl: input.ttl,
    type: input.type,
    value: input.value,
  }
}

function queryFailure(
  result: Extract<ProviderResult<WestDigitalDnsRecordPage>, { ok: false }>,
  traceId: string,
) {
  const error = new AppError(result.error.code, '西部数码 DNS 解析记录暂时无法查询', 503, {
    action: result.error.retryable ? '请稍后重试查询' : '请转人工核对',
    dataSource: getEnv().WESTDIGITAL_MODE === 'live' ? 'westdigital' : 'westdigital-fixture',
    observedAt: result.observedAt,
    retryable: result.error.retryable,
    title: result.error.statusKnown ? 'DNS 解析查询失败' : 'DNS 解析状态不明',
  })
  const problem = toProblemDetails(error, traceId)
  return result.error.code === 'WESTDIGITAL_RATE_LIMITED'
    ? ({
        meta: { observedAt: result.observedAt, traceId },
        problem,
        state: 'rate_limited',
      } as const)
    : ({ meta: { observedAt: result.observedAt, traceId }, problem, state: 'error' } as const)
}

async function queryProviderRecords(
  asset: AssetRecord,
  input: QueryInput,
  provider: WestDigitalManagedProvider,
  traceId: string,
) {
  return provider.queryDnsRecords({
    domainAscii: asset.domainAscii,
    ...input,
    traceId,
  })
}

async function requireProviderRecords(
  asset: AssetRecord,
  input: QueryInput,
  provider: WestDigitalManagedProvider,
  traceId: string,
): Promise<WestDigitalDnsRecordPage> {
  const queried = await queryProviderRecords(asset, input, provider, traceId)
  if (!queried.ok) {
    throw new AppError(queried.error.code, '西部数码 DNS 解析记录暂时无法查询', 503, {
      retryable: queried.error.retryable,
    })
  }
  return queried.data
}

async function requireProviderRecord(
  asset: AssetRecord,
  providerRecordId: string,
  provider: WestDigitalManagedProvider,
  traceId: string,
): Promise<WestDigitalDnsRecord> {
  const page = await requireProviderRecords(
    asset,
    {
      limit: getEnv().DNS_RECORD_MAX_PER_DOMAIN,
      page: 1,
      providerRecordId,
    },
    provider,
    traceId,
  )
  const record = page.items.find((item) => item.id === providerRecordId)
  if (!record) throw new AppError('DNS_RECORD_NOT_FOUND', '未找到指定 DNS 解析记录', 404)
  return record
}

export async function listCustomerDnsRecords(
  req: PayloadRequest,
  assetId: number | string,
  input: QueryInput,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const queried = await queryProviderRecords(asset, input, options.provider, options.traceId)
  if (!queried.ok) return dnsRecordListResultSchema.parse(queryFailure(queried, options.traceId))
  return dnsRecordListResultSchema.parse({
    data: {
      items: queried.data.items.map(publicRecord),
      page: queried.data.page,
      pageCount: queried.data.pageCount,
      total: queried.data.total,
    },
    meta: {
      dataSource: getEnv().WESTDIGITAL_MODE === 'live' ? 'westdigital' : 'westdigital-fixture',
      observedAt: queried.observedAt,
      traceId: options.traceId,
    },
    state: queried.data.items.length ? 'ready' : 'empty',
  })
}

export async function getCustomerDnsRecord(
  req: PayloadRequest,
  assetId: number | string,
  providerRecordId: string,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const queried = await queryProviderRecords(
    asset,
    {
      limit: getEnv().DNS_RECORD_MAX_PER_DOMAIN,
      page: 1,
      providerRecordId,
    },
    options.provider,
    options.traceId,
  )
  if (!queried.ok) return dnsRecordDetailResultSchema.parse(queryFailure(queried, options.traceId))
  const record = queried.data.items.find((item) => item.id === providerRecordId)
  if (!record) throw new AppError('DNS_RECORD_NOT_FOUND', '未找到指定 DNS 解析记录', 404)
  return dnsRecordDetailResultSchema.parse({
    data: publicRecord(record),
    meta: {
      dataSource: getEnv().WESTDIGITAL_MODE === 'live' ? 'westdigital' : 'westdigital-fixture',
      observedAt: queried.observedAt,
      traceId: options.traceId,
    },
    state: 'ready',
  })
}

function highRiskRecord(record: Pick<WestDigitalDnsRecordInput, 'host' | 'type'>): boolean {
  return record.type === 'MX' || (record.host === '@' && ['A', 'CNAME'].includes(record.type))
}

async function authorizeRecordRisk(
  req: PayloadRequest,
  customerId: number | string,
  record: Pick<WestDigitalDnsRecordInput, 'host' | 'type'>,
  input: RiskFields,
): Promise<void> {
  if (!highRiskRecord(record)) return
  if (input.confirmed !== true) {
    throw new AppError('DNS_RECORD_CONFIRMATION_REQUIRED', '该高风险 DNS 变更需要二次确认', 400)
  }
  if (!input.deviceId || !input.stepUpToken) {
    throw new AppError('STEP_UP_GRANT_REQUIRED', '该高风险 DNS 变更需要 step-up 授权', 403)
  }
  await authorizeStepUpGrant(req, {
    customerId,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: record.type === 'MX' ? 'mx_record_change' : 'dns_record_change',
    stepUpToken: input.stepUpToken,
  })
}

async function claimMutationLease(
  req: PayloadRequest,
  asset: AssetRecord,
  leaseKey: string,
  changeDelta: number,
): Promise<void> {
  const limit = getEnv().DNS_RECORD_CHANGE_LIMIT_PER_MINUTE
  if (changeDelta > limit) {
    throw new AppError('DNS_RECORD_RATE_LIMITED', 'DNS 解析变更超过单分钟上限', 429, {
      retryAfterSeconds: 60,
    })
  }
  await transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE domain_assets
      SET
        dns_mutation_lease_key = ${leaseKey},
        dns_mutation_lease_expires_at = NOW() + (${DNS_MUTATION_LEASE_SECONDS} * INTERVAL '1 second'),
        dns_change_window_started_at = CASE
          WHEN dns_change_window_started_at IS NULL
            OR dns_change_window_started_at <= NOW() - INTERVAL '1 minute'
          THEN NOW()
          ELSE dns_change_window_started_at
        END,
        dns_change_count = CASE
          WHEN dns_change_window_started_at <= NOW() - INTERVAL '1 minute'
          THEN ${changeDelta}
          ELSE COALESCE(dns_change_count, 0) + ${changeDelta}
        END,
        updated_at = NOW()
      WHERE id = ${asset.id}
        AND (
          dns_mutation_lease_key IS NULL
          OR dns_mutation_lease_expires_at <= NOW()
        )
        AND (
          dns_change_window_started_at <= NOW() - INTERVAL '1 minute'
          OR COALESCE(dns_change_count, 0) <= ${limit - changeDelta}
        )
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id !== undefined) return

    const current = (await req.payload.findByID({
      collection: 'domainAssets',
      depth: 0,
      id: asset.id,
      overrideAccess: true,
      req,
    })) as unknown as AssetRecord
    if (
      current.dnsMutationLeaseKey &&
      current.dnsMutationLeaseKey !== leaseKey &&
      new Date(current.dnsMutationLeaseExpiresAt ?? 0).getTime() > Date.now()
    ) {
      throw new AppError('DNS_RECORD_MUTATION_IN_PROGRESS', '该域名已有 DNS 解析变更正在处理', 409)
    }
    throw new AppError('DNS_RECORD_RATE_LIMITED', 'DNS 解析变更超过单分钟上限', 429, {
      retryAfterSeconds: 60,
    })
  })
}

async function releaseMutationLease(
  req: PayloadRequest,
  asset: AssetRecord,
  leaseKey: string,
): Promise<void> {
  await transaction(req, async () => {
    const released = await (
      await database(req)
    ).execute(sql`
      UPDATE domain_assets
      SET
        dns_mutation_lease_key = NULL,
        dns_mutation_lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = ${asset.id}
        AND dns_mutation_lease_key = ${leaseKey}
      RETURNING id
    `)
    if (released.rows?.[0]?.id === undefined) {
      throw new AppError('DNS_RECORD_MUTATION_LEASE_LOST', 'DNS 解析变更互斥状态无法确认', 503)
    }
  })
}

async function findChangeEvent(
  req: PayloadRequest,
  eventKey: string,
): Promise<ChangeEventRecord | undefined> {
  const found = await req.payload.find({
    collection: 'dnsRecordChanges',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { eventKey: { equals: eventKey } },
  })
  return found.docs[0] as unknown as ChangeEventRecord | undefined
}

async function findRequestedChangeIntent(
  req: PayloadRequest,
  operationKey: string,
): Promise<ChangeEventRecord> {
  const found = await req.payload.find({
    collection: 'dnsRecordChanges',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ operationKey: { equals: operationKey } }, { event: { equals: 'requested' } }],
    },
  })
  const change = found.docs[0] as unknown as ChangeEventRecord | undefined
  if (!change?.requestedRecord) {
    throw new AppError(
      'DNS_RECORD_OPERATION_INTENT_MISSING',
      'DNS Provider 操作的原始意图缺失，禁止重复提交',
      503,
    )
  }
  return change
}

async function appendChangeEvent(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    batchKey?: string
    beforeRecord?: WestDigitalDnsRecord
    confirmedRecord?: WestDigitalDnsRecord
    customerId: number | string
    errorCode?: string
    event: 'confirmed' | 'failed' | 'pending_query' | 'requested'
    operation: 'add' | 'delete' | 'modify' | 'pause' | 'resume'
    operationKey: string
    providerOperationId?: string
    providerRecordId?: string
    requestedRecord?: WestDigitalDnsRecordInput
    traceId: string
  },
): Promise<ChangeEventRecord> {
  const eventKey = `${input.operationKey}:${input.event}`
  const existing = await findChangeEvent(req, eventKey)
  if (existing) return existing
  try {
    return await transaction(req, async () => {
      const event = (await req.payload.create({
        collection: 'dnsRecordChanges',
        data: {
          asset: input.asset.id as never,
          batchKey: input.batchKey,
          beforeRecord: input.beforeRecord,
          confirmedRecord: input.confirmedRecord,
          customer: input.customerId as never,
          errorCode: input.errorCode,
          event: input.event,
          eventKey,
          occurredAt: new Date().toISOString(),
          operation: input.operation,
          operationKey: input.operationKey,
          providerOperation: input.providerOperationId
            ? (Number(input.providerOperationId) as never)
            : undefined,
          providerRecordId: input.providerRecordId,
          requestedRecord: input.requestedRecord,
          traceId: input.traceId,
        },
        overrideAccess: true,
        req,
      })) as unknown as ChangeEventRecord
      await recordAuditEvent(req, {
        action: 'domain.dns_record.change_recorded',
        actor: { id: input.customerId, type: 'customer' },
        metadata: {
          beforeRecord: input.beforeRecord,
          confirmedRecord: input.confirmedRecord,
          errorCode: input.errorCode,
          event: input.event,
          operation: input.operation,
          providerRecordId: input.providerRecordId,
          requestedRecord: input.requestedRecord,
        },
        targetId: event.id,
      })
      return event
    })
  } catch (error) {
    const raced = await findChangeEvent(req, eventKey)
    if (raced) return raced
    throw error
  }
}

async function findProviderOperation(
  req: PayloadRequest,
  operationKey: string,
): Promise<ProviderOperationRecord | undefined> {
  const found = await req.payload.find({
    collection: 'providerOperations',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { operationKey: { equals: operationKey } },
  })
  return found.docs[0] as unknown as ProviderOperationRecord | undefined
}

async function findReplayIntent(
  req: PayloadRequest,
  input: {
    businessKey: string
    operation: 'dns_record_add' | 'dns_record_delete' | 'dns_record_modify' | 'dns_record_pause'
    targetId: number | string
  },
): Promise<{ change: ChangeEventRecord; operationKey: string } | undefined> {
  const operationKey = generateWestDigitalDnsBusinessOperationKey(input)
  if (!(await findProviderOperation(req, operationKey))) return undefined
  return { change: await findRequestedChangeIntent(req, operationKey), operationKey }
}

function requireReplayProviderRecordId(change: ChangeEventRecord): string {
  if (!change.providerRecordId) {
    throw new AppError(
      'DNS_RECORD_OPERATION_INTENT_MISSING',
      'DNS Provider 操作的记录编号缺失，禁止重复提交',
      503,
    )
  }
  return change.providerRecordId
}

function operationRecordId(operation: ProviderOperationRecord): string | undefined {
  if (!operation.safeResult || typeof operation.safeResult !== 'object') return undefined
  const value = (operation.safeResult as { providerRecordId?: unknown }).providerRecordId
  return typeof value === 'string' ? value : undefined
}

function operationStatus(operation: ProviderOperationRecord): DnsRecordMutationView['status'] {
  if (operation.status === 'succeeded') return 'succeeded'
  if (operation.status === 'failed') return 'failed'
  return 'pending_query'
}

async function executeMutation(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    batchKey?: string
    beforeRecord?: WestDigitalDnsRecord
    customerId: number | string
    operation: 'add' | 'delete' | 'modify' | 'pause' | 'resume'
    provider: WestDigitalManagedProvider
    requestedRecord: WestDigitalDnsRecordInput
    traceId: string
    writeInput: WestDigitalWriteOperationInput
  },
): Promise<Result<DnsRecordMutationView>> {
  const operationKey = generateWestDigitalOperationKey(input.writeInput)
  await appendChangeEvent(req, {
    asset: input.asset,
    batchKey: input.batchKey,
    beforeRecord: input.beforeRecord,
    customerId: input.customerId,
    event: 'requested',
    operation: input.operation,
    operationKey,
    providerRecordId:
      'providerRecordId' in input.writeInput ? input.writeInput.providerRecordId : undefined,
    requestedRecord: input.requestedRecord,
    traceId: input.traceId,
  })

  const executed = await executeWestDigitalWriteOperation(req, input.writeInput, input.provider)
  const operation = await findProviderOperation(req, operationKey)
  if (!operation) {
    throw new AppError('DNS_RECORD_OPERATION_MISSING', 'DNS Provider 操作记录缺失', 503)
  }
  const status = operationStatus(operation)
  const providerRecordId =
    operationRecordId(operation) ??
    ('providerRecordId' in input.writeInput ? input.writeInput.providerRecordId : undefined)
  const confirmedRecord =
    status === 'succeeded' && input.operation !== 'delete'
      ? await requireProviderRecord(
          input.asset,
          providerRecordId!,
          input.provider,
          `${input.traceId}-confirmed-record`,
        )
      : undefined
  const event = await appendChangeEvent(req, {
    asset: input.asset,
    batchKey: input.batchKey,
    beforeRecord: input.beforeRecord,
    confirmedRecord,
    customerId: input.customerId,
    errorCode: 'problem' in executed ? executed.problem.code : undefined,
    event: status === 'succeeded' ? 'confirmed' : status === 'failed' ? 'failed' : 'pending_query',
    operation: input.operation,
    operationKey,
    providerOperationId: String(operation.id),
    providerRecordId,
    requestedRecord: input.requestedRecord,
    traceId: input.traceId,
  })
  const data = dnsRecordMutationResultSchema.options[0].shape.data.parse({
    changeEventId: String(event.id),
    idempotentReplay: 'data' in executed ? executed.data.idempotentReplay : false,
    operationId: String(operation.id),
    operationKey,
    providerRecordId,
    status,
  })
  if (status === 'succeeded') {
    return { data, meta: executed.meta, state: 'ready' }
  }
  const problem =
    'problem' in executed
      ? executed.problem
      : toProblemDetails(
          new AppError(
            status === 'failed' ? 'WESTDIGITAL_OPERATION_FAILED' : 'WESTDIGITAL_STATUS_UNKNOWN',
            status === 'failed'
              ? '西部数码明确拒绝 DNS 解析变更'
              : 'DNS 解析变更状态待查询，禁止重复提交',
            503,
          ),
          input.traceId,
        )
  return { data, meta: executed.meta, problem, state: 'degraded' }
}

async function withMutationLease<T>(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    changeDelta: number
    leaseKey: string
  },
  work: () => Promise<T>,
): Promise<T> {
  await claimMutationLease(req, input.asset, input.leaseKey, input.changeDelta)
  try {
    return await work()
  } finally {
    await releaseMutationLease(req, input.asset, input.leaseKey)
  }
}

export async function addCustomerDnsRecord(
  req: PayloadRequest,
  assetId: number | string,
  input: DnsRecordAddRequest,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const requestedRecord = providerRecord(input)
  const replay = await findReplayIntent(req, {
    businessKey: input.idempotencyKey,
    operation: 'dns_record_add',
    targetId: asset.id,
  })
  if (replay) {
    await authorizeRecordRisk(req, options.customer.id, replay.change.requestedRecord!, input)
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        beforeRecord: replay.change.beforeRecord,
        customerId: options.customer.id,
        operation: 'add',
        provider: options.provider,
        requestedRecord: replay.change.requestedRecord!,
        traceId: options.traceId,
        writeInput: {
          actor: { id: options.customer.id, type: 'customer' },
          businessKey: input.idempotencyKey,
          domainAscii: asset.domainAscii,
          operation: 'dns_record_add',
          record: replay.change.requestedRecord!,
          targetId: asset.id,
          traceId: options.traceId,
        },
      }),
    )
  }
  await authorizeRecordRisk(req, options.customer.id, requestedRecord, input)
  const writeInput: WestDigitalWriteOperationInput = {
    actor: { id: options.customer.id, type: 'customer' },
    businessKey: input.idempotencyKey,
    domainAscii: asset.domainAscii,
    operation: 'dns_record_add',
    record: requestedRecord,
    targetId: asset.id,
    traceId: options.traceId,
  }
  const leaseKey = generateWestDigitalOperationKey(writeInput)
  return withMutationLease(req, { asset, changeDelta: 1, leaseKey }, async () => {
    const records = await requireProviderRecords(
      asset,
      { limit: getEnv().DNS_RECORD_MAX_PER_DOMAIN, page: 1 },
      options.provider,
      `${options.traceId}-record-count`,
    )
    if (records.total >= getEnv().DNS_RECORD_MAX_PER_DOMAIN) {
      throw new AppError('DNS_RECORD_LIMIT_EXCEEDED', '该域名的 DNS 解析记录数已达上限', 409)
    }
    if (
      records.items.some(
        (record) =>
          record.host === requestedRecord.host &&
          record.lineCode === requestedRecord.lineCode &&
          record.type === requestedRecord.type &&
          record.value === requestedRecord.value,
      )
    ) {
      throw new AppError('DNS_RECORD_DUPLICATE', '相同 DNS 解析记录已存在', 409)
    }
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        customerId: options.customer.id,
        operation: 'add',
        provider: options.provider,
        requestedRecord,
        traceId: options.traceId,
        writeInput,
      }),
    )
  })
}

export async function modifyCustomerDnsRecord(
  req: PayloadRequest,
  assetId: number | string,
  providerRecordId: string,
  input: DnsRecordModifyRequest,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const replay = await findReplayIntent(req, {
    businessKey: input.idempotencyKey,
    operation: 'dns_record_modify',
    targetId: asset.id,
  })
  if (replay) {
    const replayRecordId = requireReplayProviderRecordId(replay.change)
    await authorizeRecordRisk(req, options.customer.id, replay.change.requestedRecord!, input)
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        beforeRecord: replay.change.beforeRecord,
        customerId: options.customer.id,
        operation: 'modify',
        provider: options.provider,
        requestedRecord: replay.change.requestedRecord!,
        traceId: options.traceId,
        writeInput: {
          actor: { id: options.customer.id, type: 'customer' },
          businessKey: input.idempotencyKey,
          domainAscii: asset.domainAscii,
          operation: 'dns_record_modify',
          providerRecordId: replayRecordId,
          record: replay.change.requestedRecord!,
          targetId: asset.id,
          traceId: options.traceId,
        },
      }),
    )
  }
  const leaseKey = `dns-record-modify:${asset.id}:${providerRecordId}`
  return withMutationLease(req, { asset, changeDelta: 1, leaseKey }, async () => {
    const before = await requireProviderRecord(
      asset,
      providerRecordId,
      options.provider,
      `${options.traceId}-preflight`,
    )
    await authorizeRecordRisk(req, options.customer.id, before, input)
    const requestedRecord: WestDigitalDnsRecordInput = {
      host: before.host,
      lineCode: before.lineCode,
      priority: input.priority,
      ttl: input.ttl,
      type: before.type,
      value: input.value,
    }
    const writeInput: WestDigitalWriteOperationInput = {
      actor: { id: options.customer.id, type: 'customer' },
      businessKey: input.idempotencyKey,
      domainAscii: asset.domainAscii,
      operation: 'dns_record_modify',
      providerRecordId,
      record: requestedRecord,
      targetId: asset.id,
      traceId: options.traceId,
    }
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        beforeRecord: before,
        customerId: options.customer.id,
        operation: 'modify',
        provider: options.provider,
        requestedRecord,
        traceId: options.traceId,
        writeInput,
      }),
    )
  })
}

export async function deleteCustomerDnsRecord(
  req: PayloadRequest,
  assetId: number | string,
  providerRecordId: string,
  input: DnsRecordDeleteRequest,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const replay = await findReplayIntent(req, {
    businessKey: input.idempotencyKey,
    operation: 'dns_record_delete',
    targetId: asset.id,
  })
  if (replay) {
    const replayRecordId = requireReplayProviderRecordId(replay.change)
    await authorizeRecordRisk(req, options.customer.id, replay.change.requestedRecord!, input)
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        beforeRecord: replay.change.beforeRecord,
        customerId: options.customer.id,
        operation: 'delete',
        provider: options.provider,
        requestedRecord: replay.change.requestedRecord!,
        traceId: options.traceId,
        writeInput: {
          actor: { id: options.customer.id, type: 'customer' },
          businessKey: input.idempotencyKey,
          domainAscii: asset.domainAscii,
          operation: 'dns_record_delete',
          providerRecordId: replayRecordId,
          record: replay.change.requestedRecord!,
          targetId: asset.id,
          traceId: options.traceId,
        },
      }),
    )
  }
  const leaseKey = `dns-record-delete:${asset.id}:${providerRecordId}`
  return withMutationLease(req, { asset, changeDelta: 1, leaseKey }, async () => {
    const before = await requireProviderRecord(
      asset,
      providerRecordId,
      options.provider,
      `${options.traceId}-preflight`,
    )
    await authorizeRecordRisk(req, options.customer.id, before, input)
    const requestedRecord: WestDigitalDnsRecordInput = {
      host: before.host,
      lineCode: before.lineCode,
      priority: before.priority,
      ttl: before.ttl,
      type: before.type,
      value: before.value,
    }
    const writeInput: WestDigitalWriteOperationInput = {
      actor: { id: options.customer.id, type: 'customer' },
      businessKey: input.idempotencyKey,
      domainAscii: asset.domainAscii,
      operation: 'dns_record_delete',
      providerRecordId,
      record: requestedRecord,
      targetId: asset.id,
      traceId: options.traceId,
    }
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        beforeRecord: before,
        customerId: options.customer.id,
        operation: 'delete',
        provider: options.provider,
        requestedRecord,
        traceId: options.traceId,
        writeInput,
      }),
    )
  })
}

export async function setCustomerDnsRecordPaused(
  req: PayloadRequest,
  assetId: number | string,
  providerRecordId: string,
  input: DnsRecordStatusRequest,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const replay = await findReplayIntent(req, {
    businessKey: input.idempotencyKey,
    operation: 'dns_record_pause',
    targetId: asset.id,
  })
  if (replay) {
    const replayRecordId = requireReplayProviderRecordId(replay.change)
    await authorizeRecordRisk(req, options.customer.id, replay.change.requestedRecord!, input)
    const replayPaused = replay.change.operation === 'pause'
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        beforeRecord: replay.change.beforeRecord,
        customerId: options.customer.id,
        operation: replayPaused ? 'pause' : 'resume',
        provider: options.provider,
        requestedRecord: replay.change.requestedRecord!,
        traceId: options.traceId,
        writeInput: {
          actor: { id: options.customer.id, type: 'customer' },
          businessKey: input.idempotencyKey,
          domainAscii: asset.domainAscii,
          operation: 'dns_record_pause',
          paused: replayPaused,
          providerRecordId: replayRecordId,
          record: replay.change.requestedRecord!,
          targetId: asset.id,
          traceId: options.traceId,
        },
      }),
    )
  }
  const leaseKey = `dns-record-pause:${asset.id}:${providerRecordId}:${input.paused}`
  return withMutationLease(req, { asset, changeDelta: 1, leaseKey }, async () => {
    const before = await requireProviderRecord(
      asset,
      providerRecordId,
      options.provider,
      `${options.traceId}-preflight`,
    )
    await authorizeRecordRisk(req, options.customer.id, before, input)
    const requestedRecord: WestDigitalDnsRecordInput = {
      host: before.host,
      lineCode: before.lineCode,
      priority: before.priority,
      ttl: before.ttl,
      type: before.type,
      value: before.value,
    }
    const writeInput: WestDigitalWriteOperationInput = {
      actor: { id: options.customer.id, type: 'customer' },
      businessKey: input.idempotencyKey,
      domainAscii: asset.domainAscii,
      operation: 'dns_record_pause',
      paused: input.paused,
      providerRecordId,
      record: requestedRecord,
      targetId: asset.id,
      traceId: options.traceId,
    }
    return dnsRecordMutationResultSchema.parse(
      await executeMutation(req, {
        asset,
        beforeRecord: before,
        customerId: options.customer.id,
        operation: input.paused ? 'pause' : 'resume',
        provider: options.provider,
        requestedRecord,
        traceId: options.traceId,
        writeInput,
      }),
    )
  })
}

function uniqueRecordIds(recordIds: string[]): string[] {
  const unique = [...new Set(recordIds)]
  if (unique.length !== recordIds.length) {
    throw new AppError('DNS_RECORD_BATCH_DUPLICATE_ID', '批量删除记录编号不得重复', 400)
  }
  return unique.sort((left, right) => left.localeCompare(right))
}

function recordsDigest(records: WestDigitalDnsRecord[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...records]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((record) => ({
            host: record.host,
            id: record.id,
            lineCode: record.lineCode,
            paused: record.paused,
            priority: record.priority,
            ttl: record.ttl,
            type: record.type,
            value: record.value,
          })),
      ),
    )
    .digest('hex')
}

type PreviewPayload = {
  assetId: string
  expiresAt: string
  recordDigest: string
  recordIds: string[]
  version: 1
}

function signPreview(payload: PreviewPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${hmac(encoded, getEnv().SESSION_PEPPER)}`
}

function verifyPreview(
  token: string,
  input: {
    assetId: number | string
    recordIds: string[]
  },
): PreviewPayload {
  const [encoded = '', signature = '', extra] = token.split('.')
  if (
    extra ||
    !/^[a-f0-9]{64}$/iu.test(signature) ||
    !safeEqualHex(hmac(encoded, getEnv().SESSION_PEPPER), signature)
  ) {
    throw new AppError('DNS_RECORD_PREVIEW_INVALID', '批量删除预览无效或已被修改', 409)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new AppError('DNS_RECORD_PREVIEW_INVALID', '批量删除预览无效或已被修改', 409)
  }
  const payload = parsed as Partial<PreviewPayload>
  if (
    payload.version !== 1 ||
    payload.assetId !== String(input.assetId) ||
    !payload.expiresAt ||
    new Date(payload.expiresAt).getTime() <= Date.now() ||
    JSON.stringify(payload.recordIds) !== JSON.stringify(input.recordIds) ||
    typeof payload.recordDigest !== 'string'
  ) {
    throw new AppError('DNS_RECORD_PREVIEW_INVALID', '批量删除预览无效或已过期', 409)
  }
  return payload as PreviewPayload
}

async function loadRecordsForPreview(
  asset: AssetRecord,
  recordIds: string[],
  provider: WestDigitalManagedProvider,
  traceId: string,
): Promise<WestDigitalDnsRecord[]> {
  return Promise.all(
    recordIds.map((recordId, index) =>
      requireProviderRecord(asset, recordId, provider, `${traceId}-record-${index + 1}`),
    ),
  )
}

export async function previewCustomerDnsRecordBatchDelete(
  req: PayloadRequest,
  assetId: number | string,
  input: DnsRecordBatchPreviewRequest,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const recordIds = uniqueRecordIds(input.recordIds)
  const records = await loadRecordsForPreview(asset, recordIds, options.provider, options.traceId)
  const expiresAt = new Date(
    Date.now() + getEnv().DNS_RECORD_PREVIEW_TTL_SECONDS * 1_000,
  ).toISOString()
  const previewToken = signPreview({
    assetId: String(asset.id),
    expiresAt,
    recordDigest: recordsDigest(records),
    recordIds,
    version: 1,
  })
  return dnsRecordBatchPreviewResultSchema.parse({
    data: { expiresAt, items: records.map(publicRecord), previewToken },
    meta: {
      dataSource: getEnv().WESTDIGITAL_MODE === 'live' ? 'westdigital' : 'westdigital-fixture',
      traceId: options.traceId,
    },
    state: 'ready',
  })
}

export async function deleteCustomerDnsRecordBatch(
  req: PayloadRequest,
  assetId: number | string,
  input: DnsRecordBatchDeleteRequest,
  options: {
    customer: CustomerIdentity
    provider: WestDigitalManagedProvider
    traceId: string
  },
) {
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const recordIds = uniqueRecordIds(input.recordIds)
  if (!input.deviceId || !input.stepUpToken) {
    throw new AppError('STEP_UP_GRANT_REQUIRED', '批量删除 DNS 解析需要 step-up 授权', 403)
  }
  await authorizeStepUpGrant(req, {
    customerId: options.customer.id,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: 'dns_bulk_delete',
    stepUpToken: input.stepUpToken,
  })
  const preview = verifyPreview(input.previewToken, {
    assetId: asset.id,
    recordIds,
  })
  const batchKey = createHash('sha256').update(input.previewToken).digest('hex')
  const leaseKey = `dns-record-batch-delete:${asset.id}:${batchKey}`

  return withMutationLease(req, { asset, changeDelta: recordIds.length, leaseKey }, async () => {
    const records = await loadRecordsForPreview(asset, recordIds, options.provider, options.traceId)
    if (recordsDigest(records) !== preview.recordDigest) {
      throw new AppError('DNS_RECORD_PREVIEW_STALE', 'DNS 解析记录已变化，请重新预览', 409)
    }
    const results: DnsRecordMutationView[] = []
    const problems = []
    for (const [index, before] of records.entries()) {
      const requestedRecord: WestDigitalDnsRecordInput = {
        host: before.host,
        lineCode: before.lineCode,
        priority: before.priority,
        ttl: before.ttl,
        type: before.type,
        value: before.value,
      }
      const writeInput: WestDigitalWriteOperationInput = {
        actor: { id: options.customer.id, type: 'customer' },
        domainAscii: asset.domainAscii,
        operation: 'dns_record_delete',
        providerRecordId: before.id,
        record: requestedRecord,
        targetId: asset.id,
        traceId: `${options.traceId}-delete-${index + 1}`,
      }
      const result = await executeMutation(req, {
        asset,
        batchKey,
        beforeRecord: before,
        customerId: options.customer.id,
        operation: 'delete',
        provider: options.provider,
        requestedRecord,
        traceId: `${options.traceId}-delete-${index + 1}`,
        writeInput,
      })
      if ('data' in result) results.push(result.data)
      if ('problem' in result) problems.push(result.problem)
    }
    if (results.every((result) => result.status === 'succeeded')) {
      return dnsRecordBatchDeleteResultSchema.parse({
        data: { items: results },
        meta: {
          dataSource: getEnv().WESTDIGITAL_MODE === 'live' ? 'westdigital' : 'westdigital-fixture',
          traceId: options.traceId,
        },
        state: 'ready',
      })
    }
    return dnsRecordBatchDeleteResultSchema.parse({
      data: { items: results },
      meta: {
        dataSource: getEnv().WESTDIGITAL_MODE === 'live' ? 'westdigital' : 'westdigital-fixture',
        traceId: options.traceId,
      },
      problem:
        problems[0] ??
        toProblemDetails(
          new AppError(
            'DNS_RECORD_BATCH_PARTIAL',
            '批量删除仅部分完成；状态不明项只允许查询，禁止重复提交',
            503,
          ),
          options.traceId,
        ),
      state: 'partial',
    })
  })
}

export function configuredDnsRecordProvider(): WestDigitalManagedProvider {
  return createConfiguredWestDigitalWriteAdapter()
}
