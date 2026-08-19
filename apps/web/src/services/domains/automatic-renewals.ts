import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import { createConfiguredWestDigitalReadProvider } from '@/providers/westdigital'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import type {
  SmsProvider,
  WestDigitalReadProvider,
  WestDigitalWriteProvider,
} from '@/providers/types'
import { createSmsProvider } from '@/providers/aliyunsms'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import type { AuditActor } from '@/services/audit/record-audit-event'
import { accountRestrictions } from '@/services/auth/account-state'
import { assertIdentityRiskCooldownInactive } from '@/services/auth/step-up'
import {
  claimBalancePaymentChannel,
  type BalancePaymentOrder,
} from '@/services/commerce/balance-payments'
import { createSystemAutomaticRenewalOrder } from '@/services/commerce/order-creation'
import { transitionOrder } from '@/services/commerce/order-state'
import {
  createCustomerQuote,
  PayloadCustomerDomainAssetStore,
  PayloadCustomerQuoteStore,
} from '@/services/pricing/customer-quotes'
import { loadEnabledPricingRules } from '@/services/pricing/price-rules'
import { PayloadPriceSnapshotStore } from '@/services/pricing/price-snapshots'
import { assertWestDigitalDomainOwnership } from '@/services/providers/westdigital-operations'
import { holdWalletBalance, readWalletBalance } from '@/services/wallet/ledger'
import { assertSingleSpendLimit, loadWalletFundsPolicy } from '@/services/wallet/policy'

import {
  automaticRenewalAttemptSlot,
  automaticRenewalDaysRemaining,
  automaticRenewalRules,
  type AutomaticRenewalRules,
} from './automatic-renewal-rules'
import { sendAutomaticRenewalReminder } from './expiry-reminders'
import { findCurrentRenewalMandate, type RenewalMandateRecord } from './renewal-mandates'

type AssetRecord = {
  customer: number | string | { id: number | string }
  domainAscii: string
  expiresAt: string
  id: number | string
  status: string
}

type CustomerRecord = {
  capabilityRestrictions?: unknown
  collection: 'customers'
  id: number
  status?: unknown
}

type AutomaticRenewalOrderRecord = BalancePaymentOrder & {
  automaticRenewalMandate?: null | number | string | { id: number | string }
  automaticRenewalAttemptKey?: null | string
  automaticRenewalRulesVersion?: null | string
  domainAsset?: null | number | string | { id: number | string }
  domainAscii: string
  operation?: 'registration' | 'renewal'
  quoteSnapshot?: unknown
}

type AutomaticRenewalDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type AutomaticRenewalCandidate = {
  asset: AssetRecord
  mandate: RenewalMandateRecord
}

export type AutomaticRenewalDependencies = {
  now?: () => Date
  orderNumber?: () => string
  readProvider: WestDigitalReadProvider
  rules?: AutomaticRenewalRules
  smsProvider?: SmsProvider
  writeProvider: WestDigitalWriteProvider
}

export type AutomaticRenewalOutcome = {
  assetId: string
  orderId?: string
  status: 'balance_insufficient' | 'duplicate' | 'not_due' | 'price_changed' | 'queued' | 'skipped'
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

async function database(req: PayloadRequest): Promise<AutomaticRenewalDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as AutomaticRenewalDatabase | undefined
  if (!current) {
    throw new AppError('AUTOMATIC_RENEWAL_TRANSACTION_UNAVAILABLE', '无法安全执行自动续费', 503)
  }
  return current
}

function compareIds(left: number | string, right: number | string): number {
  const leftValue = String(left)
  const rightValue = String(right)
  if (/^\d+$/u.test(leftValue) && /^\d+$/u.test(rightValue)) {
    const difference = BigInt(leftValue) - BigInt(rightValue)
    return difference < 0n ? -1 : difference > 0n ? 1 : 0
  }
  return leftValue.localeCompare(rightValue)
}

export function sortAutomaticRenewalCandidates<T extends AutomaticRenewalCandidate>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const expiryDifference = Date.parse(left.asset.expiresAt) - Date.parse(right.asset.expiresAt)
    return expiryDifference || compareIds(left.asset.id, right.asset.id)
  })
}

