import { createHash, randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import type { AuditActor } from '@/services/audit/record-audit-event'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { getEnv } from '@/lib/env'
import { AppError, toProblemDetails } from '@/lib/errors'
import { authorizeWestDigitalWrite, ProviderWriteGuardError } from '@/lib/provider-write-guardrails'
import type { Result } from '@/schemas/api'
import type {
  WestDigitalDomainAsset,
  WestDigitalDomainManagementProvider,
  WestDigitalDomainContactType,
  WestDigitalDnsRecord,
  WestDigitalDnsRecordInput,
  WestDigitalManagedProvider,
  WestDigitalRealnameProfile,
  WestDigitalWriteProvider,
} from '@/providers/types'
import { isExplicitlyRetryableWestDigitalWriteError } from '@/providers/westdigital-write'
import { consumeProviderWriteBudget } from '@/services/providers/provider-write-budget'

export const WESTDIGITAL_WRITE_MAX_ATTEMPTS = 3

function westDigitalDataSource(): 'westdigital' | 'westdigital-fixture' {
  return getEnv().WESTDIGITAL_MODE === 'live' ? 'westdigital' : 'westdigital-fixture'
}

type ProviderOperationStatus = 'failed' | 'prepared' | 'submitted' | 'succeeded' | 'unknown'
type OperationRecord = {
  attemptCount?: number | null
  id: number | string
  maxAttempts?: number | null
  operationKey: string
  providerRequestId?: string | null
  safeResult?: unknown
  status: ProviderOperationStatus
}

type SharedInput = {
  actor: AuditActor
  businessKey?: string
  orderId?: number | string
  targetId: number | string
  traceId: string
}

export type WestDigitalWriteOperationInput =
  | (SharedInput & {
      domainAscii: string
      operation: 'realname'
      profile: WestDigitalRealnameProfile
    })
  | (SharedInput & {
      clientPriceFen: number
      domainAscii: string
      nameservers: string[]
      operation: 'register'
      premium: boolean
      providerTemplateId: string
      years: number
    })
  | (SharedInput & {
      clientPriceFen: number
      currentExpiresOn: string
      domainAscii: string
      operation: 'renew'
      premium: boolean
      years: number
    })
  | (SharedInput & {
      domainAscii: string
      nameservers: string[]
      operation: 'nameserver'
    })
  | (SharedInput & {
      domainAscii: string
      operation: 'dns_record_add'
      record: WestDigitalDnsRecordInput
    })
  | (SharedInput & {
      businessKey: string
      domainAscii: string
      managementPassword: string
      operation: 'domain_management_password'
    })
  | (SharedInput & {
      businessKey: string
      contactType: WestDigitalDomainContactType
      domainAscii: string
      operation: 'domain_contact_update'
      profile: WestDigitalRealnameProfile
    })
  | (SharedInput & {
      businessKey: string
      domainAscii: string
      operation: 'domain_template_transfer'
      providerTemplateId: string
    })
  | (SharedInput & {
      domainAscii: string
      operation: 'dns_record_modify'
      providerRecordId: string
      record: WestDigitalDnsRecordInput
    })
  | (SharedInput & {
      domainAscii: string
      operation: 'dns_record_delete'
      providerRecordId: string
      record: WestDigitalDnsRecordInput
    })
  | (SharedInput & {
      domainAscii: string
      operation: 'dns_record_pause'
      paused: boolean
      providerRecordId: string
      record: WestDigitalDnsRecordInput
    })

export type WestDigitalOperationView = {
  attemptCount: number
  idempotentReplay: boolean
  operationId: string
  operationKey: string
  providerRequestId?: string
  providerRecordId?: string
  status: 'failed' | 'succeeded' | 'unknown'
}

type WestDigitalDnsWriteOperation = Extract<
  WestDigitalWriteOperationInput,
  { operation: `dns_record_${string}` }
>['operation']

type WestDigitalBusinessKeyOperation =
  | WestDigitalDnsWriteOperation
  | 'domain_contact_update'
  | 'domain_management_password'
  | 'domain_template_transfer'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function generateWestDigitalDnsBusinessOperationKey(input: {
  businessKey: string
  operation: WestDigitalBusinessKeyOperation
  targetId: number | string
}): string {
  const digest = createHash('sha256')
    .update(
      stable({
        businessKey: input.businessKey,
      }),
    )
    .digest('hex')
  return `westdigital:${input.operation}:${String(input.targetId)}:${digest}`
}

export function generateWestDigitalOperationKey(input: WestDigitalWriteOperationInput): string {
  if (
    input.businessKey &&
    (dnsOperation(input) ||
      input.operation === 'domain_management_password' ||
      input.operation === 'domain_contact_update' ||
      input.operation === 'domain_template_transfer')
  ) {
    return generateWestDigitalDnsBusinessOperationKey({
      businessKey: input.businessKey,
      operation: input.operation,
      targetId: input.targetId,
    })
  }
  const intent = Object.fromEntries(
    Object.entries(input).filter(([key]) => !['actor', 'traceId'].includes(key)),
  )
  const digest = createHash('sha256').update(stable(intent)).digest('hex')
  return `westdigital:${input.operation}:${String(input.targetId)}:${digest}`
}

function targetType(
  input: WestDigitalWriteOperationInput,
): 'domain' | 'order' | 'realname_template' {
  if (input.operation === 'realname') return 'realname_template'
  return input.orderId === undefined ? 'domain' : 'order'
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

async function findOperation(
  req: PayloadRequest,
  operationKey: string,
): Promise<OperationRecord | undefined> {
  const found = await req.payload.find({
    collection: 'providerOperations',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { operationKey: { equals: operationKey } },
  })
  return found.docs[0] as unknown as OperationRecord | undefined
}

async function prepareOperation(
  req: PayloadRequest,
  input: WestDigitalWriteOperationInput,
  operationKey: string,
): Promise<{ created: boolean; operation: OperationRecord }> {
  const existing = await findOperation(req, operationKey)
  if (existing) return { created: false, operation: existing }
  try {
    const operation = await transaction(req, async () => {
      const created = (await req.payload.create({
        collection: 'providerOperations',
        data: {
          attemptCount: 0,
          maxAttempts: WESTDIGITAL_WRITE_MAX_ATTEMPTS,
          operation: input.operation,
          operationKey,
          order: input.orderId as never,
          provider: 'westdigital',
          realnameTemplate: input.operation === 'realname' ? (input.targetId as never) : undefined,
          status: 'prepared',
          targetId: String(input.targetId),
          targetType: targetType(input),
        },
        overrideAccess: true,
        req,
      })) as unknown as OperationRecord
      await recordAuditEvent(req, {
        action: 'provider.operation.recorded',
        actor: input.actor,
        metadata: {
          operation: input.operation,
          operationKey,
          outcome: 'prepared',
          requestIdentifier: input.traceId,
          target: { id: String(input.targetId), type: targetType(input) },
        },
        targetId: created.id,
      })
      return created
    })
    return { created: true, operation }
  } catch (error) {
    const raced = await findOperation(req, operationKey)
    if (raced) return { created: false, operation: raced }
    throw error
  }
}

async function recordOutcome(
  req: PayloadRequest,
  input: WestDigitalWriteOperationInput,
  operation: OperationRecord,
  data: Record<string, unknown> & { status: ProviderOperationStatus },
  outcome: string,
  requestIdentifier?: string,
): Promise<OperationRecord> {
  return transaction(req, async () => {
    const updated = (await req.payload.update({
      collection: 'providerOperations',
      data: data as never,
      id: operation.id,
      overrideAccess: true,
      req,
    })) as unknown as OperationRecord
    await recordAuditEvent(req, {
      action: 'provider.operation.recorded',
      actor: input.actor,
      metadata: {
        attemptCount: updated.attemptCount ?? 0,
        operation: input.operation,
        operationKey: operation.operationKey,
        outcome,
        requestIdentifier: requestIdentifier ?? input.traceId,
        result: data.safeResult,
        target: { id: String(input.targetId), type: targetType(input) },
      },
      targetId: operation.id,
    })
    return updated
  })
}

async function claimAttempt(
  req: PayloadRequest,
  input: WestDigitalWriteOperationInput,
  operation: OperationRecord,
): Promise<OperationRecord | undefined> {
  const attemptCount = operation.attemptCount ?? 0
  const maxAttempts = operation.maxAttempts ?? WESTDIGITAL_WRITE_MAX_ATTEMPTS
  if (attemptCount >= maxAttempts) return undefined
  return transaction(req, async () => {
    const transactionId = await req.transactionID
    const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
    const database = session?.db as
      | {
          execute: (
            statement: ReturnType<typeof sql>,
          ) => Promise<{ rows?: Array<{ id: number | string }> }>
        }
      | undefined
    if (!database) {
      throw new AppError(
        'WESTDIGITAL_OPERATION_CLAIM_UNAVAILABLE',
        '无法原子认领 Provider 操作',
        503,
      )
    }
    const updated = await database.execute(sql`
      UPDATE provider_operations
      SET
        attempt_count = attempt_count + 1,
        last_error_code = NULL,
        status = 'submitted',
        updated_at = NOW()
      WHERE id = ${operation.id}
        AND status = 'prepared'
        AND attempt_count = ${attemptCount}
      RETURNING id
    `)
    const claimedId = updated.rows?.[0]?.id
    if (claimedId === undefined) return undefined
    const claimed = (await req.payload.findByID({
      collection: 'providerOperations',
      depth: 0,
      id: claimedId,
      overrideAccess: true,
      req,
    })) as unknown as OperationRecord
    await recordAuditEvent(req, {
      action: 'provider.operation.recorded',
      actor: input.actor,
      metadata: {
        attemptCount: attemptCount + 1,
        operation: input.operation,
        operationKey: operation.operationKey,
        outcome: 'write_claimed',
        requestIdentifier: input.traceId,
        target: { id: String(input.targetId), type: targetType(input) },
      },
      targetId: operation.id,
    })
    return claimed
  })
}

function requireDnsProvider(
  provider: WestDigitalWriteProvider | WestDigitalManagedProvider,
): WestDigitalManagedProvider {
  if (!('queryDnsRecords' in provider)) {
    throw new AppError('WESTDIGITAL_DNS_PROVIDER_UNAVAILABLE', 'DNS Provider 能力不可用', 503)
  }
  return provider
}

function requireDomainManagementProvider(
  provider: WestDigitalWriteProvider | WestDigitalManagedProvider,
): WestDigitalDomainManagementProvider {
  if (!('getDomainManagementPassword' in provider)) {
    throw new AppError(
      'WESTDIGITAL_DOMAIN_MANAGEMENT_PROVIDER_UNAVAILABLE',
      '域名管理 Provider 能力不可用',
      503,
    )
  }
  return provider
}

async function submit(
  provider: WestDigitalWriteProvider | WestDigitalManagedProvider,
  input: WestDigitalWriteOperationInput,
) {
  if (input.operation === 'realname') return provider.createRealname(input)
  if (input.operation === 'register') return provider.register(input)
  if (input.operation === 'renew') return provider.renew(input)
  if (input.operation === 'nameserver') return provider.changeNameservers(input)
  if (input.operation === 'domain_management_password')
    return requireDomainManagementProvider(provider).modifyDomainManagementPassword(input)
  if (input.operation === 'domain_contact_update')
    return requireDomainManagementProvider(provider).updateDomainContact(input)
  if (input.operation === 'domain_template_transfer')
    return requireDomainManagementProvider(provider).transferDomainToTemplate(input)
  const dnsProvider = requireDnsProvider(provider)
  if (input.operation === 'dns_record_add') return dnsProvider.addDnsRecord(input)
  if (input.operation === 'dns_record_modify') return dnsProvider.modifyDnsRecord(input)
  if (input.operation === 'dns_record_delete') return dnsProvider.deleteDnsRecord(input)
  return dnsProvider.setDnsRecordPaused(input)
}

function safeProviderResult(result: Awaited<ReturnType<typeof submit>>): Record<string, unknown> {
  if (!result.ok) return { errorCode: result.error.code, statusKnown: result.error.statusKnown }
  return {
    providerClientId: result.data.providerClientId,
    ...('providerTemplateId' in result.data
      ? { providerTemplateId: result.data.providerTemplateId }
      : {}),
    ...('providerRecordId' in result.data
      ? { providerRecordId: result.data.providerRecordId }
      : {}),
    providerState: result.data.state,
  }
}

function providerTemplateId(operation: OperationRecord): string | undefined {
  const result = operation.safeResult
  if (!result || typeof result !== 'object') return undefined
  const value = (result as { providerTemplateId?: unknown }).providerTemplateId
  return typeof value === 'string' ? value : undefined
}

function providerRecordId(operation: OperationRecord): string | undefined {
  const result = operation.safeResult
  if (!result || typeof result !== 'object') return undefined
  const value = (result as { providerRecordId?: unknown }).providerRecordId
  return typeof value === 'string' ? value : undefined
}

function dnsOperation(
  input: WestDigitalWriteOperationInput,
): input is Extract<WestDigitalWriteOperationInput, { operation: `dns_record_${string}` }> {
  return input.operation.startsWith('dns_record_')
}

async function queryStatus(
  provider: WestDigitalWriteProvider | WestDigitalManagedProvider,
  input: WestDigitalWriteOperationInput,
  operation: OperationRecord,
) {
  if (input.operation === 'realname') {
    const id = providerTemplateId(operation)
    if (!id) return undefined
    return provider.queryRealname({ providerTemplateId: id, traceId: input.traceId })
  }
  if (input.operation === 'domain_management_password') {
    return requireDomainManagementProvider(provider).getDomainManagementPassword({
      domainAscii: input.domainAscii,
      traceId: input.traceId,
    })
  }
  if (
    input.operation === 'domain_contact_update' ||
    input.operation === 'domain_template_transfer'
  ) {
    return requireDomainManagementProvider(provider).queryDomainInformation({
      domainAscii: input.domainAscii,
      traceId: input.traceId,
    })
  }
  if (dnsOperation(input)) {
    const recordId =
      input.operation === 'dns_record_add' ? providerRecordId(operation) : input.providerRecordId
    return requireDnsProvider(provider).queryDnsRecords({
      domainAscii: input.domainAscii,
      host: recordId ? undefined : input.record.host,
      limit: getEnv().DNS_RECORD_MAX_PER_DOMAIN,
      page: 1,
      providerRecordId: recordId,
      traceId: input.traceId,
      type: recordId ? undefined : input.record.type,
      value: recordId ? undefined : input.record.value,
    })
  }
  return provider.queryAsset({ domainAscii: input.domainAscii, traceId: input.traceId })
}

function sameDnsRecord(actual: WestDigitalDnsRecord, expected: WestDigitalDnsRecordInput): boolean {
  return (
    actual.host === expected.host &&
    actual.lineCode === expected.lineCode &&
    actual.priority === expected.priority &&
    actual.ttl === expected.ttl &&
    actual.type === expected.type &&
    actual.value === expected.value
  )
}

function confirmed(
  input: WestDigitalWriteOperationInput,
  result: Awaited<ReturnType<typeof queryStatus>>,
): boolean {
  if (!result?.ok) return false
  if (input.operation === 'realname')
    return 'state' in result.data && result.data.state !== 'unknown'
  if (input.operation === 'domain_management_password') {
    return (
      'managementPassword' in result.data &&
      result.data.managementPassword === input.managementPassword
    )
  }
  if (input.operation === 'domain_template_transfer') {
    return (
      'providerTemplateId' in result.data &&
      result.data.providerTemplateId === input.providerTemplateId
    )
  }
  if (input.operation === 'domain_contact_update') return false
  if (dnsOperation(input)) {
    if (!('items' in result.data)) return false
    const recordId = input.operation === 'dns_record_add' ? undefined : input.providerRecordId
    const matching = result.data.items.filter(
      (record) => (!recordId || record.id === recordId) && sameDnsRecord(record, input.record),
    )
    if (input.operation === 'dns_record_delete') {
      return !result.data.items.some((record) => record.id === input.providerRecordId)
    }
    if (input.operation === 'dns_record_pause') {
      return matching.length === 1 && matching[0]?.paused === input.paused
    }
    return matching.length === 1
  }
  if (!('domainAscii' in result.data) || result.data.domainAscii !== input.domainAscii) return false
  if (!('nameservers' in result.data)) return false
  if (input.operation === 'nameserver') {
    const actual = new Set(result.data.nameservers.map((value) => value.toLowerCase()))
    return input.nameservers.every((value) => actual.has(value.toLowerCase()))
  }
  if (input.operation === 'renew')
    return result.data.expiresAt.slice(0, 10) > input.currentExpiresOn
  return true
}

function view(operation: OperationRecord, idempotentReplay: boolean): WestDigitalOperationView {
  return {
    attemptCount: operation.attemptCount ?? 0,
    idempotentReplay,
    operationId: String(operation.id),
    operationKey: operation.operationKey,
    providerRequestId: operation.providerRequestId ?? undefined,
    providerRecordId: providerRecordId(operation),
    status:
      operation.status === 'succeeded'
        ? 'succeeded'
        : operation.status === 'failed'
          ? 'failed'
          : 'unknown',
  }
}

function result(
  operation: OperationRecord,
  idempotentReplay: boolean,
  traceId: string,
): Result<WestDigitalOperationView> {
  const data = view(operation, idempotentReplay)
  const dataSource = westDigitalDataSource()
  const meta = { dataSource, observedAt: new Date().toISOString(), traceId }
  if (operation.status === 'succeeded') return { data, meta, state: 'ready' }
  const code =
    operation.status === 'failed' ? 'WESTDIGITAL_OPERATION_FAILED' : 'WESTDIGITAL_STATUS_UNKNOWN'
  const problem = toProblemDetails(
    new AppError(
      code,
      operation.status === 'failed' ? '西部数码明确拒绝该操作' : '西部数码操作状态暂时无法确认',
      503,
      {
        action:
          operation.status === 'failed' ? '请检查安全失败原因' : '只能查询状态，禁止重复提交写操作',
        dataSource,
        observedAt: meta.observedAt,
        retryable: operation.status !== 'failed',
        title: operation.status === 'failed' ? 'Provider 操作失败' : 'Provider 状态不明',
      },
    ),
    traceId,
  )
  return operation.status === 'failed'
    ? { meta, problem, state: 'error' }
    : { data, meta, problem, state: 'degraded' }
}

async function safetyRejectedResult(
  req: PayloadRequest,
  input: WestDigitalWriteOperationInput,
  operation: OperationRecord,
  error: ProviderWriteGuardError,
): Promise<Result<WestDigitalOperationView>> {
  await recordAuditEvent(req, {
    action: 'provider.operation.recorded',
    actor: input.actor,
    metadata: {
      errorCode: error.code,
      operation: input.operation,
      operationKey: operation.operationKey,
      outcome: 'write_blocked',
      requestIdentifier: input.traceId,
      target: { id: String(input.targetId), type: targetType(input) },
    },
    targetId: operation.id,
  })
  const observedAt = new Date().toISOString()
  return {
    data: view(operation, true),
    meta: { dataSource: 'westdigital-safety-fence', observedAt, traceId: input.traceId },
    problem: toProblemDetails(
      new AppError(error.code, '真实西部数码写操作已被安全围栏拒绝', 503, {
        action: '保持操作未提交，检查分级开关、域名白名单和本次运行额度',
        dataSource: 'westdigital-safety-fence',
        observedAt,
        retryable: false,
        title: 'Provider 写安全围栏拒绝',
      }),
      input.traceId,
    ),
    state: 'degraded',
  }
}

export async function executeWestDigitalWriteOperation(
  req: PayloadRequest,
  input: WestDigitalWriteOperationInput,
  provider: WestDigitalWriteProvider | WestDigitalManagedProvider,
): Promise<Result<WestDigitalOperationView>> {
  const operationKey = generateWestDigitalOperationKey(input)
  const prepared = await prepareOperation(req, input, operationKey)
  let operation = prepared.operation
  let providerWriteAttempted = false

  if (operation.status === 'succeeded' || operation.status === 'failed') {
    return result(operation, true, input.traceId)
  }
  if (operation.status === 'submitted' || operation.status === 'unknown') {
    const queried = await queryStatus(provider, input, operation)
    if (confirmed(input, queried)) {
      operation = await recordOutcome(
        req,
        input,
        operation,
        {
          lastCheckedAt: new Date().toISOString(),
          safeResult: queried?.ok
            ? {
                ...(operation.safeResult as Record<string, unknown>),
                confirmed: true,
                requestId: queried.requestId,
              }
            : { ...(operation.safeResult as Record<string, unknown>), confirmed: false },
          status: 'succeeded',
        },
        'status_confirmed',
        queried?.requestId,
      )
    } else {
      operation = await recordOutcome(
        req,
        input,
        operation,
        {
          lastCheckedAt: new Date().toISOString(),
          safeResult: queried?.ok
            ? {
                ...(operation.safeResult as Record<string, unknown>),
                confirmed: false,
                providerState: 'state' in queried.data ? queried.data.state : 'not_matched',
              }
            : {
                ...(operation.safeResult as Record<string, unknown>),
                confirmed: false,
                errorCode: queried?.error.code ?? 'QUERY_NOT_POSSIBLE',
              },
          status: 'unknown',
        },
        'status_unknown',
        queried?.requestId,
      )
    }
    return result(operation, true, input.traceId)
  }

  try {
    if (input.operation !== 'realname' && input.operation !== 'register') {
      await assertWestDigitalDomainOwnership(
        req,
        {
          actor: input.actor,
          domainAscii: input.domainAscii,
          targetId: input.targetId,
          traceId: `${input.traceId}-ownership`,
        },
        provider,
      )
    }
    const authorization = authorizeWestDigitalWrite(input, operationKey)
    if (authorization) await consumeProviderWriteBudget(req, authorization)
  } catch (error) {
    if (error instanceof ProviderWriteGuardError) {
      return safetyRejectedResult(req, input, operation, error)
    }
    throw error
  }

  while (operation.status === 'prepared') {
    const claimed = await claimAttempt(req, input, operation)
    if (!claimed) {
      operation = (await findOperation(req, operationKey)) ?? operation
      if (operation.status !== 'prepared')
        return executeWestDigitalWriteOperation(req, input, provider)
      operation = await recordOutcome(
        req,
        input,
        operation,
        { lastErrorCode: 'WESTDIGITAL_RETRY_LIMIT_EXHAUSTED', status: 'failed' },
        'retry_exhausted',
      )
      break
    }
    operation = claimed
    providerWriteAttempted = true
    const submitted = await submit(provider, input)
    const safeResult = safeProviderResult(submitted)
    if (!submitted.ok) {
      const retryable =
        submitted.error.statusKnown &&
        submitted.error.retryable &&
        isExplicitlyRetryableWestDigitalWriteError(submitted.error.code)
      const attempts = operation.attemptCount ?? 0
      const maxAttempts = operation.maxAttempts ?? WESTDIGITAL_WRITE_MAX_ATTEMPTS
      if (retryable && attempts < maxAttempts) {
        operation = await recordOutcome(
          req,
          input,
          operation,
          { lastErrorCode: submitted.error.code, safeResult, status: 'prepared' },
          'retry_scheduled',
          submitted.requestId,
        )
        continue
      }
      operation = await recordOutcome(
        req,
        input,
        operation,
        {
          lastErrorCode: submitted.error.code,
          providerRequestId: submitted.requestId,
          safeResult,
          status: submitted.error.statusKnown ? 'failed' : 'unknown',
          submittedAt: submitted.observedAt,
        },
        submitted.error.statusKnown ? 'failed' : 'status_unknown',
        submitted.requestId,
      )
      break
    }
    operation = await recordOutcome(
      req,
      input,
      operation,
      {
        providerRequestId: submitted.requestId,
        safeResult,
        status: 'submitted',
        submittedAt: submitted.observedAt,
      },
      'submitted',
      submitted.requestId,
    )
    if (submitted.data.state === 'succeeded') {
      operation = await recordOutcome(
        req,
        input,
        operation,
        {
          lastCheckedAt: new Date().toISOString(),
          safeResult: { ...safeResult, confirmed: true },
          status: 'succeeded',
        },
        'status_confirmed',
        submitted.requestId,
      )
      break
    }
    const queried = await queryStatus(provider, input, operation)
    operation = await recordOutcome(
      req,
      input,
      operation,
      {
        lastCheckedAt: new Date().toISOString(),
        safeResult: {
          ...safeResult,
          confirmed: confirmed(input, queried),
          queryRequestId: queried?.requestId,
        },
        status: confirmed(input, queried) ? 'succeeded' : 'unknown',
      },
      confirmed(input, queried) ? 'status_confirmed' : 'status_unknown',
      queried?.requestId,
    )
    break
  }
  return result(operation, !providerWriteAttempted, input.traceId)
}

export async function queryWestDigitalAsset(
  req: PayloadRequest,
  input: { actor: AuditActor; domainAscii: string; targetId: number | string; traceId: string },
  provider: WestDigitalWriteProvider,
): Promise<Result<WestDigitalDomainAsset>> {
  const requestIdentifier = `westdigital-query-${randomUUID()}`
  const queried = await provider.queryAsset(input)
  await recordAuditEvent(req, {
    action: 'provider.operation.recorded',
    actor: input.actor,
    metadata: {
      operation: 'query',
      outcome: queried.ok ? 'succeeded' : queried.error.statusKnown ? 'failed' : 'status_unknown',
      requestIdentifier,
      result: queried.ok
        ? { providerRequestId: queried.requestId }
        : { errorCode: queried.error.code },
      target: { id: String(input.targetId), type: 'domain' },
    },
    targetId: input.targetId,
  })
  const meta = {
    dataSource: westDigitalDataSource(),
    observedAt: queried.observedAt,
    traceId: input.traceId,
  }
  if (queried.ok) return { data: queried.data, meta, state: 'ready' }
  return {
    meta,
    problem: toProblemDetails(
      new AppError(queried.error.code, '域名资产状态暂时无法同步', 503, {
        action: queried.error.retryable ? '请稍后重试查询' : '请转人工核对',
        dataSource: westDigitalDataSource(),
        observedAt: queried.observedAt,
        retryable: queried.error.retryable,
        title: queried.error.statusKnown ? '资产查询失败' : '资产状态不明',
      }),
      input.traceId,
    ),
    state: 'error',
  }
}

export async function assertWestDigitalDomainOwnership(
  req: PayloadRequest,
  input: { actor: AuditActor; domainAscii: string; targetId: number | string; traceId: string },
  provider: WestDigitalWriteProvider,
): Promise<WestDigitalDomainAsset> {
  const queried = await queryWestDigitalAsset(req, input, provider)
  if (queried.state === 'ready') return queried.data
  const code =
    'problem' in queried && queried.problem.code === 'WESTDIGITAL_ASSET_NOT_IN_ACCOUNT'
      ? 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED'
      : 'DOMAIN_UPSTREAM_OWNERSHIP_UNCONFIRMED'
  throw new AppError(
    code,
    code === 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED'
      ? '该域名已不属于当前上游账户，已阻止操作'
      : '无法确认域名仍属于当前上游账户，已阻止操作',
    409,
    {
      action: '等待上游同步或转人工核对后再操作',
      dataSource: westDigitalDataSource(),
      observedAt: queried.meta?.observedAt,
      retryable: false,
      title: '上游域名归属未通过',
    },
  )
}
