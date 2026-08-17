import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import type {
  WestDigitalDomainContactType,
  WestDigitalDomainManagementProvider,
  WestDigitalRealnameProfile,
} from '@/providers/types'
import {
  domainCapabilitiesResultSchema,
  domainManagementMutationResultSchema,
  domainManagementPasswordResultSchema,
  type DomainContactUpdateRequest,
  type DomainManagementPasswordModifyRequest,
  type DomainManagementPasswordRevealRequest,
  type DomainTemplateTransferRequest,
} from '@/schemas/domain-management'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import {
  activeCustomerIdentities,
  notifyFormerCustomerIdentities,
} from '@/services/auth/customer-identities'
import { authorizeStepUpGrant } from '@/services/auth/step-up'
import {
  executeWestDigitalWriteOperation,
  generateWestDigitalOperationKey,
  assertWestDigitalDomainOwnership,
  type WestDigitalWriteOperationInput,
} from '@/services/providers/westdigital-operations'
import { realnameTemplateProviderProfile } from '@/services/realname/templates'

import {
  assertDomainCapability,
  domainCapabilityDeclaration,
  type DomainCapabilityDeclaration,
  WESTDIGITAL_DOMAIN_CAPABILITIES,
} from './capabilities'
import { findOwnedDomainAsset } from './domain-assets'

type CustomerIdentity = {
  collection: 'customers'
  id: number | string
  status?: null | string
}

type AssetRecord = Awaited<ReturnType<typeof findOwnedDomainAsset>> & {
  domainManagementLeaseExpiresAt?: null | string
  domainManagementLeaseKey?: null | string
  realnameTemplate: number | string | { id: number | string }
  syncVersion?: null | number
}

const DOMAIN_MANAGEMENT_LEASE_SECONDS = 60

type ManagementOperation =
  | 'certificate_download'
  | 'contact_information_update'
  | 'management_password_modify'
  | 'management_password_read'
  | 'template_transfer'

type ManagementEvent = 'confirmed' | 'failed' | 'pending_query' | 'requested'

type EventRecord = { id: number | string }

type ApprovedTemplate = Record<string, unknown> & {
  id: number | string
  providerTemplateId: string
}

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
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
    throw new AppError('DOMAIN_MANAGEMENT_CAS_UNAVAILABLE', '无法原子执行域名管理变更', 503)
  }
  return current
}

async function claimManagementLease(
  req: PayloadRequest,
  asset: AssetRecord,
  leaseKey: string,
): Promise<void> {
  await transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE domain_assets
      SET domain_management_lease_key = ${leaseKey},
          domain_management_lease_expires_at =
            NOW() + (${DOMAIN_MANAGEMENT_LEASE_SECONDS} * INTERVAL '1 second'),
          updated_at = NOW()
      WHERE id = ${asset.id}
        AND sync_version = ${asset.syncVersion ?? 0}
        AND (
          domain_management_lease_key IS NULL
          OR domain_management_lease_expires_at <= NOW()
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
      current.domainManagementLeaseKey &&
      current.domainManagementLeaseKey !== leaseKey &&
      new Date(current.domainManagementLeaseExpiresAt ?? 0).getTime() > Date.now()
    ) {
      throw new AppError(
        'DOMAIN_MANAGEMENT_OPERATION_IN_PROGRESS',
        '该域名已有管理操作正在处理',
        409,
      )
    }
    throw new AppError('DOMAIN_MANAGEMENT_STATE_CONFLICT', '域名管理状态发生并发冲突', 409)
  })
}

async function releaseManagementLease(
  req: PayloadRequest,
  asset: AssetRecord,
  leaseKey: string,
): Promise<void> {
  await transaction(req, async () => {
    const released = await (
      await database(req)
    ).execute(sql`
      UPDATE domain_assets
      SET domain_management_lease_key = NULL,
          domain_management_lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${asset.id}
        AND domain_management_lease_key = ${leaseKey}
      RETURNING id
    `)
    if (released.rows?.[0]?.id === undefined) {
      throw new AppError(
        'DOMAIN_MANAGEMENT_OPERATION_LEASE_LOST',
        '域名管理操作互斥状态无法确认',
        503,
      )
    }
  })
}