function currentRules(dependencies: AutomaticRenewalDependencies): AutomaticRenewalRules {
  return dependencies.rules ?? automaticRenewalRules()
}

async function loadAsset(req: PayloadRequest, assetId: number | string): Promise<AssetRecord> {
  try {
    return (await req.payload.findByID({
      collection: 'domainAssets',
      depth: 0,
      id: assetId,
      overrideAccess: true,
      req,
    })) as unknown as AssetRecord
  } catch {
    throw new AppError('DOMAIN_ASSET_NOT_FOUND', '未找到域名资产', 404)
  }
}

async function loadCustomer(req: PayloadRequest, customerId: number | string) {
  try {
    return (await req.payload.findByID({
      collection: 'customers',
      depth: 0,
      id: customerId,
      overrideAccess: true,
      req,
    })) as CustomerRecord
  } catch {
    throw new AppError('ACCOUNT_NOT_FOUND', '未找到账号', 404)
  }
}

function assertMandateAmount(mandate: RenewalMandateRecord, rules: AutomaticRenewalRules): bigint {
  if (!Number.isSafeInteger(mandate.maxDebitFen)) {
    throw new AppError('RENEWAL_MANDATE_MAX_DEBIT_INVALID', '自动续费授权上限无效', 409)
  }
  const maxDebitFen = BigInt(mandate.maxDebitFen)
  if (maxDebitFen <= 0n || maxDebitFen > rules.mandateMaxFen) {
    throw new AppError('RENEWAL_MANDATE_MAX_DEBIT_INVALID', '自动续费授权上限无效', 409)
  }
  return maxDebitFen
}

export async function assertAutomaticRenewalMandateValid(
  req: PayloadRequest,
  input: {
    amountFen?: bigint
    assetId: number | string
    expectedMandateId?: number | string
    expectedRulesVersion?: string
    now: Date
    rules: AutomaticRenewalRules
  },
): Promise<{ asset: AssetRecord; customer: CustomerRecord; mandate: RenewalMandateRecord }> {
  const mandate = await findCurrentRenewalMandate(req, input.assetId)
  if (!mandate) {
    throw new AppError('RENEWAL_MANDATE_REQUIRED', '未找到有效的自动续费授权', 409)
  }
  if (
    (input.expectedMandateId !== undefined &&
      String(mandate.id) !== String(input.expectedMandateId)) ||
    mandate.eventType !== 'authorized' ||
    mandate.revokedAt
  ) {
    throw new AppError('RENEWAL_MANDATE_REVOKED', '自动续费授权已撤销或被替换', 409)
  }
  if (Date.parse(mandate.validUntil) <= input.now.getTime()) {
    throw new AppError('RENEWAL_MANDATE_EXPIRED', '自动续费授权已过期', 409)
  }
  if (
    mandate.scope !== 'renew_one_year' ||
    mandate.rulesVersion !== input.rules.version ||
    (input.expectedRulesVersion !== undefined &&
      mandate.rulesVersion !== input.expectedRulesVersion)
  ) {
    throw new AppError('RENEWAL_MANDATE_RULES_CHANGED', '自动续费授权规则已变化，请重新授权', 409)
  }
  const maxDebitFen = assertMandateAmount(mandate, input.rules)
  if (input.amountFen !== undefined && input.amountFen > maxDebitFen) {
    throw new AppError('RENEWAL_PRICE_EXCEEDS_MANDATE', '续费价格超过授权上限，禁止扣款', 409)
  }
  const asset = await loadAsset(req, input.assetId)
  const customerId = relationId(asset.customer)
  if (
    String(relationId(mandate.asset)) !== String(asset.id) ||
    String(relationId(mandate.customer)) !== String(customerId) ||
    mandate.domainAsciiSnapshot !== asset.domainAscii ||
    asset.status !== 'active' ||
    Date.parse(asset.expiresAt) <= input.now.getTime()
  ) {
    throw new AppError('AUTOMATIC_RENEWAL_ASSET_INVALID', '域名资产已变化或当前不可普通续费', 409)
  }
  const customer = await loadCustomer(req, customerId)
  const policy = await loadWalletFundsPolicy(req)
  const restrictions = accountRestrictions(customer)
  const emergencyRenewalAllowed =
    policy.allowRestrictedAccountEmergencyRenewal &&
    customer.status === 'restricted' &&
    restrictions.length === 1 &&
    restrictions[0] === 'balance_spend_disabled'
  if (customer.status !== 'active' && !emergencyRenewalAllowed) {
    throw new AppError('AUTOMATIC_RENEWAL_ACCOUNT_RESTRICTED', '账号受限，自动续费已放弃', 403)
  }
  if (input.amountFen !== undefined) assertSingleSpendLimit(policy, input.amountFen)
  await assertIdentityRiskCooldownInactive(req, customer.id)
  return { asset, customer, mandate }
}

