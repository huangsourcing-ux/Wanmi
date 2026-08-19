import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SmsProvider } from '@/providers/types'
import { mockFailure, mockSuccess } from '@/providers/mock'
import type { AdminHighRiskOperationType } from '@/lib/domain'
import { inAuthTransaction } from '@/services/auth/atomic'
import { decideAccountRecovery } from '@/services/auth/account-recovery'
import { transitionCustomerAccount } from '@/services/auth/account-state'
import {
  decideCustomerIdentityCollision,
  identityProviderInstance,
  protectedIdentifier,
} from '@/services/auth/customer-identities'
import {
  executeAdminApprovalRequest,
  createAdminApprovalRequest,
  decideAdminApprovalRequest,
  listAdminApprovalRequests,
} from '@/services/admin/approvals'
import {
  loadAdminApprovalPolicy,
  readAdminApprovalPolicy,
  updateAdminApprovalPolicy,
} from '@/services/admin/approval-policy'
import {
  enqueueTransactionalSecurityNotification,
  listAdminNotificationDeliveries,
  listCustomerNotifications,
  markCustomerNotificationRead,
  runNotificationDeliveries,
  updateNotificationPreference,
} from '@/services/notifications/outbox'

const prefix = `d9b5-${randomUUID().slice(0, 8)}`
const adminIds: number[] = []
const customerIds: number[] = []
const identityIds: number[] = []
let payload: Payload
let originalPolicy: Awaited<ReturnType<typeof loadAdminApprovalPolicy>>

type AdminFixture = {
  collection: 'admins'
  id: number
  operationalScopes: Array<'funds_operations' | 'system_configuration'>
  roles: ['system_admin']
  status: 'active'
}

type CustomerFixture = {
  collection: 'customers'
  id: number
  status: 'active' | 'restricted' | 'suspended'
}

let fundsInitiator: AdminFixture
let fundsApprover: AdminFixture
let configurationAdmin: AdminFixture
let customer: CustomerFixture

async function baseRequest(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    {
      req: {
        headers: new Headers({
          'user-agent': `Wanmi-D9B5/${suffix}`,
          'x-forwarded-for': '198.51.100.85',
          'x-request-id': `${prefix}-${suffix}`,
        }),
      },
    },
    payload,
  )
}

async function requestFor(
  user: AdminFixture | CustomerFixture,
  suffix: string,
): Promise<PayloadRequest> {
  const req = await baseRequest(suffix)
  req.user = user as never
  return req
}

async function createAdmin(
  suffix: string,
  operationalScopes: AdminFixture['operationalScopes'],
): Promise<AdminFixture> {
  const created = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap', suppressAdminAccountAudit: true },
    data: {
      email: `${prefix}-${suffix}@example.invalid`,
      operationalScopes,
      password: `D9b5!${randomUUID()}aA1`,
      roles: ['system_admin'],
      status: 'active',
    },
    overrideAccess: true,
  })
  const id = Number(created.id)
  adminIds.push(id)
  return {
    collection: 'admins',
    id,
    operationalScopes,
    roles: ['system_admin'],
    status: 'active',
  }
}

async function createCustomer(
  suffix: string,
  channels: Array<'phone' | 'wechat'> = ['phone', 'wechat'],
  state: Pick<CustomerFixture, 'status'> & { restrictions?: string[] } = { status: 'active' },
): Promise<CustomerFixture> {
  const phone = `+86139${randomInt(10_000_000, 100_000_000)}`
  const created = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: state.restrictions ?? [],
      phone,
      phoneMasked: `+86139****${phone.slice(-4)}`,
      status: state.status,
    },
    overrideAccess: true,
  })
  const id = Number(created.id)
  customerIds.push(id)
  for (const channel of channels) {
    const identifier = channel === 'phone' ? phone : `${prefix}-${suffix}-openid`
    const identity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(identifier),
        boundAt: new Date().toISOString(),
        customer: id,
        provider: channel,
        providerInstanceId: identityProviderInstance(channel),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    identityIds.push(Number(identity.id))
  }
  return { collection: 'customers', id, status: state.status }
}

async function setPolicy(
  input: Pick<
    Awaited<ReturnType<typeof loadAdminApprovalPolicy>>,
    'cooldownSeconds' | 'requiresDifferentApprover'
  >,
) {
  return updateAdminApprovalPolicy(await requestFor(configurationAdmin, `policy-${randomUUID()}`), {
    ...input,
    changeNote: 'D9-B-5 integration policy update',
  })
}

function operationFixtures(customerId: number): Record<AdminHighRiskOperationType, unknown> {
  return {
    account_recovery: {
      customerId,
      decision: 'rejected',
      operationType: 'account_recovery',
      reasonNote: 'D9-B-5 account recovery test',
      reviewId: 910_003,
    },
    bulk_customer_asset_operation: {
      batchKind: 'domain_asset_sync',
      batchReference: 'batch-reference-d9b5',
      customerId,
      operationType: 'bulk_customer_asset_operation',
      reasonNote: 'D9-B-5 bulk asset test',
    },
    domain_management_credential_disposition: {
      action: 'read',
      assetId: 910_006,
      customerId,
      operationType: 'domain_management_credential_disposition',
      providerOperationReference: 'provider-reference-d9b5',
      reasonNote: 'D9-B-5 domain credential test',
    },
    high_risk_account_unfreeze: {
      customerId,
      evidenceReference: 'manual-review-evidence-d9b5',
      expectedRestrictions: ['login_disabled'],
      expectedStatus: 'suspended',
      operationType: 'high_risk_account_unfreeze',
      reasonNote: 'D9-B-5 account unfreeze test',
    },
    identity_conflict_resolution: {
      customerId,
      operationType: 'identity_conflict_resolution',
      reasonNote: 'D9-B-5 identity conflict test',
      resolution: 'reject_claim',
      reviewId: 910_004,
    },
    large_balance_adjustment: {
      accountId: 910_001,
      adjustment: 'credit',
      allowNegativeBalance: false,
      amountFen: 12_345,
      customerId,
      operationType: 'large_balance_adjustment',
      reasonNote: 'D9-B-5 large balance test',
      transactionKey: 'ledger-transaction-d9b5',
    },
    original_refund: {
      customerId,
      operationType: 'original_refund',
      orderId: 910_002,
      reasonNote: 'D9-B-5 original refund test',
    },
    vip_fraud_correction: {
      correctionReference: 'vip-correction-d9b5',
      customerId,
      operationType: 'vip_fraud_correction',
      reasonNote: 'D9-B-5 VIP correction test',
    },
  }
}

async function createApproval(
  operationType: AdminHighRiskOperationType = 'vip_fraud_correction',
  suffix: string = randomUUID(),
) {
  return createAdminApprovalRequest(
    await requestFor(fundsInitiator, `create-${suffix}`),
    operationFixtures(customer.id)[operationType],
  )
}

async function approve(
  requestId: number | string,
  actor = fundsApprover,
  note = 'D9-B-5 independent approval',
) {
  return decideAdminApprovalRequest(await requestFor(actor, `approve-${randomUUID()}`), requestId, {
    decision: 'approve',
    note,
  })
}