async function withManagementLease<T>(
  req: PayloadRequest,
  asset: AssetRecord,
  leaseKey: string,
  work: () => Promise<T>,
): Promise<T> {
  await claimManagementLease(req, asset, leaseKey)
  try {
    return await work()
  } finally {
    await releaseManagementLease(req, asset, leaseKey)
  }
}

async function findEvent(req: PayloadRequest, eventKey: string): Promise<EventRecord | undefined> {
  const found = await req.payload.find({
    collection: 'domainManagementEvents',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { eventKey: { equals: eventKey } },
  })
  return found.docs[0] as unknown as EventRecord | undefined
}

async function appendManagementEvent(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    contactType?: WestDigitalDomainContactType
    customerId: number | string
    errorCode?: string
    event: ManagementEvent
    eventRoot: string
    operation: ManagementOperation
    operationKey?: string
    providerOperationId?: string
    templateId?: number | string
    traceId: string
  },
): Promise<EventRecord> {
  const eventKey = `${input.eventRoot}:${input.event}`
  const existing = await findEvent(req, eventKey)
  if (existing) return existing
  try {
    return await transaction(req, async () => {
      const event = (await req.payload.create({
        collection: 'domainManagementEvents',
        data: {
          asset: input.asset.id as never,
          contactType: input.contactType,
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
          realnameTemplate: input.templateId as never,
          traceId: input.traceId,
        },
        overrideAccess: true,
        req,
      })) as unknown as EventRecord
      await recordAuditEvent(req, {
        action: 'domain.management.operation_recorded',
        actor: { id: input.customerId, type: 'customer' },
        metadata: {
          contactType: input.contactType,
          errorCode: input.errorCode,
          event: input.event,
          operation: input.operation,
        },
        targetId: event.id,
      })
      return event
    })
  } catch (error) {
    const raced = await findEvent(req, eventKey)
    if (raced) return raced
    throw error
  }
}

function customerNumber(customer: CustomerIdentity): number {
  const id = Number(customer.id)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AppError('CUSTOMER_ID_INVALID', '用户身份无效', 401)
  }
  return id
}

async function authorizePasswordRisk(
  req: PayloadRequest,
  customer: CustomerIdentity,
  input: DomainManagementPasswordRevealRequest | DomainManagementPasswordModifyRequest,
) {
  await authorizeStepUpGrant(req, {
    customerId: customer.id,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: 'domain_management_password',
    stepUpToken: input.stepUpToken,
  })
  const identities = await activeCustomerIdentities(req, customerNumber(customer))
  if (!identities.length) {
    throw new AppError(
      'DOMAIN_BOUND_CHANNEL_CONFIRMATION_REQUIRED',
      '当前账号没有可确认的绑定渠道',
      409,
    )
  }
  return identities
}

async function assertUpstreamOwnership(
  req: PayloadRequest,
  asset: AssetRecord,
  customer: CustomerIdentity,
  provider: WestDigitalDomainManagementProvider,
  traceId: string,
) {
  return assertWestDigitalDomainOwnership(
    req,
    {
      actor: { id: customer.id, type: 'customer' },
      domainAscii: asset.domainAscii,
      targetId: asset.id,
      traceId,
    },
    provider,
  )
}

async function approvedOwnedTemplate(
  req: PayloadRequest,
  customer: CustomerIdentity,
  templateId: number | string,
): Promise<{ profile: WestDigitalRealnameProfile; template: ApprovedTemplate }> {
  const visible = await req.payload.find({
    collection: 'realnameTemplates',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req,
    user: req.user,
    where: {
      and: [{ id: { equals: templateId } }, { customer: { equals: customer.id } }],
    },
  })
  if (!visible.docs[0]) {
    throw new AppError('REALNAME_TEMPLATE_NOT_OWNED', '目标实名模板不属于当前用户', 409)
  }
  const template = (await req.payload.findByID({
    collection: 'realnameTemplates',
    depth: 0,
    id: visible.docs[0].id,
    overrideAccess: true,
    req,
  })) as unknown as ApprovedTemplate & {
    providerConfirmedAt?: unknown
    providerReviewState?: unknown
    status?: unknown
  }
  if (
    template.status !== 'approved' ||
    template.providerReviewState !== 'approved' ||
    typeof template.providerConfirmedAt !== 'string' ||
    !/^\d+$/u.test(template.providerTemplateId)
  ) {
    throw new AppError('REALNAME_TEMPLATE_NOT_APPROVED', '目标实名模板尚未通过审核', 409)
  }
  return { profile: realnameTemplateProviderProfile(template), template }
}