async function assertUpstreamRenewable(
  req: PayloadRequest,
  input: { actor: AuditActor; asset: AssetRecord; traceId: string },
  provider: WestDigitalWriteProvider,
): Promise<void> {
  const owned = await assertWestDigitalDomainOwnership(
    req,
    {
      actor: input.actor,
      domainAscii: input.asset.domainAscii,
      targetId: input.asset.id,
      traceId: `${input.traceId}:ownership`,
    },
    provider,
  )
  if (
    owned.domainAscii !== input.asset.domainAscii ||
    owned.status !== 'active' ||
    owned.expiresAt !== input.asset.expiresAt
  ) {
    throw new AppError('AUTOMATIC_RENEWAL_UPSTREAM_ASSET_CHANGED', '上游域名状态已变化', 409)
  }
  const eligibility = await provider
    .queryRenewalEligibility({
      domainAscii: input.asset.domainAscii,
      traceId: `${input.traceId}:renewal-status`,
    })
    .catch(() => undefined)
  if (
    !eligibility?.ok ||
    eligibility.data.domainAscii !== input.asset.domainAscii ||
    eligibility.data.state !== 'eligible'
  ) {
    throw new AppError(
      'AUTOMATIC_RENEWAL_DOMAIN_STATUS_BLOCKED',
      '域名处于过期、赎回、等待处理、注册局限制或状态不明，不能走普通续费路径',
      409,
    )
  }
}

function automaticRenewalErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : undefined
}