function afterCooldown(createdAt: string, cooldownSeconds: number): Date {
  return new Date(new Date(createdAt).getTime() + cooldownSeconds * 1_000 + 1)
}

async function countWhere(
  collection: Parameters<Payload['count']>[0]['collection'],
  where: object,
) {
  return (
    await payload.count({
      collection,
      overrideAccess: true,
      where: where as never,
    })
  ).totalDocs
}

function smsProviderFixture(
  sendIdentityChanged: SmsProvider['sendIdentityChanged'],
  queryReceipt: SmsProvider['queryReceipt'] = async () =>
    mockSuccess({ status: 'delivered' as const }),
): SmsProvider {
  return {
    health: vi.fn(async () => mockSuccess({ healthy: true })),
    queryReceipt,
    sendDomainExpiry: vi.fn(async () =>
      mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'expiry',
      }),
    ),
    sendIdentityChanged,
    sendOtp: vi.fn(async () =>
      mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'otp',
      }),
    ),
    sendStepUpOtp: vi.fn(async () =>
      mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'step-up',
      }),
    ),
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  originalPolicy = await loadAdminApprovalPolicy(await baseRequest('original-policy'))
  fundsInitiator = await createAdmin('funds-initiator', ['funds_operations'])
  fundsApprover = await createAdmin('funds-approver', ['funds_operations'])
  configurationAdmin = await createAdmin('configuration', ['system_configuration'])
  customer = await createCustomer('main')
})

afterAll(async () => {
  await payload.db.pool.query(
    `UPDATE site_settings
     SET value = $1::jsonb, updated_at = NOW()
     WHERE key = 'admin.high-risk-approval-policy'`,
    [JSON.stringify(originalPolicy)],
  )
  if (customerIds.length) {
    await payload.db.pool.query(
      `DELETE FROM notification_provider_receipts
       WHERE delivery_id IN (
         SELECT id FROM notification_deliveries WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM notification_read_states WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM notification_deliveries WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM notification_outbox_events WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM notification_marketing_preferences WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM admin_access_events
       WHERE approval_request_id IN (
         SELECT id FROM admin_approval_requests WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM admin_approval_requests WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM customer_security_events WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM customer_identities WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM audit_logs
       WHERE trace_id LIKE $1 OR target_id = ANY($2::text[])`,
      [`${prefix}-%`, customerIds.map(String)],
    )
    await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds])
  }
  if (adminIds.length) {
    const removableAdminIds = adminIds.filter((id) => id !== configurationAdmin.id)
    if (removableAdminIds.length) {
      await payload.db.pool.query('DELETE FROM admins WHERE id = ANY($1::int[])', [
        removableAdminIds,
      ])
    }
  }
  await payload.db.destroy?.()
})