function publicMutationResult(
  result: Awaited<ReturnType<typeof executeWestDigitalWriteOperation>>,
) {
  if (!('data' in result)) return domainManagementMutationResultSchema.parse(result)
  const data = {
    idempotentReplay: result.data.idempotentReplay,
    operationId: result.data.operationId,
    operationKey: result.data.operationKey,
    status: result.data.status,
  }
  return domainManagementMutationResultSchema.parse({ ...result, data })
}

function resultEvent(result: ReturnType<typeof publicMutationResult>): ManagementEvent {
  if (!('data' in result)) return 'failed'
  if (result.data.status === 'succeeded') return 'confirmed'
  if (result.data.status === 'failed') return 'failed'
  return 'pending_query'
}

export async function revealDomainManagementPassword(
  req: PayloadRequest,
  assetId: number | string,
  input: DomainManagementPasswordRevealRequest,
  options: {
    capabilities?: DomainCapabilityDeclaration
    customer: CustomerIdentity
    provider: WestDigitalDomainManagementProvider
    traceId: string
  },
) {
  assertDomainCapability(
    'management_password_read',
    options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,
  )
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const identities = await authorizePasswordRisk(req, options.customer, input)
  await assertUpstreamOwnership(req, asset, options.customer, options.provider, options.traceId)
  const eventRoot = `management-password-read:${asset.id}:${randomUUID()}`
  await appendManagementEvent(req, {
    asset,
    customerId: options.customer.id,
    event: 'requested',
    eventRoot,
    operation: 'management_password_read',
    traceId: options.traceId,
  })
  const result = await options.provider.getDomainManagementPassword({
    domainAscii: asset.domainAscii,
    traceId: options.traceId,
  })
  if (!result.ok) {
    await appendManagementEvent(req, {
      asset,
      customerId: options.customer.id,
      errorCode: result.error.code,
      event: 'failed',
      eventRoot,
      operation: 'management_password_read',
      traceId: options.traceId,
    })
    throw new AppError(result.error.code, '域名管理密码暂时无法获取', 503)
  }
  await appendManagementEvent(req, {
    asset,
    customerId: options.customer.id,
    event: 'confirmed',
    eventRoot,
    operation: 'management_password_read',
    traceId: options.traceId,
  })
  await notifyFormerCustomerIdentities(
    req,
    customerNumber(options.customer),
    identities,
    options.traceId,
  )
  return domainManagementPasswordResultSchema.parse({
    data: { managementPassword: result.data.managementPassword },
    meta: { observedAt: result.observedAt, traceId: options.traceId },
    state: 'ready',
  })
}

export async function modifyDomainManagementPassword(
  req: PayloadRequest,
  assetId: number | string,
  input: DomainManagementPasswordModifyRequest,
  options: {
    capabilities?: DomainCapabilityDeclaration
    customer: CustomerIdentity
    provider: WestDigitalDomainManagementProvider
    traceId: string
  },
) {
  assertDomainCapability(
    'management_password_write',
    options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,
  )
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  const identities = await authorizePasswordRisk(req, options.customer, input)
  await assertUpstreamOwnership(req, asset, options.customer, options.provider, options.traceId)
  const writeInput: WestDigitalWriteOperationInput = {
    actor: { id: options.customer.id, type: 'customer' },
    businessKey: input.idempotencyKey,
    domainAscii: asset.domainAscii,
    managementPassword: input.managementPassword,
    operation: 'domain_management_password',
    targetId: asset.id,
    traceId: options.traceId,
  }
  const operationKey = generateWestDigitalOperationKey(writeInput)
  return withManagementLease(req, asset, operationKey, async () => {
    await appendManagementEvent(req, {
      asset,
      customerId: options.customer.id,
      event: 'requested',
      eventRoot: operationKey,
      operation: 'management_password_modify',
      operationKey,
      traceId: options.traceId,
    })
    const result = publicMutationResult(
      await executeWestDigitalWriteOperation(req, writeInput, options.provider),
    )
    await appendManagementEvent(req, {
      asset,
      customerId: options.customer.id,
      errorCode: 'problem' in result ? result.problem.code : undefined,
      event: resultEvent(result),
      eventRoot: operationKey,
      operation: 'management_password_modify',
      operationKey,
      providerOperationId: 'data' in result ? result.data.operationId : undefined,
      traceId: options.traceId,
    })
    await notifyFormerCustomerIdentities(
      req,
      customerNumber(options.customer),
      identities,
      options.traceId,
    )
    return result
  })
}