function decisionEventType(error: unknown) {
  const code = automaticRenewalErrorCode(error)
  if (!code) return 'skipped_domain_status' as const
  if (code === 'AUTOMATIC_RENEWAL_ACCOUNT_RESTRICTED' || code.startsWith('ACCOUNT_'))
    return 'skipped_account_restricted' as const
  if (code === 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE') return 'skipped_identity_cooldown' as const
  if (
    code === 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED' ||
    code === 'DOMAIN_UPSTREAM_OWNERSHIP_UNCONFIRMED' ||
    code === 'AUTOMATIC_RENEWAL_UPSTREAM_ASSET_CHANGED'
  ) {
    return 'skipped_not_owned' as const
  }
  if (code.startsWith('RENEWAL_MANDATE_')) return 'skipped_invalid_mandate' as const
  return 'skipped_domain_status' as const
}

async function appendEvent(
  req: PayloadRequest,
  input: {
    amountFen?: number
    asset: AssetRecord
    attemptKey?: string
    attemptSlotDays?: number
    authorizedMaxAmountFen?: number
    availableBalanceFen?: number
    eventKey: string
    eventType:
      | 'balance_insufficient'
      | 'order_queued'
      | 'price_changed'
      | 'skipped_account_restricted'
      | 'skipped_domain_status'
      | 'skipped_identity_cooldown'
      | 'skipped_invalid_mandate'
      | 'skipped_job_revalidation'
      | 'skipped_not_owned'
    mandate: RenewalMandateRecord
    orderId?: number | string
    reasonCode?: string
    traceId: string
  },
) {
  return req.payload.create({
    collection: 'automaticRenewalEvents',
    data: {
      amountFen: input.amountFen,
      asset: input.asset.id as never,
      attemptKey: input.attemptKey,
      attemptSlotDays: input.attemptSlotDays,
      authorizedMaxAmountFen: input.authorizedMaxAmountFen,
      availableBalanceFen: input.availableBalanceFen,
      customer: relationId(input.asset.customer) as never,
      eventKey: input.eventKey,
      eventType: input.eventType,
      expiresAtSnapshot: input.asset.expiresAt,
      mandate: input.mandate.id as never,
      occurredAt: new Date().toISOString(),
      order: input.orderId as never,
      reasonCode: input.reasonCode,
      traceId: input.traceId,
    },
    overrideAccess: true,
    req,
  })
}

async function appendEventOnce(req: PayloadRequest, input: Parameters<typeof appendEvent>[1]) {
  const findExisting = () =>
    req.payload.find({
      collection: 'automaticRenewalEvents',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { eventKey: { equals: input.eventKey } },
    })
  const existing = await findExisting()
  if (existing.totalDocs) return existing.docs[0]
  try {
    return await appendEvent(req, input)
  } catch (error) {
    const raced = await findExisting()
    if (raced.totalDocs) return raced.docs[0]
    throw error
  }
}

async function recordSkipped(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    error: unknown
    mandate?: RenewalMandateRecord
    traceId: string
    eventType?: 'skipped_job_revalidation'
    orderId?: number | string
  },
) {
  const reasonCode = automaticRenewalErrorCode(input.error) ?? 'AUTOMATIC_RENEWAL_UNKNOWN'
  if (input.mandate) {
    const eventType = input.eventType ?? decisionEventType(input.error)
    const digest = createHash('sha256')
      .update(
        `${input.asset.id}:${input.asset.expiresAt}:${input.mandate.id}:${eventType}:${reasonCode}:${input.orderId ?? ''}`,
      )
      .digest('hex')
    await appendEventOnce(req, {
      asset: input.asset,
      eventKey: `automatic-renewal:skip:${digest}`,
      eventType,
      mandate: input.mandate,
      orderId: input.orderId,
      reasonCode,
      traceId: input.traceId,
    })
  }
  await recordAuditEvent(req, {
    action: 'domain.automatic_renewal.skipped',
    actor: { type: 'system' },
    metadata: {
      assetId: String(input.asset.id),
      mandateId: input.mandate ? String(input.mandate.id) : undefined,
      orderId: input.orderId ? String(input.orderId) : undefined,
      reasonCode,
    },
    targetId: input.asset.id,
  })
}

async function lockAsset(req: PayloadRequest, asset: AssetRecord): Promise<void> {
  const locked = await (
    await database(req)
  ).execute(sql`
    UPDATE domain_assets
    SET updated_at = NOW()
    WHERE id = ${asset.id}
      AND customer_id = ${relationId(asset.customer)}
      AND domain_ascii = ${asset.domainAscii}
      AND expires_at = ${asset.expiresAt}::timestamptz
      AND status = 'active'
    RETURNING id
  `)
  if (locked.rows?.[0]?.id === undefined) {
    throw new AppError('AUTOMATIC_RENEWAL_ASSET_CHANGED', '域名资产已变化，自动续费已放弃', 409)
  }
}

async function claimAttempt(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    attemptKey: string
    attemptSlotDays: number
    eventKey: string
    mandate: RenewalMandateRecord
    traceId: string
  },
): Promise<boolean> {
  const claimed = await (
    await database(req)
  ).execute(sql`
    INSERT INTO automatic_renewal_events (
      event_key,
      customer_id,
      asset_id,
      mandate_id,
      attempt_key,
      attempt_slot_days,
      expires_at_snapshot,
      event_type,
      occurred_at,
      trace_id,
      updated_at,
      created_at
    ) VALUES (
      ${input.eventKey},
      ${relationId(input.asset.customer)},
      ${input.asset.id},
      ${input.mandate.id},
      ${input.attemptKey},
      ${input.attemptSlotDays},
      ${input.asset.expiresAt}::timestamptz,
      'attempt_claimed',
      NOW(),
      ${input.traceId},
      NOW(),
      NOW()
    )
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id
  `)
  return claimed.rows?.[0]?.id !== undefined
}

