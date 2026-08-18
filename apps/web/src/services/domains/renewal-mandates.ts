import { createHash, randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'
import { z } from 'zod'

import { isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import {
  renewalMandatePreviewRequestSchema,
  renewalMandatePreviewResultSchema,
  renewalMandateChangeRequestSchema,
  renewalMandateResultSchema,
  type RenewalMandatePreviewRequest,
} from '@/schemas/domains'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import { authorizeStepUpGrant } from '@/services/auth/step-up'

import {
  AUTOMATIC_RENEWAL_MANDATE_MAX_VALIDITY_MS,
  AUTOMATIC_RENEWAL_PREVIEW_TTL_MS,
  automaticRenewalDaysRemaining,
  automaticRenewalRules,
} from './automatic-renewal-rules'
import { decodeBoundChangePreview, signBoundChangePreview } from './change-preview'
import { sendAutomaticRenewalReminder } from './expiry-reminders'

type CustomerIdentity = {
  collection: 'customers'
  id: number
  status?: string
}

export type RenewalMandateRecord = {
  asset: number | string | { id: number | string }
  authorizedAt: string
  currency: 'CNY'
  customer: number | string | { id: number | string }
  domainAsciiSnapshot: string
  eventType: 'authorized' | 'revoked'
  id: number | string
  mandateKey: string
  maxDebitFen: number
  revision: number
  revokedAt?: null | string
  rulesVersion: string
  scope: 'renew_one_year'
  validUntil: string
}

type AssetRecord = {
  customer: number | string | { id: number | string }
  domainAscii: string
  expiresAt: string
  id: number | string
  status: string
}

type MandateDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

const previewPayloadSchema = z.strictObject({
  action: z.enum(['authorize', 'revoke']),
  assetId: z.union([z.number(), z.string()]),
  customerId: z.union([z.number(), z.string()]),
  domainAscii: z.string().min(1).max(253),
  expiresAt: z.iso.datetime(),
  maxDebitFen: z.number().int().positive().safe().optional(),
  nonce: z.uuid(),
  rulesVersion: z.string().min(1).max(64),
  scope: z.literal('renew_one_year').optional(),
  validUntil: z.iso.datetime().optional(),
})

function assertCustomer(req: PayloadRequest, customer: CustomerIdentity): void {
  if (!isCustomerUser(req.user) || String(req.user.id) !== String(customer.id)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
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

async function database(req: PayloadRequest): Promise<MandateDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as MandateDatabase | undefined
  if (!current) {
    throw new AppError('RENEWAL_MANDATE_TRANSACTION_UNAVAILABLE', '无法安全变更自动续费授权', 503)
  }
  return current
}

async function findOwnedAsset(
  req: PayloadRequest,
  assetId: number | string,
  customer: CustomerIdentity,
): Promise<AssetRecord> {
  const found = await req.payload.find({
    collection: 'domainAssets',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req,
    user: customer,
    where: { and: [{ id: { equals: assetId } }, { customer: { equals: customer.id } }] },
  })
  const asset = found.docs[0] as unknown as AssetRecord | undefined
  if (!asset) throw new AppError('DOMAIN_ASSET_NOT_FOUND', '未找到域名资产', 404)
  return asset
}

export async function findCurrentRenewalMandate(
  req: PayloadRequest,
  assetId: number | string,
): Promise<RenewalMandateRecord | undefined> {
  const found = await req.payload.find({
    collection: 'renewalMandates',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    sort: '-revision',
    where: { asset: { equals: assetId } },
  })
  return found.docs[0] as unknown as RenewalMandateRecord | undefined
}

async function lockOwnedAsset(
  req: PayloadRequest,
  assetId: number | string,
  customerId: number | string,
): Promise<AssetRecord> {
  const locked = await (
    await database(req)
  ).execute(sql`
    UPDATE domain_assets
    SET updated_at = NOW()
    WHERE id = ${assetId}
      AND customer_id = ${customerId}
    RETURNING id, customer_id, domain_ascii, expires_at, status
  `)
  const row = locked.rows?.[0]
  if (!row) throw new AppError('DOMAIN_ASSET_NOT_FOUND', '未找到域名资产', 404)
  return {
    customer: row.customer_id as number | string,
    domainAscii: String(row.domain_ascii),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    id: row.id as number | string,
    status: String(row.status),
  }
}

function view(mandate: RenewalMandateRecord | undefined) {
  if (!mandate) return null
  return {
    authorizedAt: mandate.authorizedAt,
    currency: mandate.currency,
    domainAscii: mandate.domainAsciiSnapshot,
    eventType: mandate.eventType,
    id: String(mandate.id),
    maxDebitFen: mandate.maxDebitFen,
    revision: mandate.revision,
    ...(mandate.revokedAt ? { revokedAt: mandate.revokedAt } : {}),
    rulesVersion: mandate.rulesVersion,
    scope: mandate.scope,
    validUntil: mandate.validUntil,
  }
}

export async function getCustomerRenewalMandate(
  req: PayloadRequest,
  assetId: number | string,
  options: { customer: CustomerIdentity; traceId: string },
) {
  assertCustomer(req, options.customer)
  await findOwnedAsset(req, assetId, options.customer)
  const current = await findCurrentRenewalMandate(req, assetId)
  return renewalMandateResultSchema.parse({
    data: { mandate: view(current) },
    meta: { observedAt: new Date().toISOString(), traceId: options.traceId },
    state: 'ready',
  })
}

export async function previewCustomerRenewalMandateChange(
  req: PayloadRequest,
  assetId: number | string,
  candidate: RenewalMandatePreviewRequest,
  options: {
    customer: CustomerIdentity
    now?: () => Date
    traceId: string
  },
) {
  assertCustomer(req, options.customer)
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const input = renewalMandatePreviewRequestSchema.parse(candidate)
  const now = (options.now ?? (() => new Date()))()
  const asset = await findOwnedAsset(req, assetId, options.customer)
  const rules = automaticRenewalRules()
  const current = await findCurrentRenewalMandate(req, asset.id)
  if (input.action === 'authorize') {
    const amount = BigInt(input.maxDebitFen)
    if (amount <= 0n || amount > rules.mandateMaxFen) {
      throw new AppError(
        'RENEWAL_MANDATE_MAX_DEBIT_INVALID',
        '最大自动扣款金额无效或超出允许范围',
        400,
      )
    }
    const validUntilMs = Date.parse(input.validUntil)
    if (
      !Number.isFinite(validUntilMs) ||
      validUntilMs <= now.getTime() ||
      validUntilMs - now.getTime() > AUTOMATIC_RENEWAL_MANDATE_MAX_VALIDITY_MS
    ) {
      throw new AppError('RENEWAL_MANDATE_VALIDITY_INVALID', '自动续费授权有效期无效', 400)
    }
    if (asset.status !== 'active') {
      throw new AppError('DOMAIN_ASSET_NOT_RENEWABLE', '域名当前状态不可启用自动续费', 409)
    }
  } else if (!current || current.eventType !== 'authorized') {
    throw new AppError('RENEWAL_MANDATE_NOT_ACTIVE', '自动续费尚未启用', 409)
  }
  const expiresAt = new Date(now.getTime() + AUTOMATIC_RENEWAL_PREVIEW_TTL_MS).toISOString()
  const previewToken = signBoundChangePreview({
    action: input.action,
    assetId: String(asset.id),
    customerId: String(options.customer.id),
    domainAscii: asset.domainAscii,
    expiresAt,
    ...(input.action === 'authorize'
      ? {
          maxDebitFen: input.maxDebitFen,
          scope: input.scope,
          validUntil: input.validUntil,
        }
      : {}),
    nonce: randomUUID(),
    rulesVersion: rules.version,
  })
  return renewalMandatePreviewResultSchema.parse({
    data: {
      action: input.action,
      domainAscii: asset.domainAscii,
      firstAttemptDays: rules.firstAttemptDays,
      ...(input.action === 'authorize'
        ? {
            maxDebitFen: input.maxDebitFen,
            scope: input.scope,
            validUntil: input.validUntil,
          }
        : {}),
      previewExpiresAt: expiresAt,
      previewToken,
      reminderLimit: rules.balanceReminderLimit,
      retryDays: rules.retryDays,
      rulesVersion: rules.version,
      warning:
        input.action === 'authorize'
          ? `确认后，${asset.domainAscii} 将仅在续费金额不超过所示上限且余额充足时自动续费；余额不足不会透支。`
          : `确认后，${asset.domainAscii} 的自动续费立即关闭；已经入队但尚未提交上游的任务也会在执行时放弃。`,
    },
    meta: { observedAt: now.toISOString(), traceId: options.traceId },
    state: 'ready',
  })
}

export async function changeCustomerRenewalMandate(
  req: PayloadRequest,
  assetId: number | string,
  input: {
    confirmed: true
    deviceId: string
    previewToken: string
    stepUpToken: string
  },
  options: {
    customer: CustomerIdentity
    expectedAction: 'authorize' | 'revoke'
    now?: () => Date
    traceId: string
  },
) {
  assertCustomer(req, options.customer)
  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')
  const command = renewalMandateChangeRequestSchema.parse(input)
  const now = (options.now ?? (() => new Date()))()
  const decoded = previewPayloadSchema.parse(
    decodeBoundChangePreview(command.previewToken, {
      code: 'RENEWAL_MANDATE_PREVIEW_INVALID',
      message: '自动续费确认内容无效或已变化，请重新预览',
    }),
  )
  const rules = automaticRenewalRules()
  if (
    String(decoded.assetId) !== String(assetId) ||
    String(decoded.customerId) !== String(options.customer.id) ||
    decoded.action !== options.expectedAction ||
    decoded.rulesVersion !== rules.version ||
    Date.parse(decoded.expiresAt) <= now.getTime()
  ) {
    throw new AppError(
      'RENEWAL_MANDATE_PREVIEW_INVALID',
      '自动续费确认内容无效或已过期，请重新预览',
      409,
    )
  }
  if (decoded.action === 'authorize') {
    const amount = BigInt(decoded.maxDebitFen ?? 0)
    const validUntilMs = Date.parse(decoded.validUntil ?? '')
    if (
      decoded.scope !== 'renew_one_year' ||
      amount <= 0n ||
      amount > rules.mandateMaxFen ||
      !Number.isFinite(validUntilMs) ||
      validUntilMs <= now.getTime() ||
      validUntilMs - now.getTime() > AUTOMATIC_RENEWAL_MANDATE_MAX_VALIDITY_MS
    ) {
      throw new AppError('RENEWAL_MANDATE_PREVIEW_INVALID', '自动续费确认内容已失效', 409)
    }
  }
  const mandate = await transaction(req, async () => {
    const asset = await lockOwnedAsset(req, assetId, options.customer.id)
    if (asset.domainAscii !== decoded.domainAscii) {
      throw new AppError('RENEWAL_MANDATE_PREVIEW_INVALID', '域名资产已变化，请重新预览', 409)
    }
    const current = await findCurrentRenewalMandate(req, asset.id)
    if (decoded.action === 'authorize' && asset.status !== 'active') {
      throw new AppError('DOMAIN_ASSET_NOT_RENEWABLE', '域名当前状态不可启用自动续费', 409)
    }
    if (decoded.action === 'revoke' && (!current || current.eventType !== 'authorized')) {
      throw new AppError('RENEWAL_MANDATE_NOT_ACTIVE', '自动续费尚未启用', 409)
    }
    const grant = await authorizeStepUpGrant(req, {
      customerId: options.customer.id,
      deviceId: command.deviceId,
      headers: req.headers,
      purpose: 'renewal_mandate_change',
      stepUpToken: command.stepUpToken,
    })
    const authorizedAt = decoded.action === 'authorize' ? now.toISOString() : current!.authorizedAt
    const created = (await req.payload.create({
      collection: 'renewalMandates',
      data: {
        asset: asset.id as never,
        authorizedAt,
        currency: 'CNY',
        customer: options.customer.id,
        domainAsciiSnapshot: asset.domainAscii,
        eventType: decoded.action === 'authorize' ? 'authorized' : 'revoked',
        mandateKey: current?.mandateKey ?? `renewal-mandate:${randomUUID()}`,
        maxDebitFen: decoded.action === 'authorize' ? decoded.maxDebitFen! : current!.maxDebitFen,
        ...(current ? { previousMandate: current.id as never } : {}),
        previewDigest: createHash('sha256').update(command.previewToken).digest('hex'),
        revision: (current?.revision ?? 0) + 1,
        ...(decoded.action === 'revoke' ? { revokedAt: now.toISOString() } : {}),
        rulesVersion: rules.version,
        scope: decoded.action === 'authorize' ? decoded.scope! : current!.scope,
        stepUpGrantId: String(grant.grantId),
        validUntil: decoded.action === 'authorize' ? decoded.validUntil! : current!.validUntil,
        createdTraceId: options.traceId,
      },
      overrideAccess: true,
      req,
    })) as unknown as RenewalMandateRecord
    await recordAuditEvent(req, {
      action:
        decoded.action === 'authorize'
          ? 'domain.renewal_mandate.authorized'
          : 'domain.renewal_mandate.revoked',
      actor: { id: options.customer.id, type: 'customer' },
      metadata: {
        domainAscii: asset.domainAscii,
        maxDebitFen: created.maxDebitFen,
        revision: created.revision,
        rulesVersion: created.rulesVersion,
        scope: created.scope,
        validUntil: created.validUntil,
      },
      targetId: created.id,
    })
    return { asset, created }
  })
  if (decoded.action === 'authorize') {
    await sendAutomaticRenewalReminder(req, {
      amountFen: mandate.created.maxDebitFen,
      asset: mandate.asset,
      authorizedMaxAmountFen: mandate.created.maxDebitFen,
      customerId: options.customer.id,
      daysRemaining: automaticRenewalDaysRemaining(mandate.asset.expiresAt, now),
      mandateId: mandate.created.id,
      noticeType: 'automatic_renewal_enabled',
      traceId: `${options.traceId}:enabled`,
    })
  }
  return renewalMandateResultSchema.parse({
    data: { mandate: view(mandate.created) },
    meta: { observedAt: now.toISOString(), traceId: options.traceId },
    state: 'ready',
  })
}