async function authorizeRealnameChange(
  req: PayloadRequest,
  customer: CustomerIdentity,
  input: DomainContactUpdateRequest | DomainTemplateTransferRequest,
) {
  if (input.confirmed !== true) {
    throw new AppError('DOMAIN_REALNAME_CONFIRMATION_REQUIRED', '修改实名信息需要二次确认', 400)
  }
  await authorizeStepUpGrant(req, {
    customerId: customer.id,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: 'realname_change',
    stepUpToken: input.stepUpToken,
  })
}

export async function updateDomainContactInformation(
  req: PayloadRequest,
  assetId: number | string,
  input: DomainContactUpdateRequest,
  options: {
    capabilities?: DomainCapabilityDeclaration
    customer: CustomerIdentity
    provider: WestDigitalDomainManagementProvider
    traceId: string
  },
) {
  assertDomainCapability(
    'contact_information_update',
    options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,
  )
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  await authorizeRealnameChange(req, options.customer, input)
  const { profile, template } = await approvedOwnedTemplate(req, options.customer, input.templateId)
  await assertUpstreamOwnership(req, asset, options.customer, options.provider, options.traceId)
  const writeInput: WestDigitalWriteOperationInput = {
    actor: { id: options.customer.id, type: 'customer' },
    businessKey: input.idempotencyKey,
    contactType: input.contactType,
    domainAscii: asset.domainAscii,
    operation: 'domain_contact_update',
    profile,
    targetId: asset.id,
    traceId: options.traceId,
  }
  const operationKey = generateWestDigitalOperationKey(writeInput)
  return withManagementLease(req, asset, operationKey, async () => {
    await appendManagementEvent(req, {
      asset,
      contactType: input.contactType,
      customerId: options.customer.id,
      event: 'requested',
      eventRoot: operationKey,
      operation: 'contact_information_update',
      operationKey,
      templateId: template.id,
      traceId: options.traceId,
    })
    const result = publicMutationResult(
      await executeWestDigitalWriteOperation(req, writeInput, options.provider),
    )
    await appendManagementEvent(req, {
      asset,
      contactType: input.contactType,
      customerId: options.customer.id,
      errorCode: 'problem' in result ? result.problem.code : undefined,
      event: resultEvent(result),
      eventRoot: operationKey,
      operation: 'contact_information_update',
      operationKey,
      providerOperationId: 'data' in result ? result.data.operationId : undefined,
      templateId: template.id,
      traceId: options.traceId,
    })
    return result
  })
}

async function updateLocalTransferFact(
  req: PayloadRequest,
  asset: AssetRecord,
  targetTemplateId: number | string,
): Promise<void> {
  const currentTemplateId = relationId(asset.realnameTemplate)
  if (String(currentTemplateId) === String(targetTemplateId)) return
  await transaction(req, async () => {
    const updated = await (
      await database(req)
    ).execute(sql`
      UPDATE domain_assets
      SET realname_template_id = ${targetTemplateId},
          sync_version = sync_version + 1,
          updated_at = NOW()
      WHERE id = ${asset.id}
        AND realname_template_id = ${currentTemplateId}
        AND sync_version = ${asset.syncVersion ?? 0}
      RETURNING id
    `)
    if (updated.rows?.[0]?.id === undefined) {
      throw new AppError(
        'DOMAIN_TRANSFER_LOCAL_STATE_CONFLICT',
        '过户已完成但本地域名资产状态发生冲突，需人工核对',
        409,
      )
    }
  })
}