async function walletAccountId(
  req: PayloadRequest,
  customerId: number | string,
): Promise<number | string> {
  const accounts = await req.payload.find({
    collection: 'walletAccounts',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    req,
    where: {
      and: [{ customer: { equals: customerId } }, { currency: { equals: 'CNY' } }],
    },
  })
  if (accounts.docs.length !== 1) {
    throw new AppError('WALLET_ACCOUNT_UNAVAILABLE', '钱包账户不存在或不可用', 409)
  }
  return accounts.docs[0]!.id
}

async function hasUnfinishedCycleOrder(req: PayloadRequest, asset: AssetRecord): Promise<boolean> {
  const events = await req.payload.find({
    collection: 'automaticRenewalEvents',
    depth: 0,
    limit: 50,
    overrideAccess: true,
    req,
    where: {
      and: [
        { asset: { equals: asset.id } },
        { expiresAtSnapshot: { equals: asset.expiresAt } },
        { eventType: { equals: 'order_queued' } },
      ],
    },
  })
  for (const event of events.docs) {
    const orderId = event.order ? relationId(event.order) : undefined
    if (orderId === undefined) continue
    const order = await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: orderId,
      overrideAccess: true,
      req,
    })
    if (!['cancelled', 'refunded'].includes(order.status)) return true
  }
  return false
}

async function balanceReminderCount(req: PayloadRequest, asset: AssetRecord): Promise<number> {
  const reminders = await req.payload.find({
    collection: 'automaticRenewalEvents',
    depth: 0,
    limit: 0,
    overrideAccess: true,
    req,
    where: {
      and: [
        { asset: { equals: asset.id } },
        { expiresAtSnapshot: { equals: asset.expiresAt } },
        { eventType: { equals: 'balance_insufficient' } },
      ],
    },
  })
  return reminders.totalDocs
}

function attemptKey(asset: AssetRecord, mandate: RenewalMandateRecord, slotDays: number): string {
  return `automatic-renewal:${createHash('sha256')
    .update(`${asset.id}:${asset.expiresAt}:${mandate.id}:${slotDays}`)
    .digest('hex')}`
}

function customerIdentity(customer: CustomerRecord) {
  return {
    collection: 'customers' as const,
    id: Number(customer.id),
    status: String(customer.status),
  }
}

