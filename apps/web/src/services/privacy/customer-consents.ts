import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import {
  CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES,
  type ConsentType,
  type CustomerManagedOptionalConsentType,
} from '@/lib/domain'
import { AppError } from '@/lib/errors'
import type { ConsentRecord, Customer } from '@/payload-types'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { authTransactionDatabase, inAuthTransaction } from '@/services/auth/atomic'
import {
  appendConsentAcceptance,
  registrationConsentDocument,
} from '@/services/auth/registration-consents'
import { maskedClientIp, userAgentSummary } from '@/services/auth/client-facts'

type ConsentCustomer = Customer & {
  consentStateVersion?: number | null
  legacyProfileCompletedAt?: string | null
}

type ConsentDecision = 'accept' | 'revoke'

const REQUIRED_CONSENT_TYPES = ['service_terms', 'privacy_policy'] as const

function currentConsent(
  records: readonly ConsentRecord[],
  consentType: ConsentType,
): ConsentRecord | undefined {
  return records.find((record) => record.consentType === consentType)
}

function consentMatchesCurrentDocument(record: ConsentRecord): boolean {
  const current = registrationConsentDocument(record.consentType)
  return (
    record.documentHash === current.documentHash &&
    record.documentVersion === current.documentVersion
  )
}

function consentIsActive(record: ConsentRecord | undefined): record is ConsentRecord {
  return Boolean(record && !record.revokedAt && consentMatchesCurrentDocument(record))
}

async function consentHistory(
  req: PayloadRequest,
  customerIdValue: number | string,
): Promise<ConsentRecord[]> {
  const user = req.user
  const result = await req.payload.find({
    collection: 'consentRecords',
    depth: 0,
    limit: 1_000,
    overrideAccess: user ? false : true,
    pagination: false,
    req,
    sort: '-id',
    ...(user ? { user } : {}),
    where: { customer: { equals: customerIdValue } },
  })
  return result.docs
}

function assertCustomerActor(req: PayloadRequest, customer: ConsentCustomer): void {
  if (isCustomerUser(req.user) && String(req.user.id) === String(customer.id)) return
  throw new AppError('CONSENT_CHANGE_FORBIDDEN', '无权变更该账号的同意选择', 403)
}

function consentVersion(customer: ConsentCustomer): number {
  const version = Number(customer.consentStateVersion)
  if (Number.isSafeInteger(customer.consentStateVersion) && version >= 0) return version
  throw new AppError('CONSENT_STATE_INVALID', '同意状态版本无效', 500)
}

async function claimConsentStateVersion(
  req: PayloadRequest,
  input: { customerId: number; expectedVersion: number },
): Promise<void> {
  const database = await authTransactionDatabase(req)
  const claimed = await database.execute(sql`
    UPDATE customers
    SET consent_state_version = consent_state_version + 1, updated_at = NOW()
    WHERE id = ${input.customerId}
      AND consent_state_version = ${input.expectedVersion}
      AND status IN ('active', 'restricted')
    RETURNING id
  `)
  if (claimed.rows?.[0]?.id === undefined) {
    throw new AppError('CONSENT_STATE_CONFLICT', '同意状态已变化，请刷新后重试', 409)
  }
}

async function assertConsentStateVersionCurrent(
  req: PayloadRequest,
  input: { customerId: number; expectedVersion: number },
): Promise<void> {
  const database = await authTransactionDatabase(req)
  const current = await database.execute(sql`
    SELECT id
    FROM customers
    WHERE id = ${input.customerId}
      AND consent_state_version = ${input.expectedVersion}
      AND status IN ('active', 'restricted')
  `)
  if (current.rows?.[0]?.id === undefined) {
    throw new AppError('CONSENT_STATE_CONFLICT', '同意状态已变化，请刷新后重试', 409)
  }
}

export async function customerNeedsLegacyProfileCompletion(
  req: PayloadRequest,
  rawCustomer: Customer,
): Promise<boolean> {
  const customer = rawCustomer as ConsentCustomer
  if (customer.accountType !== 'legacy_unknown') return false
  if (!customer.defaultCustomerProfileType || !customer.legacyProfileCompletedAt) return true
  const records = await consentHistory(req, customer.id)
  return REQUIRED_CONSENT_TYPES.some(
    (consentType) => !consentIsActive(currentConsent(records, consentType)),
  )
}