export async function transferDomainToApprovedTemplate(
  req: PayloadRequest,
  assetId: number | string,
  input: DomainTemplateTransferRequest,
  options: {
    capabilities?: DomainCapabilityDeclaration
    customer: CustomerIdentity
    provider: WestDigitalDomainManagementProvider
    traceId: string
  },
) {
  assertDomainCapability(
    'template_transfer',
    options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,
  )
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  await authorizeRealnameChange(req, options.customer, input)
  const { template } = await approvedOwnedTemplate(req, options.customer, input.templateId)
  await assertUpstreamOwnership(req, asset, options.customer, options.provider, options.traceId)
  const writeInput: WestDigitalWriteOperationInput = {
    actor: { id: options.customer.id, type: 'customer' },
    businessKey: input.idempotencyKey,
    domainAscii: asset.domainAscii,
    operation: 'domain_template_transfer',
    providerTemplateId: template.providerTemplateId,
    targetId: asset.id,
    traceId: options.traceId,
  }
  const operationKey = generateWestDigitalOperationKey(writeInput)
  return withManagementLease(req, asset, operationKey, async () => {
    await appendManagementEvent(req, {
      asset,
      customerId: options.customer.id,
      event: 'requested',
      eventRoot: operationKey,
      operation: 'template_transfer',
      operationKey,
      templateId: template.id,
      traceId: options.traceId,
    })
    const result = publicMutationResult(
      await executeWestDigitalWriteOperation(req, writeInput, options.provider),
    )
    if ('data' in result && result.data.status === 'succeeded') {
      try {
        await updateLocalTransferFact(req, asset, template.id)
      } catch (error) {
        await appendManagementEvent(req, {
          asset,
          customerId: options.customer.id,
          errorCode: 'DOMAIN_TRANSFER_LOCAL_STATE_CONFLICT',
          event: 'pending_query',
          eventRoot: operationKey,
          operation: 'template_transfer',
          operationKey,
          providerOperationId: result.data.operationId,
          templateId: template.id,
          traceId: options.traceId,
        })
        throw error
      }
    }
    await appendManagementEvent(req, {
      asset,
      customerId: options.customer.id,
      errorCode: 'problem' in result ? result.problem.code : undefined,
      event: resultEvent(result),
      eventRoot: operationKey,
      operation: 'template_transfer',
      operationKey,
      providerOperationId: 'data' in result ? result.data.operationId : undefined,
      templateId: template.id,
      traceId: options.traceId,
    })
    return result
  })
}

function decodeCertificate(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new AppError('WESTDIGITAL_CERTIFICATE_INVALID', '域名证书响应格式无效', 503)
  }
  return Buffer.from(value, 'base64')
}

export async function downloadDomainCertificate(
  req: PayloadRequest,
  assetId: number | string,
  options: {
    capabilities?: DomainCapabilityDeclaration
    customer: CustomerIdentity
    provider: WestDigitalDomainManagementProvider
    traceId: string
  },
): Promise<{ bytes: Uint8Array; domainAscii: string }> {
  assertDomainCapability(
    'certificate_download',
    options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,
  )
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord
  await assertUpstreamOwnership(req, asset, options.customer, options.provider, options.traceId)
  const eventRoot = `certificate-download:${asset.id}:${randomUUID()}`
  await appendManagementEvent(req, {
    asset,
    customerId: options.customer.id,
    event: 'requested',
    eventRoot,
    operation: 'certificate_download',
    traceId: options.traceId,
  })
  const result = await options.provider.getDomainCertificate({
    domainAscii: asset.domainAscii,
    traceId: options.traceId,
  })
  if (!result.ok) {
    await appendManagementEvent(req, {
      asset,
      customerId: options.customer.id,
      errorCode: result.error.code,
      event: 'failed',
      eventRoot,
      operation: 'certificate_download',
      traceId: options.traceId,
    })
    throw new AppError(result.error.code, '域名证书暂时无法下载', 503)
  }
  const bytes = decodeCertificate(result.data.certificateBase64)
  await appendManagementEvent(req, {
    asset,
    customerId: options.customer.id,
    event: 'confirmed',
    eventRoot,
    operation: 'certificate_download',
    traceId: options.traceId,
  })
  return { bytes, domainAscii: asset.domainAscii }
}

export async function getDomainCapabilityDeclaration(
  req: PayloadRequest,
  assetId: number | string,
  options: {
    capabilities?: DomainCapabilityDeclaration
    customer: CustomerIdentity
  },
) {
  await findOwnedDomainAsset(req, assetId, options.customer)
  return domainCapabilitiesResultSchema.parse({
    data: {
      capabilities: domainCapabilityDeclaration(
        options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,
      ),
    },
    state: 'ready',
  })
}