export async function runAutomaticRenewalForAsset(
  req: PayloadRequest,
  assetId: number | string,
  dependencies: AutomaticRenewalDependencies,
): Promise<AutomaticRenewalOutcome> {
  if (req.user) {
    throw new AppError(
      'AUTOMATIC_RENEWAL_SYSTEM_CONTEXT_REQUIRED',
      '自动续费只能由无人值守系统任务执行',
      403,
    )
  }
  const now = (dependencies.now ?? (() => new Date()))()
  const rules = currentRules(dependencies)
  const asset = await loadAsset(req, assetId)
  let mandate = await findCurrentRenewalMandate(req, asset.id)
  const traceId = dependenciesTrace(dependencies, asset)
  const assetExpiresAtMs = Date.parse(asset.expiresAt)
  if (!Number.isFinite(assetExpiresAtMs) || assetExpiresAtMs <= now.getTime()) {
    await recordSkipped(req, {
      asset,
      error: new AppError(
        'AUTOMATIC_RENEWAL_ASSET_EXPIRED',
        '域名已过期或到期时间无效，不能走普通续费路径',
        409,
      ),
      mandate,
      traceId,
    })
    return { assetId: String(asset.id), status: 'skipped' }
  }
  const slotDays = automaticRenewalAttemptSlot(asset.expiresAt, now, rules)
  if (slotDays === undefined) return { assetId: String(asset.id), status: 'not_due' }
  let checked: Awaited<ReturnType<typeof assertAutomaticRenewalMandateValid>>
  try {
    checked = await transaction(req, () =>
      assertAutomaticRenewalMandateValid(req, {
        assetId: asset.id,
        now,
        rules,
      }),
    )
    mandate = checked.mandate
    await assertUpstreamRenewable(
      req,
      { actor: { type: 'system' }, asset: checked.asset, traceId },
      dependencies.writeProvider,
    )
  } catch (error) {
    await recordSkipped(req, { asset, error, mandate, traceId })
    return { assetId: String(asset.id), status: 'skipped' }
  }
  const pricingRules = await loadEnabledPricingRules(req.payload, req)
  const customer = customerIdentity(checked.customer)
  const quote = await createCustomerQuote(
    { assetId: Number(checked.asset.id), operation: 'renewal', years: 1 },
    {
      assetStore: new PayloadCustomerDomainAssetStore(req, customer),
      customer,
      now: () => now.getTime(),
      provider: dependencies.readProvider,
      quoteStore: new PayloadCustomerQuoteStore(req, customer),
      rules: pricingRules,
      snapshots: new PayloadPriceSnapshotStore(req.payload),
      traceId: `${traceId}:quote`,
    },
  )
  if (quote.state !== 'ready' || !quote.data.quote) {
    await recordSkipped(req, {
      asset,
      error: new AppError('AUTOMATIC_RENEWAL_PRICE_UNAVAILABLE', '暂时无法取得续费价格', 503),
      mandate,
      traceId,
    })
    return { assetId: String(asset.id), status: 'skipped' }
  }
  const publicQuote = quote.data.quote
  const amountFen = BigInt(publicQuote.userPriceMinor)
  const maxDebitFen = assertMandateAmount(mandate, rules)
  const daysRemaining = automaticRenewalDaysRemaining(asset.expiresAt, now)
  if (amountFen > maxDebitFen) {
    await appendEventOnce(req, {
      amountFen: Number(amountFen),
      asset,
      authorizedMaxAmountFen: mandate.maxDebitFen,
      eventKey: `${attemptKey(asset, mandate, slotDays)}:price-changed`,
      eventType: 'price_changed',
      mandate,
      reasonCode: 'RENEWAL_PRICE_EXCEEDS_MANDATE',
      traceId,
    })
    await sendAutomaticRenewalReminder(req, {
      amountFen: Number(amountFen),
      asset,
      authorizedMaxAmountFen: mandate.maxDebitFen,
      customerId: relationId(asset.customer),
      daysRemaining,
      dedupeKey: `${mandate.id}:${asset.expiresAt}:price-changed`,
      mandateId: mandate.id,
      noticeType: 'automatic_renewal_price_changed',
      ...(dependencies.smsProvider ? { provider: dependencies.smsProvider } : {}),
      traceId: `${traceId}:price-changed`,
    })
    return { assetId: String(asset.id), status: 'price_changed' }
  }
  await sendAutomaticRenewalReminder(req, {
    amountFen: Number(amountFen),
    asset,
    authorizedMaxAmountFen: mandate.maxDebitFen,
    customerId: relationId(asset.customer),
    daysRemaining,
    dedupeKey: `${mandate.id}:${asset.expiresAt}:${slotDays}:due`,
    mandateId: mandate.id,
    noticeType: 'automatic_renewal_due',
    ...(dependencies.smsProvider ? { provider: dependencies.smsProvider } : {}),
    traceId: `${traceId}:due`,
  })
  const key = attemptKey(asset, mandate, slotDays)
  const holdKey = `automatic-renewal-hold:${createHash('sha256').update(key).digest('hex')}`
  // Payload's user-scoped Local API reads may hydrate req.user. The executor authenticated the
  // system context at entry, so restore that context before the system-only mutation boundary.
  req.user = null
  let result:
    | { remind: boolean; status: 'balance_insufficient' }
    | { status: 'duplicate' }
    | { orderId: number | string; status: 'queued' }
  try {
    result = await transaction(req, async () => {
      await lockAsset(req, asset)
      const current = await assertAutomaticRenewalMandateValid(req, {
        amountFen,
        assetId: asset.id,
        expectedMandateId: mandate.id,
        now,
        rules,
      })
      if (await hasUnfinishedCycleOrder(req, asset)) {
        return { status: 'duplicate' as const }
      }
      const claimed = await claimAttempt(req, {
        asset,
        attemptKey: key,
        attemptSlotDays: slotDays,
        eventKey: `${key}:claimed`,
        mandate: current.mandate,
        traceId,
      })
      if (!claimed) return { status: 'duplicate' as const }
      const accountId = await walletAccountId(req, current.customer.id)
      let hold: Awaited<ReturnType<typeof holdWalletBalance>>
      try {
        hold = await holdWalletBalance(req, {
          accountId,
          amountFen,
          transactionKey: holdKey,
        })
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'WALLET_BALANCE_INSUFFICIENT')
          throw error
        const balance = await readWalletBalance(req, accountId)
        const previousReminderCount = await balanceReminderCount(req, asset)
        await appendEvent(req, {
          amountFen: Number(amountFen),
          asset,
          attemptKey: key,
          attemptSlotDays: slotDays,
          authorizedMaxAmountFen: mandate.maxDebitFen,
          availableBalanceFen: Number(balance.availableBalance),
          eventKey: `${key}:balance-insufficient`,
          eventType: 'balance_insufficient',
          mandate,
          reasonCode: error.code,
          traceId,
        })
        return {
          remind: previousReminderCount < rules.balanceReminderLimit,
          status: 'balance_insufficient' as const,
        }
      }
      if (hold.status !== 'held') {
        throw new AppError('AUTOMATIC_RENEWAL_HOLD_INVALID', '自动续费余额冻结状态无效', 409)
      }
      const created = await createSystemAutomaticRenewalOrder(
        req,
        {
          attemptKey: key,
          balanceHoldTransactionKey: holdKey,
          customer,
          mandateId: mandate.id,
          quoteRef: publicQuote.quoteRef,
          rulesVersion: rules.version,
          traceId,
        },
        {
          now: () => now.getTime(),
          ...(dependencies.orderNumber ? { orderNumber: dependencies.orderNumber } : {}),
          rules: pricingRules,
        },
      )
      const paidAt = now.toISOString()
      if (!(await claimBalancePaymentChannel(req, { orderId: created.order.id, paidAt }))) {
        throw new AppError('AUTOMATIC_RENEWAL_ORDER_CLAIM_CONFLICT', '自动续费订单认领冲突', 409)
      }
      await transitionOrder(req, created.order.id, 'paid', {
        actorType: 'system',
        evidence: {
          amountFen: Number(amountFen),
          holdTransactionId: String(hold.transactionId),
          mandateId: String(mandate.id),
          paymentChannel: 'balance',
        },
        reasonCode: 'automatic_renewal.balance_held',
      })
      const { enqueueCommerceFulfillment } = await import('@/services/commerce/fulfillment')
      await enqueueCommerceFulfillment(req, { orderId: created.order.id, traceId })
      await appendEvent(req, {
        amountFen: Number(amountFen),
        asset,
        attemptKey: key,
        attemptSlotDays: slotDays,
        authorizedMaxAmountFen: mandate.maxDebitFen,
        eventKey: `${key}:order-queued`,
        eventType: 'order_queued',
        mandate,
        orderId: created.order.id,
        traceId,
      })
      await recordAuditEvent(req, {
        action: 'domain.automatic_renewal.queued',
        actor: { type: 'system' },
        metadata: {
          amountFen: Number(amountFen),
          attemptKey: key,
          mandateId: String(mandate.id),
          orderId: String(created.order.id),
        },
        targetId: asset.id,
      })
      return { orderId: created.order.id, status: 'queued' as const }
    })
  } catch (error) {
    await recordSkipped(req, { asset, error, mandate, traceId })
    return { assetId: String(asset.id), status: 'skipped' }
  }
  if (result.status === 'balance_insufficient' && result.remind) {
    await sendAutomaticRenewalReminder(req, {
      amountFen: Number(amountFen),
      asset,
      authorizedMaxAmountFen: mandate.maxDebitFen,
      customerId: relationId(asset.customer),
      daysRemaining,
      dedupeKey: `${mandate.id}:${asset.expiresAt}:${slotDays}:balance-insufficient`,
      mandateId: mandate.id,
      noticeType: 'automatic_renewal_balance_insufficient',
      ...(dependencies.smsProvider ? { provider: dependencies.smsProvider } : {}),
      traceId: `${traceId}:balance-insufficient`,
    })
  }
  return {
    assetId: String(asset.id),
    ...(result.status === 'queued' ? { orderId: String(result.orderId) } : {}),
    status: result.status,
  }
}