export async function completeLegacyCustomerProfile(
  req: PayloadRequest,
  rawCustomer: Customer,
  input: { defaultCustomerProfileType: 'individual' | 'organization' },
): Promise<{ completedAt: string; profileCompletionRequired: false }> {
  const customer = rawCustomer as ConsentCustomer
  assertCustomerActor(req, customer)
  if (
    customer.accountType !== 'legacy_unknown' ||
    customer.registrationSource !== 'legacy_unknown'
  ) {
    throw new AppError('LEGACY_PROFILE_NOT_REQUIRED', '当前账号无需补全历史资料', 409)
  }
  if (customer.legacyProfileCompletedAt) {
    throw new AppError('LEGACY_PROFILE_ALREADY_COMPLETED', '历史资料已经补全', 409)
  }
  const expectedVersion = consentVersion(customer)
  const completedAt = new Date().toISOString()
  return inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const claimed = await database.execute(sql`
      UPDATE customers
      SET
        consent_state_version = consent_state_version + 1,
        default_customer_profile_type = ${input.defaultCustomerProfileType},
        legacy_profile_completed_at = ${completedAt},
        updated_at = NOW()
      WHERE id = ${customer.id}
        AND account_type = 'legacy_unknown'
        AND registration_source = 'legacy_unknown'
        AND legacy_profile_completed_at IS NULL
        AND consent_state_version = ${expectedVersion}
        AND status IN ('active', 'restricted')
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      throw new AppError(
        'LEGACY_PROFILE_COMPLETION_CONFLICT',
        '历史资料状态已变化，请刷新后重试',
        409,
      )
    }
    const consentIds: Array<number | string> = []
    for (const consentType of REQUIRED_CONSENT_TYPES) {
      const record = await appendConsentAcceptance(req, {
        acceptedAt: completedAt,
        consentType,
        customerId: customer.id,
        headers: req.headers,
        source: 'legacy_profile_completion',
      })
      consentIds.push(record.id)
    }
    await recordAuditEvent(req, {
      action: 'customer.legacy_profile.completed',
      actor: { id: customer.id, type: 'customer' },
      metadata: {
        completedAt,
        consentIds,
        defaultCustomerProfileType: input.defaultCustomerProfileType,
        registrationSource: customer.registrationSource,
      },
      targetId: customer.id,
    })
    return { completedAt, profileCompletionRequired: false as const }
  })
}

export async function recordCustomerConsentDecision(
  req: PayloadRequest,
  rawCustomer: Customer,
  input: { consentType: CustomerManagedOptionalConsentType; decision: ConsentDecision },
): Promise<{ active: boolean; changed: boolean; consentType: CustomerManagedOptionalConsentType }> {
  const customer = rawCustomer as ConsentCustomer
  assertCustomerActor(req, customer)
  if (!(CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES as readonly string[]).includes(input.consentType)) {
    throw new AppError('CONSENT_TYPE_NOT_CUSTOMER_MANAGED', '该同意类型不能从隐私中心变更', 400)
  }
  const records = await consentHistory(req, customer.id)
  const current = currentConsent(records, input.consentType)
  const active = consentIsActive(current)
  const expectedVersion = consentVersion(customer)
  if (input.decision === 'accept' && active) {
    return inAuthTransaction(req, async () => {
      await assertConsentStateVersionCurrent(req, { customerId: customer.id, expectedVersion })
      return { active: true, changed: false, consentType: input.consentType }
    })
  }
  if (input.decision === 'revoke' && !active) {
    return inAuthTransaction(req, async () => {
      await assertConsentStateVersionCurrent(req, { customerId: customer.id, expectedVersion })
      return { active: false, changed: false, consentType: input.consentType }
    })
  }
  const occurredAt = new Date().toISOString()
  return inAuthTransaction(req, async () => {
    await claimConsentStateVersion(req, { customerId: customer.id, expectedVersion })
    let record: ConsentRecord
    if (input.decision === 'accept') {
      record = await appendConsentAcceptance(req, {
        acceptedAt: occurredAt,
        consentType: input.consentType,
        customerId: customer.id,
        headers: req.headers,
        source: 'account_privacy_center',
      })
    } else {
      const acceptedRecord = current as ConsentRecord
      record = await req.payload.create({
        collection: 'consentRecords',
        data: {
          acceptedAt: acceptedRecord.acceptedAt,
          consentType: input.consentType,
          customer: customer.id,
          documentHash: acceptedRecord.documentHash,
          documentVersion: acceptedRecord.documentVersion,
          ipMasked: maskedClientIp(req.headers),
          revokedAt: occurredAt,
          source: 'account_privacy_center',
          userAgentSummary: userAgentSummary(req.headers),
        },
        overrideAccess: true,
        req,
      })
    }
    await recordAuditEvent(req, {
      action:
        input.decision === 'accept' ? 'customer.consent.accepted' : 'customer.consent.revoked',
      actor: { id: customer.id, type: 'customer' },
      metadata: {
        consentRecordId: record.id,
        consentType: input.consentType,
        documentHash: record.documentHash,
        documentVersion: record.documentVersion,
        occurredAt,
      },
      targetId: customer.id,
    })
    return {
      active: input.decision === 'accept',
      changed: true,
      consentType: input.consentType,
    }
  })
}

export async function assertCustomerConsentActive(
  req: PayloadRequest,
  customerIdValue: number | string,
  consentType: CustomerManagedOptionalConsentType,
): Promise<void> {
  const records = await consentHistory(req, customerIdValue)
  if (consentIsActive(currentConsent(records, consentType))) return
  throw new AppError('CONSENT_REQUIRED', '请先完成对应的单独同意', 403)
}

export async function commercialSmsOptedIn(
  req: PayloadRequest,
  customerIdValue: number | string,
): Promise<boolean> {
  const records = await consentHistory(req, customerIdValue)
  return consentIsActive(currentConsent(records, 'commercial_sms'))
}

export async function assertLegacyRegistrationPurchaseAllowed(
  req: PayloadRequest,
  customerId: number,
): Promise<void> {
  const customer = await req.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: customerId,
    overrideAccess: false,
    req,
    user: req.user,
  })
  if (!(await customerNeedsLegacyProfileCompletion(req, customer))) return
  throw new AppError(
    'LEGACY_PROFILE_COMPLETION_REQUIRED',
    '请先补全账号资料并确认最新条款后再购买新域名',
    403,
  )
}