describe('D9-B-5 high-risk approval workflow', () => {
  it('rejects execution before approval', async () => {
    await setPolicy({ cooldownSeconds: 60, requiresDifferentApprover: true })
    const created = await createApproval()
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'execute-unapproved'),
        {
          expectedOperationType: created.operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_REQUIRED' })
  })

  it('uses the stored server creation time and policy snapshot, ignoring client time fields', async () => {
    await setPolicy({ cooldownSeconds: 3_600, requiresDifferentApprover: true })
    await expect(
      createAdminApprovalRequest(await requestFor(fundsInitiator, 'client-created-at'), {
        ...(operationFixtures(customer.id).vip_fraud_correction as Record<string, unknown>),
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })

    const created = await createApproval('vip_fraud_correction', 'cooldown-source')
    await approve(created.id)
    await setPolicy({ cooldownSeconds: 1, requiresDifferentApprover: false })
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'execute-before-stored-cooldown'),
        {
          expectedOperationType: created.operationType,
          now: () => new Date(new Date(created.createdAt).getTime() + 2_000),
          requestId: created.id,
        },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_COOLDOWN_ACTIVE' })
  })

  it('uses request creation time rather than approval time as the cooldown clock source', async () => {
    await setPolicy({ cooldownSeconds: 300, requiresDifferentApprover: true })
    const created = await createApproval('vip_fraud_correction', 'cooldown-clock-source')
    await approve(created.id)
    await payload.db.pool.query(
      `UPDATE admin_approval_requests
       SET approved_at = created_at - INTERVAL '1 day'
       WHERE id = $1`,
      [created.id],
    )
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'cooldown-clock-source-execute'),
        {
          expectedOperationType: created.operationType,
          now: () => new Date(new Date(created.createdAt).getTime() + 10_000),
          requestId: created.id,
        },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_COOLDOWN_ACTIVE' })
  })

  it('rejects sensitive or unknown operation payload fields before persistence', async () => {
    const before = await countWhere('adminApprovalRequests', {
      customer: { equals: customer.id },
    })
    await expect(
      createAdminApprovalRequest(await requestFor(fundsInitiator, 'sensitive-operation-input'), {
        ...(operationFixtures(customer.id).vip_fraud_correction as Record<string, unknown>),
        phone: '+8613912345678',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
    await expect(
      createAdminApprovalRequest(await requestFor(fundsInitiator, 'sensitive-operation-value'), {
        ...(operationFixtures(customer.id).vip_fraud_correction as Record<string, unknown>),
        correctionReference: '+8613912345678',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_SENSITIVE_PAYLOAD_FORBIDDEN' })
    expect(
      await countWhere('adminApprovalRequests', {
        customer: { equals: customer.id },
      }),
    ).toBe(before)
  })

  it.each([0, -1])('rejects a non-positive cooldown configuration: %s', async (cooldownSeconds) => {
    await expect(
      updateAdminApprovalPolicy(
        await requestFor(configurationAdmin, `invalid-${cooldownSeconds}`),
        {
          changeNote: 'D9-B-5 invalid cooldown test',
          cooldownSeconds,
          requiresDifferentApprover: true,
        },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('fails closed when the persisted cooldown source is corrupted independently of the update schema', async () => {
    const valid = await loadAdminApprovalPolicy(await baseRequest('persisted-policy-valid'))
    await payload.db.pool.query(
      `UPDATE site_settings
       SET value = jsonb_set(value, '{cooldownSeconds}', '0'::jsonb), updated_at = NOW()
       WHERE key = 'admin.high-risk-approval-policy'`,
    )
    try {
      await expect(
        createApproval('vip_fraud_correction', 'persisted-policy-invalid'),
      ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_POLICY_UNAVAILABLE' })
    } finally {
      await payload.db.pool.query(
        `UPDATE site_settings SET value = $1::jsonb, updated_at = NOW()
         WHERE key = 'admin.high-risk-approval-policy'`,
        [JSON.stringify(valid)],
      )
    }
  })

  it('allows self-approval only when configured, but still enforces the full cooldown', async () => {
    await setPolicy({ cooldownSeconds: 300, requiresDifferentApprover: false })
    const created = await createApproval('vip_fraud_correction', 'self-cooldown')
    await approve(created.id, fundsInitiator)
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsInitiator, 'self-before-cooldown'),
        {
          expectedOperationType: created.operationType,
          now: () => new Date(new Date(created.createdAt).getTime() + 299_000),
          requestId: created.id,
        },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_COOLDOWN_ACTIVE' })
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsInitiator, 'self-after-cooldown'),
        {
          expectedOperationType: created.operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => 'executed',
      ),
    ).resolves.toMatchObject({ result: 'executed', status: 'executed' })
  })

  it('rejects initiator self-approval when a different approver is required', async () => {
    await setPolicy({ cooldownSeconds: 60, requiresDifferentApprover: true })
    const created = await createApproval('vip_fraud_correction', 'different-approver')
    await expect(approve(created.id, fundsInitiator)).rejects.toMatchObject({
      code: 'ADMIN_APPROVAL_DIFFERENT_APPROVER_REQUIRED',
    })
  })

  it('allows the initiator to reject a request without granting execution authority', async () => {
    await setPolicy({ cooldownSeconds: 60, requiresDifferentApprover: true })
    const created = await createApproval('vip_fraud_correction', 'self-reject')
    await expect(
      decideAdminApprovalRequest(
        await requestFor(fundsInitiator, 'self-reject-decision'),
        created.id,
        { decision: 'reject', note: 'The initiator may safely cancel their own request.' },
      ),
    ).resolves.toMatchObject({ status: 'rejected' })
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsInitiator, 'self-reject-execute'),
        {
          expectedOperationType: created.operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_EXECUTION_CONFLICT' })
  })

  it('rechecks different-approver identity in SQL when the pre-read source is stale', async () => {
    await setPolicy({ cooldownSeconds: 60, requiresDifferentApprover: true })
    const created = await createApproval('vip_fraud_correction', 'different-approver-sql')
    const original = payload.findByID.bind(payload)
    const findByID = vi.spyOn(payload, 'findByID')
    findByID.mockImplementation((async (args) => {
      const result = await original(args)
      if (args.collection === 'adminApprovalRequests' && String(args.id) === String(created.id)) {
        return { ...result, requiresDifferentApprover: false }
      }
      return result
    }) as typeof payload.findByID)
    try {
      await expect(approve(created.id, fundsInitiator)).rejects.toMatchObject({
        code: 'ADMIN_APPROVAL_DECISION_CONFLICT',
      })
    } finally {
      findByID.mockRestore()
    }
  })

  it('limits an approval decision to the exact request id', async () => {
    await setPolicy({ cooldownSeconds: 60, requiresDifferentApprover: true })
    const target = await createApproval('vip_fraud_correction', 'decision-id-target')
    const decoy = await createApproval('vip_fraud_correction', 'decision-id-decoy')
    await approve(target.id)
    await expect(
      payload.findByID({
        collection: 'adminApprovalRequests',
        depth: 0,
        id: decoy.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ status: 'pending_approval' })
  })

  it.each(Object.keys(operationFixtures(1)) as AdminHighRiskOperationType[])(
    'runs %s through request, approval, cooldown, and execution',
    async (operationType) => {
      await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
      const created = await createApproval(operationType, `all-types-${operationType}`)
      await approve(created.id)
      let effects = 0
      const executed = await executeAdminApprovalRequest(
        await requestFor(fundsApprover, `all-types-execute-${operationType}`),
        {
          expectedOperationType: operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async (approval) => {
          expect(approval.operationType).toBe(operationType)
          effects += 1
          return operationType
        },
      )
      expect(executed).toMatchObject({ result: operationType, status: 'executed' })
      expect(effects).toBe(1)
      expect(
        await countWhere('adminAccessEvents', {
          and: [{ approvalRequest: { equals: created.id } }, { eventType: { equals: 'executed' } }],
        }),
      ).toBe(1)
      expect(
        await countWhere('notificationOutboxEvents', {
          eventKey: { equals: `admin-approval:${created.requestKey}:requested` },
        }),
      ).toBe(1)
    },
  )

  it('keeps a phone-like internal request UUID out of notification text and commits execution', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const created = await createApproval('large_balance_adjustment', 'phone-like-request-key')
    const phoneLikeRequestKey = '00000000-0000-4000-8000-13012345678a'
    await payload.db.pool.query(
      'UPDATE admin_approval_requests SET request_key = $1 WHERE id = $2',
      [phoneLikeRequestKey, created.id],
    )
    await approve(created.id)
    let effects = 0

    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'phone-like-request-key-execute'),
        {
          expectedOperationType: created.operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => {
          effects += 1
          return 'executed-with-safe-notification'
        },
      ),
    ).resolves.toMatchObject({ result: 'executed-with-safe-notification', status: 'executed' })

    expect(effects).toBe(1)
    await expect(
      payload.findByID({
        collection: 'adminApprovalRequests',
        depth: 0,
        id: created.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ requestKey: phoneLikeRequestKey, status: 'executed' })
    const outbox = await payload.find({
      collection: 'notificationOutboxEvents',
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { eventKey: { equals: `admin-approval:${phoneLikeRequestKey}:executed` } },
          { notificationType: { equals: 'admin_high_risk_operation_executed' } },
        ],
      },
    })
    expect(outbox.totalDocs).toBe(1)
    expect(outbox.docs[0]).toMatchObject({
      bodySnapshot: '大额余额调整已执行。如非本人授权，请立即联系人工支持。',
      eventKey: `admin-approval:${phoneLikeRequestKey}:executed`,
      subjectSnapshot: '高风险操作已执行',
      templateKey: 'admin-high-risk-operation-executed',
      templateVersion: 2,
    })
    expect(outbox.docs[0]?.bodySnapshot).not.toContain(phoneLikeRequestKey)
    expect(outbox.docs[0]?.bodySnapshot).not.toContain('13012345678')
    expect(
      await countWhere('adminAccessEvents', {
        and: [{ approvalRequest: { equals: created.id } }, { eventType: { equals: 'executed' } }],
      }),
    ).toBe(1)
  })

  it('rejects a stored operation type being replaced by a caller-supplied type', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const created = await createApproval('original_refund', 'operation-source')
    await approve(created.id)
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'operation-source-mismatch'),
        {
          expectedOperationType: 'large_balance_adjustment',
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_EXECUTION_CONFLICT' })
  })

  it('fails closed when a de-correlated target index disagrees with the immutable operation snapshot', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const created = await createApproval('original_refund', 'target-source-mismatch')
    await approve(created.id)
    await payload.db.pool.query('UPDATE admin_approval_requests SET target_id = $1 WHERE id = $2', [
      'unrelated-order-target',
      created.id,
    ])
    let effects = 0
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'target-source-mismatch-execute'),
        {
          expectedOperationType: created.operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => {
          effects += 1
          return 'must-not-run'
        },
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_SNAPSHOT_MISMATCH' })
    expect(effects).toBe(0)
  })

  it('stores a large adjustment amount in the constrained fen column rather than duplicating its source in JSON', async () => {
    const created = await createApproval('large_balance_adjustment', 'amount-source')
    expect(created).toMatchObject({ amountFen: 12_345 })
    expect(created.operationData).not.toHaveProperty('amountFen')
  })

  it('limits an execution claim to the exact request id', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const target = await createApproval('vip_fraud_correction', 'execution-id-target')
    const decoy = await createApproval('vip_fraud_correction', 'execution-id-decoy')
    await approve(target.id)
    await approve(decoy.id)
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'execution-id-run'),
        {
          expectedOperationType: target.operationType,
          now: () => afterCooldown(decoy.createdAt, decoy.cooldownSeconds),
          requestId: target.id,
        },
        async () => 'target-only',
      ),
    ).resolves.toMatchObject({ result: 'target-only', status: 'executed' })
    await expect(
      payload.findByID({
        collection: 'adminApprovalRequests',
        depth: 0,
        id: decoy.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ status: 'approved' })
  })

  it.each(['execution_claim_key', 'executed_by_id'] as const)(
    'revalidates %s before finalizing the business transaction',
    async (field) => {
      await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
      const created = await createApproval('vip_fraud_correction', `finalize-${field}`)
      await approve(created.id)
      await expect(
        executeAdminApprovalRequest(
          await requestFor(fundsApprover, `finalize-run-${field}`),
          {
            expectedOperationType: created.operationType,
            now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
            requestId: created.id,
          },
          async () => {
            await payload.db.pool.query(
              `UPDATE admin_approval_requests SET ${field} = $1 WHERE id = $2`,
              [field === 'execution_claim_key' ? randomUUID() : fundsInitiator.id, created.id],
            )
            return 'must-not-finalize'
          },
        ),
      ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_EXECUTION_FINALIZE_CONFLICT' })
    },
  )

  it('revalidates the executing state before finalizing the business transaction', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const created = await createApproval('vip_fraud_correction', 'finalize-status')
    await approve(created.id)
    await expect(
      executeAdminApprovalRequest(
        await requestFor(fundsApprover, 'finalize-status-run'),
        {
          expectedOperationType: created.operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => {
          await payload.db.pool.query(
            `UPDATE admin_approval_requests
             SET status = 'executed', executed_at = NOW()
             WHERE id = $1 AND status = 'executing'`,
            [created.id],
          )
          return 'must-not-finalize-again'
        },
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_EXECUTION_FINALIZE_CONFLICT' })
    await expect(
      payload.findByID({
        collection: 'adminApprovalRequests',
        depth: 0,
        id: created.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ status: 'executed' })
  })

  it('allows exactly one concurrent approval and one concurrent execution', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const approvalRace = await createApproval('vip_fraud_correction', 'approval-race')
    const approvalOutcomes = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        decideAdminApprovalRequest(
          await requestFor(fundsApprover, `approval-race-${index}`),
          approvalRace.id,
          { decision: 'approve', note: `D9-B-5 race approval ${index}` },
        ),
      ),
    )
    expect(approvalOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(
      await countWhere('adminAccessEvents', {
        and: [
          { approvalRequest: { equals: approvalRace.id } },
          { eventType: { equals: 'approved' } },
        ],
      }),
    ).toBe(1)

    let effects = 0
    const executionOutcomes = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        executeAdminApprovalRequest(
          await requestFor(fundsApprover, `execute-race-${index}`),
          {
            expectedOperationType: approvalRace.operationType,
            now: () => afterCooldown(approvalRace.createdAt, approvalRace.cooldownSeconds),
            requestId: approvalRace.id,
          },
          async () => {
            effects += 1
            return index
          },
        ),
      ),
    )
    expect(executionOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(effects).toBe(1)
    expect(
      await countWhere('adminAccessEvents', {
        and: [
          { approvalRequest: { equals: approvalRace.id } },
          { eventType: { equals: 'executed' } },
        ],
      }),
    ).toBe(1)
  })

  it('blocks direct admin unfreeze outside an approved execution context', async () => {
    const suspended = await createCustomer('suspended', [], {
      restrictions: ['login_disabled'],
      status: 'suspended',
    })
    await expect(
      transitionCustomerAccount(await requestFor(fundsInitiator, 'direct-unfreeze'), {
        actor: { id: fundsInitiator.id, type: 'admin' },
        customerId: suspended.id,
        evidence: {
          observedAt: new Date().toISOString(),
          reference: 'direct-unfreeze-forbidden',
          source: 'manual_review',
        },
        expectedRestrictions: ['login_disabled'],
        expectedStatus: 'suspended',
        reason: 'direct unfreeze must be rejected',
        restrictions: [],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_REQUIRED' })
  })

  it('blocks direct account-recovery and identity-conflict decisions outside approved execution contexts', async () => {
    const req = await requestFor(fundsInitiator, 'direct-manual-review-decisions')
    await expect(
      decideAccountRecovery(req, {
        decision: { conclusion: 'rejected', note: 'direct recovery must be rejected' },
        reviewId: 91_000_301,
        reviewerId: fundsInitiator.id,
        traceId: `${prefix}-direct-recovery`,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_REQUIRED' })
    await expect(
      decideCustomerIdentityCollision(req, {
        customerId: customer.id,
        note: 'direct collision decision must be rejected',
        resolution: 'reject_claim',
        reviewId: 91_000_302,
        reviewerId: fundsInitiator.id,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_REQUIRED' })
  })

  it('separates funds operations from system configuration in both directions', async () => {
    await expect(
      updateAdminApprovalPolicy(await requestFor(fundsInitiator, 'funds-to-config'), {
        changeNote: 'funds role must not update configuration',
        cooldownSeconds: 30,
        requiresDifferentApprover: true,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
    await expect(
      createAdminApprovalRequest(
        await requestFor(configurationAdmin, 'config-to-funds'),
        operationFixtures(customer.id).vip_fraud_correction,
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_FUNDS_OPERATION_SCOPE_REQUIRED' })
  })

  it('requires system-configuration scope for actual administrator role and scope changes', async () => {
    const fundsReq = await requestFor(fundsInitiator, 'funds-admin-account-change')
    await expect(
      payload.update({
        collection: 'admins',
        data: { roles: ['analyst'] },
        id: configurationAdmin.id,
        overrideAccess: true,
        req: fundsReq,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
    await expect(
      payload.update({
        collection: 'admins',
        data: { operationalScopes: ['funds_operations'] },
        id: configurationAdmin.id,
        overrideAccess: true,
        req: fundsReq,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
  })

  it('enforces the funds scope independently at decision, execution, list, and delivery-list call points', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const created = await createApproval('vip_fraud_correction', 'funds-callpoints')
    await expect(approve(created.id, configurationAdmin)).rejects.toMatchObject({
      code: 'ADMIN_FUNDS_OPERATION_SCOPE_REQUIRED',
    })
    await approve(created.id)
    await expect(
      executeAdminApprovalRequest(
        await requestFor(configurationAdmin, 'funds-callpoint-execute'),
        {
          expectedOperationType: created.operationType,
          now: () => afterCooldown(created.createdAt, created.cooldownSeconds),
          requestId: created.id,
        },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_FUNDS_OPERATION_SCOPE_REQUIRED' })
    await expect(
      listAdminApprovalRequests(await requestFor(configurationAdmin, 'funds-callpoint-list')),
    ).rejects.toMatchObject({ code: 'ADMIN_FUNDS_OPERATION_SCOPE_REQUIRED' })
    await expect(
      listAdminNotificationDeliveries(
        await requestFor(configurationAdmin, 'funds-callpoint-delivery-list'),
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_FUNDS_OPERATION_SCOPE_REQUIRED' })
  })

  it('enforces the system-configuration scope independently at policy read and update call points', async () => {
    await expect(
      readAdminApprovalPolicy(await requestFor(fundsInitiator, 'policy-read-forbidden')),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
    await expect(
      updateAdminApprovalPolicy(await requestFor(fundsInitiator, 'policy-update-forbidden'), {
        changeNote: 'funds role must not update configuration',
        cooldownSeconds: 30,
        requiresDifferentApprover: true,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
  })
})

describe('D9-B-5 transactional notification outbox', () => {
  it('rejects full phone and document values before persisting message content', async () => {
    const eventKey = `${prefix}:sensitive-content:${randomUUID()}`
    await expect(
      enqueueTransactionalSecurityNotification(await baseRequest('sensitive-content'), {
        body: 'Sensitive +8613912345678 and 11010519491231002X',
        customerId: customer.id,
        domainEventType: 'fixture.sensitive.content',
        eventKey,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Sensitive fixture',
        templateKey: 'sensitive-fixture',
        templateVersion: 1,
        traceId: `${prefix}-sensitive-content`,
      }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN' })
    expect(await countWhere('notificationOutboxEvents', { eventKey: { equals: eventKey } })).toBe(0)
  })

  it('rolls the domain write and outbox event back together', async () => {
    const eventKey = `${prefix}:rollback:${randomUUID()}`
    const before = await payload.findByID({
      collection: 'customers',
      depth: 0,
      id: customer.id,
      overrideAccess: true,
    })
    const req = await baseRequest('outbox-rollback')
    await expect(
      inAuthTransaction(req, async () => {
        await req.payload.update({
          collection: 'customers',
          data: { phoneMasked: '+86139****0000' },
          id: customer.id,
          overrideAccess: true,
          req,
        })
        await enqueueTransactionalSecurityNotification(req, {
          body: 'This message must roll back with the business transaction.',
          customerId: customer.id,
          domainEventType: 'fixture.business.changed',
          eventKey,
          notificationType: 'admin_high_risk_operation_submitted',
          subject: 'Rollback fixture',
          templateKey: 'rollback-fixture',
          templateVersion: 1,
          traceId: `${prefix}-rollback`,
        })
        throw new Error('fixture rollback')
      }),
    ).rejects.toThrow('fixture rollback')
    expect(await countWhere('notificationOutboxEvents', { eventKey: { equals: eventKey } })).toBe(0)
    await expect(
      payload.findByID({
        collection: 'customers',
        depth: 0,
        id: customer.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ phoneMasked: before.phoneMasked })
  })

  it('targets every verified channel and keeps immutable content separate from read state', async () => {
    const eventKey = `${prefix}:all-channels:${randomUUID()}`
    const req = await baseRequest('all-channels')
    const created = await enqueueTransactionalSecurityNotification(req, {
      body: 'All verified channels receive this security notice.',
      customerId: customer.id,
      domainEventType: 'fixture.security.notice',
      eventKey,
      notificationType: 'admin_high_risk_operation_submitted',
      subject: 'All-channel fixture',
      templateKey: 'all-channel-fixture',
      templateVersion: 7,
      traceId: `${prefix}-all-channels`,
    })
    const deliveries = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { outboxEvent: { equals: created.outboxEventId } },
    })
    expect(deliveries.docs.map((delivery) => delivery.channel).sort()).toEqual(['sms', 'wechat'])
    await expect(
      payload.update({
        collection: 'notificationOutboxEvents',
        data: { bodySnapshot: 'mutated body' },
        id: created.outboxEventId,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_OUTBOX_APPEND_ONLY' })

    const customerReq = await requestFor(customer, 'mark-read')
    await expect(
      markCustomerNotificationRead(customerReq, created.outboxEventId),
    ).resolves.toMatchObject({
      updated: true,
    })
    const list = await listCustomerNotifications(await requestFor(customer, 'list-read'))
    expect(list.find((event) => String(event.id) === String(created.outboxEventId))).toMatchObject({
      body: 'All verified channels receive this security notice.',
      readAt: expect.any(String),
      templateVersion: 7,
    })
  })

  it('creates an in-app delivery when no verified external identity exists', async () => {
    const noChannels = await createCustomer('in-app-only', [])
    const created = await enqueueTransactionalSecurityNotification(
      await baseRequest('in-app-only'),
      {
        body: 'A transactional message still has an in-app fallback.',
        customerId: noChannels.id,
        domainEventType: 'fixture.in-app-only',
        eventKey: `${prefix}:in-app-only:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'In-app fallback fixture',
        templateKey: 'in-app-only-fixture',
        templateVersion: 1,
        traceId: `${prefix}-in-app-only`,
      },
    )
    const deliveries = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { outboxEvent: { equals: created.outboxEventId } },
    })
    expect(deliveries.docs.map((delivery) => delivery.channel)).toEqual(['in_app'])
  })

  it('retries known SMS failures, dead-letters at the limit, falls back in-app, and never changes business state', async () => {
    const phoneOnly = await createCustomer('delivery-failure', ['phone'])
    const req = await baseRequest('delivery-failure')
    const before = await payload.findByID({
      collection: 'customers',
      depth: 0,
      id: phoneOnly.id,
      overrideAccess: true,
    })
    const event = await enqueueTransactionalSecurityNotification(req, {
      body: 'Provider failure must not change the customer or asset state.',
      customerId: phoneOnly.id,
      domainEventType: 'fixture.delivery.failure',
      eventKey: `${prefix}:delivery-failure:${randomUUID()}`,
      notificationType: 'admin_high_risk_operation_submitted',
      subject: 'Delivery failure fixture',
      templateKey: 'delivery-failure-fixture',
      templateVersion: 1,
      traceId: `${prefix}-delivery-failure`,
    })
    const target = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    const deliveryId = target.docs[0]!.id
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const smsProvider: SmsProvider = {
      health: vi.fn(async () => mockSuccess({ healthy: true })),
      queryReceipt: vi.fn(async () => mockSuccess({ status: 'pending' as const })),
      sendDomainExpiry: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'expiry',
        }),
      ),
      sendIdentityChanged: vi.fn(async () =>
        mockFailure('SMS_RATE_LIMITED', { retryable: true, statusKnown: true }),
      ),
      sendOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'otp',
        }),
      ),
      sendStepUpOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'step-up',
        }),
      ),
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const runAt = new Date(Date.now() + attempt * 60_000)
      await payload.db.pool.query(
        'UPDATE notification_deliveries SET next_attempt_at = $1 WHERE id = $2',
        [new Date(runAt.getTime() - 1).toISOString(), deliveryId],
      )
      const summary = await runNotificationDeliveries(
        await baseRequest(`delivery-attempt-${attempt}`),
        {
          now: () => runAt,
          smsProvider,
        },
      )
      const delivery = await payload.db.pool.query(
        'SELECT status FROM notification_deliveries WHERE id = $1',
        [deliveryId],
      )
      expect(summary).toMatchObject(attempt < 3 ? { retryPending: 1 } : { deadLetter: 1 })
      expect(delivery.rows[0]?.status).toBe(attempt < 3 ? 'retry_pending' : 'dead_letter')
    }
    expect(
      await countWhere('notificationDeliveries', {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'in_app' } }],
      }),
    ).toBe(1)
    expect(
      await countWhere('notificationProviderReceipts', {
        delivery: { equals: deliveryId },
      }),
    ).toBe(3)
    await expect(
      payload.findByID({
        collection: 'customers',
        depth: 0,
        id: phoneOnly.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({
      capabilityRestrictions: before.capabilityRestrictions,
      status: before.status,
    })
  })

  it('dead-letters an interrupted sending lease without blindly resending', async () => {
    const phoneOnly = await createCustomer('interrupted-delivery', ['phone'])
    const req = await baseRequest('interrupted-delivery')
    const event = await enqueueTransactionalSecurityNotification(req, {
      body: 'An interrupted external send has unknown status and must not be replayed.',
      customerId: phoneOnly.id,
      domainEventType: 'fixture.delivery.interrupted',
      eventKey: `${prefix}:delivery-interrupted:${randomUUID()}`,
      notificationType: 'admin_high_risk_operation_submitted',
      subject: 'Interrupted delivery fixture',
      templateKey: 'delivery-interrupted-fixture',
      templateVersion: 1,
      traceId: `${prefix}-delivery-interrupted`,
    })
    const target = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    const deliveryId = target.docs[0]!.id
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET status = 'sending', attempt_count = 1,
           claimed_at = NOW() - INTERVAL '10 minutes', next_attempt_at = NOW()
       WHERE id = $1`,
      [deliveryId],
    )
    const summary = await runNotificationDeliveries(await baseRequest('recover-stale-lease'), {
      now: () => new Date(),
    })
    expect(summary.deadLetter).toBeGreaterThanOrEqual(1)
    await expect(
      payload.findByID({
        collection: 'notificationDeliveries',
        depth: 0,
        id: deliveryId,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({
      providerCode: 'NOTIFICATION_WORKER_INTERRUPTED',
      status: 'dead_letter',
    })
  })

  it('never retries an external failure whose upstream status is unknown', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('delivery-status-unknown', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('delivery-status-unknown-create'),
      {
        body: 'Unknown provider status must fail closed without a blind retry.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.status-unknown',
        eventKey: `${prefix}:delivery-status-unknown:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Unknown provider status fixture',
        templateKey: 'delivery-status-unknown-fixture',
        templateVersion: 1,
        traceId: `${prefix}-delivery-status-unknown`,
      },
    )
    const sendIdentityChanged = vi.fn(async () =>
      mockFailure('SMS_STATUS_UNKNOWN', { retryable: true, statusKnown: false }),
    )
    const summary = await runNotificationDeliveries(
      await baseRequest('delivery-status-unknown-run'),
      {
        now: () => new Date(Date.now() + 1_000),
        smsProvider: smsProviderFixture(sendIdentityChanged),
      },
    )
    expect(summary).toMatchObject({ deadLetter: 1, retryPending: 0 })
    expect(sendIdentityChanged).toHaveBeenCalledTimes(1)
    const smsDelivery = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    expect(smsDelivery.docs[0]).toMatchObject({
      attemptCount: 1,
      providerCode: 'SMS_STATUS_UNKNOWN',
      status: 'dead_letter',
    })
    expect(
      await countWhere('notificationDeliveries', {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'in_app' } }],
      }),
    ).toBe(1)
    const receipts = await payload.find({
      collection: 'notificationProviderReceipts',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { delivery: { equals: smsDelivery.docs[0]!.id } },
    })
    expect(receipts.docs).toHaveLength(1)
    expect(receipts.docs[0]).toMatchObject({ outcome: 'unknown' })
  })

  it('never retries a known non-retryable external failure', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('delivery-non-retryable', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('delivery-non-retryable-create'),
      {
        body: 'A terminal provider rejection must not be retried.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.non-retryable',
        eventKey: `${prefix}:delivery-non-retryable:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Non-retryable provider failure fixture',
        templateKey: 'delivery-non-retryable-fixture',
        templateVersion: 1,
        traceId: `${prefix}-delivery-non-retryable`,
      },
    )
    const sendIdentityChanged = vi.fn(async () =>
      mockFailure('SMS_RECIPIENT_REJECTED', { retryable: false, statusKnown: true }),
    )
    const summary = await runNotificationDeliveries(
      await baseRequest('delivery-non-retryable-run'),
      {
        now: () => new Date(Date.now() + 1_000),
        smsProvider: smsProviderFixture(sendIdentityChanged),
      },
    )
    expect(summary).toMatchObject({ deadLetter: 1, retryPending: 0 })
    const smsDelivery = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    expect(smsDelivery.docs[0]).toMatchObject({
      attemptCount: 1,
      providerCode: 'SMS_RECIPIENT_REJECTED',
      status: 'dead_letter',
    })
  })

  it('rechecks the due timestamp atomically after a stale candidate read', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('delivery-due-source', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('delivery-due-source-create'),
      {
        body: 'A stale worker candidate may not bypass the authoritative due time.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.due-source',
        eventKey: `${prefix}:delivery-due-source:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Delivery due source fixture',
        templateKey: 'delivery-due-source-fixture',
        templateVersion: 1,
        traceId: `${prefix}-delivery-due-source`,
      },
    )
    const target = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    const deliveryId = target.docs[0]!.id
    const find = vi
      .spyOn(payload, 'find')
      .mockResolvedValueOnce({ docs: [target.docs[0]] } as never)
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 hour'
       WHERE id = $1`,
      [deliveryId],
    )
    const sendIdentityChanged = vi.fn(async () =>
      mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'must-not-send-before-due',
      }),
    )
    try {
      await expect(
        runNotificationDeliveries(await baseRequest('delivery-due-source-run'), {
          now: () => new Date(),
          smsProvider: smsProviderFixture(sendIdentityChanged),
        }),
      ).resolves.toMatchObject({ claimed: 0 })
    } finally {
      find.mockRestore()
    }
    expect(sendIdentityChanged).not.toHaveBeenCalled()
    await expect(
      payload.findByID({
        collection: 'notificationDeliveries',
        depth: 0,
        id: deliveryId,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ attemptCount: 0, status: 'pending' })
  })

  it('rechecks claimable status atomically after a stale candidate read', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('delivery-status-source', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('delivery-status-source-create'),
      {
        body: 'A stale worker candidate may not reclaim a terminal delivery.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.status-source',
        eventKey: `${prefix}:delivery-status-source:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Delivery status source fixture',
        templateKey: 'delivery-status-source-fixture',
        templateVersion: 1,
        traceId: `${prefix}-delivery-status-source`,
      },
    )
    const target = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    const deliveryId = target.docs[0]!.id
    const find = vi
      .spyOn(payload, 'find')
      .mockResolvedValueOnce({ docs: [target.docs[0]] } as never)
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET status = 'delivered', attempt_count = 1, claimed_at = NOW(),
           delivered_at = NOW(), next_attempt_at = NOW()
       WHERE id = $1`,
      [deliveryId],
    )
    const sendIdentityChanged = vi.fn(async () =>
      mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'must-not-reclaim-terminal',
      }),
    )
    try {
      await expect(
        runNotificationDeliveries(await baseRequest('delivery-status-source-run'), {
          now: () => new Date(Date.now() + 1_000),
          smsProvider: smsProviderFixture(sendIdentityChanged),
        }),
      ).resolves.toMatchObject({ claimed: 0 })
    } finally {
      find.mockRestore()
    }
    expect(sendIdentityChanged).not.toHaveBeenCalled()
    await expect(
      payload.findByID({
        collection: 'notificationDeliveries',
        depth: 0,
        id: deliveryId,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ attemptCount: 1, status: 'delivered' })
  })

  it('binds delivery finalization to the exact claim timestamp fact', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('delivery-claim-source', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('delivery-claim-source-create'),
      {
        body: 'Only the worker owning the exact claim may finalize this delivery.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.claim-source',
        eventKey: `${prefix}:delivery-claim-source:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Delivery claim source fixture',
        templateKey: 'delivery-claim-source-fixture',
        templateVersion: 1,
        traceId: `${prefix}-delivery-claim-source`,
      },
    )
    const target = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    const deliveryId = target.docs[0]!.id
    const sendIdentityChanged = vi.fn(async () => {
      await payload.db.pool.query(
        `UPDATE notification_deliveries
         SET claimed_at = claimed_at + INTERVAL '1 second'
         WHERE id = $1 AND status = 'sending'`,
        [deliveryId],
      )
      return mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'claim-source-message',
      })
    })
    await expect(
      runNotificationDeliveries(await baseRequest('delivery-claim-source-run'), {
        now: () => new Date(Date.now() + 1_000),
        smsProvider: smsProviderFixture(sendIdentityChanged),
      }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_DELIVERY_STATE_CONFLICT' })
    expect(sendIdentityChanged).toHaveBeenCalledTimes(1)
    await expect(
      payload.findByID({
        collection: 'notificationDeliveries',
        depth: 0,
        id: deliveryId,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ status: 'sending' })
    expect(
      await countWhere('notificationProviderReceipts', { delivery: { equals: deliveryId } }),
    ).toBe(0)
  })

  it('binds delivery finalization to the exact claimed attempt fact', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('delivery-attempt-source', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('delivery-attempt-source-create'),
      {
        body: 'Only the worker owning the exact attempt may finalize this delivery.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.attempt-source',
        eventKey: `${prefix}:delivery-attempt-source:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Delivery attempt source fixture',
        templateKey: 'delivery-attempt-source-fixture',
        templateVersion: 1,
        traceId: `${prefix}-delivery-attempt-source`,
      },
    )
    const target = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    const deliveryId = target.docs[0]!.id
    const sendIdentityChanged = vi.fn(async () => {
      await payload.db.pool.query(
        `UPDATE notification_deliveries
         SET attempt_count = attempt_count + 1
         WHERE id = $1 AND status = 'sending'`,
        [deliveryId],
      )
      return mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'attempt-source-message',
      })
    })
    await expect(
      runNotificationDeliveries(await baseRequest('delivery-attempt-source-run'), {
        now: () => new Date(Date.now() + 1_000),
        smsProvider: smsProviderFixture(sendIdentityChanged),
      }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_DELIVERY_STATE_CONFLICT' })
    expect(sendIdentityChanged).toHaveBeenCalledTimes(1)
    await expect(
      payload.findByID({
        collection: 'notificationDeliveries',
        depth: 0,
        id: deliveryId,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ attemptCount: 2, status: 'sending' })
    expect(
      await countWhere('notificationProviderReceipts', { delivery: { equals: deliveryId } }),
    ).toBe(0)
  })

  it('claims one delivery exactly once across concurrent workers', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('delivery-concurrency', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('delivery-concurrency-create'),
      {
        body: 'Only one worker may send this message.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.concurrent',
        eventKey: `${prefix}:delivery-concurrent:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Concurrent delivery fixture',
        templateKey: 'delivery-concurrent-fixture',
        templateVersion: 1,
        traceId: `${prefix}-delivery-concurrent`,
      },
    )
    const sendIdentityChanged = vi.fn(async () =>
      mockSuccess({
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: 'concurrent-message',
      }),
    )
    const smsProvider: SmsProvider = {
      health: vi.fn(async () => mockSuccess({ healthy: true })),
      queryReceipt: vi.fn(async () => mockSuccess({ status: 'delivered' as const })),
      sendDomainExpiry: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'expiry',
        }),
      ),
      sendIdentityChanged,
      sendOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'otp',
        }),
      ),
      sendStepUpOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'step-up',
        }),
      ),
    }
    const runAt = new Date(Date.now() + 1_000)
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        runNotificationDeliveries(await baseRequest(`delivery-worker-${index}`), {
          now: () => runAt,
          smsProvider,
        }),
      ),
    )
    expect(sendIdentityChanged).toHaveBeenCalledTimes(1)
    const delivery = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { outboxEvent: { equals: event.outboxEventId } },
    })
    expect(
      await countWhere('notificationProviderReceipts', {
        delivery: { equals: delivery.docs[0]!.id },
      }),
    ).toBe(1)
  })

  it('queries SMS receipts with the immutable accepted-at fact rather than the retry time', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('receipt-time-source', ['phone'])
    await enqueueTransactionalSecurityNotification(await baseRequest('receipt-time-create'), {
      body: 'Receipt queries must use the original accepted timestamp.',
      customerId: phoneOnly.id,
      domainEventType: 'fixture.delivery.receipt-time',
      eventKey: `${prefix}:receipt-time:${randomUUID()}`,
      notificationType: 'admin_high_risk_operation_submitted',
      subject: 'Receipt time fixture',
      templateKey: 'receipt-time-fixture',
      templateVersion: 1,
      traceId: `${prefix}-receipt-time`,
    })
    const acceptedAt = new Date(Date.now() + 1_000)
    const receiptAt = new Date(acceptedAt.getTime() + 31_000)
    const queryReceipt = vi.fn(async () => mockSuccess({ status: 'delivered' as const }))
    const smsProvider: SmsProvider = {
      health: vi.fn(async () => mockSuccess({ healthy: true })),
      queryReceipt,
      sendDomainExpiry: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'expiry',
        }),
      ),
      sendIdentityChanged: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'accepted' as const,
          providerMessageId: 'receipt-time-message',
        }),
      ),
      sendOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'otp',
        }),
      ),
      sendStepUpOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'step-up',
        }),
      ),
    }
    await runNotificationDeliveries(await baseRequest('receipt-time-send'), {
      now: () => acceptedAt,
      smsProvider,
    })
    await runNotificationDeliveries(await baseRequest('receipt-time-query'), {
      now: () => receiptAt,
      smsProvider,
    })
    expect(queryReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: 'receipt-time-message',
        sentAt: acceptedAt.toISOString(),
      }),
    )
  })

  it('dead-letters an indefinitely pending provider receipt at the configured attempt limit', async () => {
    await payload.db.pool.query(
      `UPDATE notification_deliveries
       SET next_attempt_at = NOW() + INTERVAL '1 day'
       WHERE status IN ('pending', 'retry_pending', 'sent')`,
    )
    const phoneOnly = await createCustomer('receipt-pending-limit', ['phone'])
    const event = await enqueueTransactionalSecurityNotification(
      await baseRequest('receipt-pending-create'),
      {
        body: 'Pending receipts must eventually enter the dead-letter queue.',
        customerId: phoneOnly.id,
        domainEventType: 'fixture.delivery.receipt-pending',
        eventKey: `${prefix}:receipt-pending:${randomUUID()}`,
        notificationType: 'admin_high_risk_operation_submitted',
        subject: 'Receipt pending fixture',
        templateKey: 'receipt-pending-fixture',
        templateVersion: 1,
        traceId: `${prefix}-receipt-pending`,
      },
    )
    const sendIdentityChanged = vi.fn(async () =>
      mockSuccess({
        accepted: true as const,
        deliveryStatus: 'accepted' as const,
        providerMessageId: 'pending-receipt-message',
      }),
    )
    const queryReceipt = vi.fn(async () => mockSuccess({ status: 'pending' as const }))
    const smsProvider: SmsProvider = {
      health: vi.fn(async () => mockSuccess({ healthy: true })),
      queryReceipt,
      sendDomainExpiry: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'expiry',
        }),
      ),
      sendIdentityChanged,
      sendOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'otp',
        }),
      ),
      sendStepUpOtp: vi.fn(async () =>
        mockSuccess({
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: 'step-up',
        }),
      ),
    }
    const first = new Date(Date.now() + 1_000)
    for (const offsetSeconds of [0, 31, 92]) {
      await runNotificationDeliveries(await baseRequest(`receipt-pending-${offsetSeconds}`), {
        now: () => new Date(first.getTime() + offsetSeconds * 1_000),
        smsProvider,
      })
    }
    const delivery = await payload.find({
      collection: 'notificationDeliveries',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ outboxEvent: { equals: event.outboxEventId } }, { channel: { equals: 'sms' } }],
      },
    })
    expect(delivery.docs[0]).toMatchObject({
      attemptCount: 3,
      providerCode: 'NOTIFICATION_RECEIPT_PENDING_EXHAUSTED',
      status: 'dead_letter',
    })
    expect(sendIdentityChanged).toHaveBeenCalledTimes(1)
    expect(queryReceipt).toHaveBeenCalledTimes(2)
  })

  it('structurally forbids transactional unsubscribe while allowing marketing preferences', async () => {
    const req = await requestFor(customer, 'preferences')
    await expect(
      updateNotificationPreference(req, {
        category: 'transactional',
        enabled: false,
        notificationType: 'admin_high_risk_operation_submitted',
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTIONAL_NOTIFICATION_UNSUBSCRIBE_FORBIDDEN' })
    await expect(
      updateNotificationPreference(await requestFor(customer, 'preferences-marketing'), {
        category: 'marketing',
        enabled: false,
        notificationType: 'promotions',
      }),
    ).resolves.toMatchObject({ enabledMarketingTypes: ['product_updates'], updated: true })
    await expect(
      updateNotificationPreference(await requestFor(customer, 'preferences-type-mismatch'), {
        category: 'marketing',
        enabled: false,
        notificationType: 'admin_high_risk_operation_submitted',
      }),
    ).rejects.toMatchObject({ code: 'MARKETING_NOTIFICATION_TYPE_INVALID' })
  })

  it('requires the authenticated customer at every notification preference, list, and read call point', async () => {
    const anonymous = await baseRequest('anonymous-notification-access')
    await expect(
      updateNotificationPreference(anonymous, {
        category: 'marketing',
        enabled: false,
        notificationType: 'promotions',
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    await expect(listCustomerNotifications(anonymous)).rejects.toMatchObject({
      code: 'CUSTOMER_AUTH_REQUIRED',
    })
    await expect(markCustomerNotificationRead(anonymous, 1)).rejects.toMatchObject({
      code: 'CUSTOMER_AUTH_REQUIRED',
    })
  })

  it('masks phone and document values in admin list, access-event, and audit outputs', async () => {
    await setPolicy({ cooldownSeconds: 5, requiresDifferentApprover: true })
    const phone = '+8613912345678'
    const documentNumber = '11010519491231002X'
    const created = await createAdminApprovalRequest(
      await requestFor(fundsInitiator, 'sensitive-create'),
      {
        ...(operationFixtures(customer.id).vip_fraud_correction as Record<string, unknown>),
        reasonNote: `Manual evidence ${phone} ${documentNumber}`,
      },
    )
    await approve(created.id, fundsApprover, `Approval note ${phone} ${documentNumber}`)

    const listOutput = JSON.stringify(
      await listAdminApprovalRequests(await requestFor(fundsInitiator, 'sensitive-list')),
    )
    const access = await payload.find({
      collection: 'adminAccessEvents',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { approvalRequest: { equals: created.id } },
    })
    const audits = await payload.find({
      collection: 'auditLogs',
      depth: 0,
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { targetId: { equals: String(created.id) } },
          { targetType: { equals: 'admin-approval-request' } },
        ],
      },
    })
    const storedApproval = await payload.findByID({
      collection: 'adminApprovalRequests',
      depth: 0,
      id: created.id,
      overrideAccess: true,
    })
    const deliveryOutput = JSON.stringify(
      await listAdminNotificationDeliveries(
        await requestFor(fundsInitiator, 'sensitive-deliveries'),
      ),
    )
    for (const output of [
      listOutput,
      JSON.stringify(storedApproval),
      JSON.stringify(access.docs),
      JSON.stringify(audits.docs),
      deliveryOutput,
    ]) {
      expect(output).not.toContain(phone)
      expect(output).not.toContain(documentNumber)
    }
    expect(JSON.stringify(access.docs)).toContain('[REDACTED]')
    expect(JSON.stringify(storedApproval)).toContain('[REDACTED]')
    expect(JSON.stringify(audits.docs)).toContain('[REDACTED]')
    expect(deliveryOutput).toMatch(/\*{4}\d{4}/u)
  })
})