function dependenciesTrace(dependencies: AutomaticRenewalDependencies, asset: AssetRecord): string {
  return `automatic-renewal:${asset.id}:${(dependencies.now ?? (() => new Date()))().toISOString()}`
}

async function loadCandidates(req: PayloadRequest): Promise<AutomaticRenewalCandidate[]> {
  const mandates = await req.payload.find({
    collection: 'renewalMandates',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    sort: '-revision',
  })
  const latestByAsset = new Map<string, RenewalMandateRecord>()
  for (const document of mandates.docs as unknown as RenewalMandateRecord[]) {
    const assetId = String(relationId(document.asset))
    if (!latestByAsset.has(assetId)) latestByAsset.set(assetId, document)
  }
  const candidates: AutomaticRenewalCandidate[] = []
  for (const mandate of latestByAsset.values()) {
    if (mandate.eventType !== 'authorized') continue
    try {
      candidates.push({ asset: await loadAsset(req, relationId(mandate.asset)), mandate })
    } catch {
      // The per-asset execution path records any actionable skip; missing assets cannot be renewed.
    }
  }
  return sortAutomaticRenewalCandidates(candidates)
}

export async function runAutomaticRenewals(
  req: PayloadRequest,
  dependencies: AutomaticRenewalDependencies,
) {
  const processingOrder: string[] = []
  const outcomes: AutomaticRenewalOutcome[] = []
  for (const candidate of await loadCandidates(req)) {
    const rules = currentRules(dependencies)
    const now = (dependencies.now ?? (() => new Date()))()
    if (automaticRenewalAttemptSlot(candidate.asset.expiresAt, now, rules) === undefined) continue
    processingOrder.push(String(candidate.asset.id))
    outcomes.push(await runAutomaticRenewalForAsset(req, candidate.asset.id, dependencies))
  }
  return { outcomes, processingOrder }
}

export async function revalidateAutomaticRenewalOrder(
  req: PayloadRequest,
  order: AutomaticRenewalOrderRecord,
  input: {
    now?: () => Date
    rules?: AutomaticRenewalRules
    traceId: string
    writeProvider: WestDigitalWriteProvider
  },
): Promise<{ automatic: boolean }> {
  if (!order.automaticRenewalMandate) return { automatic: false }
  const assetId = order.domainAsset ? relationId(order.domainAsset) : undefined
  if (
    order.operation !== 'renewal' ||
    assetId === undefined ||
    !order.automaticRenewalAttemptKey ||
    !order.automaticRenewalRulesVersion ||
    !Number.isSafeInteger(order.amountMinor) ||
    order.amountMinor <= 0
  ) {
    throw new AppError('AUTOMATIC_RENEWAL_ORDER_INVALID', '自动续费订单授权快照无效', 409)
  }
  const now = (input.now ?? (() => new Date()))()
  const rules = input.rules ?? automaticRenewalRules()
  const asset = await loadAsset(req, assetId)
  await lockAsset(req, asset)
  const checked = await assertAutomaticRenewalMandateValid(req, {
    amountFen: BigInt(order.amountMinor),
    assetId,
    expectedMandateId: relationId(order.automaticRenewalMandate),
    expectedRulesVersion: order.automaticRenewalRulesVersion,
    now,
    rules,
  })
  await assertUpstreamRenewable(
    req,
    { actor: { type: 'system' }, asset: checked.asset, traceId: input.traceId },
    input.writeProvider,
  )
  return { automatic: true }
}

export async function recordAutomaticRenewalOrderSkip(
  req: PayloadRequest,
  order: AutomaticRenewalOrderRecord,
  error: unknown,
  traceId: string,
): Promise<void> {
  const assetId = order.domainAsset ? relationId(order.domainAsset) : undefined
  if (assetId === undefined) return
  const asset = await loadAsset(req, assetId)
  const mandate = await findCurrentRenewalMandate(req, assetId)
  await recordSkipped(req, {
    asset,
    error,
    eventType: 'skipped_job_revalidation',
    mandate,
    orderId: order.id,
    traceId,
  })
}

export async function runConfiguredAutomaticRenewals(req: PayloadRequest) {
  return runAutomaticRenewals(req, {
    readProvider: createConfiguredWestDigitalReadProvider(),
    smsProvider: createSmsProvider(),
    writeProvider: createConfiguredWestDigitalWriteAdapter(),
  })
}
