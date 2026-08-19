import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createApproval: vi.fn(),
  getPayload: vi.fn(),
  revoke: vi.fn(),
  systemAdminRequest: vi.fn(),
  transition: vi.fn(),
}))

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  getPayload: mocks.getPayload,
}))

vi.mock('@/services/auth/admin-session', () => ({
  systemAdminRequest: mocks.systemAdminRequest,
}))

vi.mock('@/services/auth/account-state', () => ({
  revokeCustomerSessionsForSecurityEvent: mocks.revoke,
  transitionCustomerAccount: mocks.transition,
}))

vi.mock('@/services/admin/approvals', () => ({
  createAdminApprovalRequest: mocks.createApproval,
}))

import { POST } from '@/app/api/v1/admin/customers/[customerId]/account-security/route'
import { AppError } from '@/lib/errors'
import { adminCustomerAccountActionSchema, customerDeletionRequestSchema } from '@/schemas/auth'

const evidence = {
  observedAt: '2026-08-16T08:00:00.000Z',
  reference: 'ticket:A3-SECURITY',
  source: 'security_event' as const,
}

function revokeBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: 'revoke_sessions',
    evidence,
    reason: 'credential compromise',
    ...overrides,
  })
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://wanmi.local/api/v1/admin/customers/42/account-security', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

function context(customerId = '42') {
  return { params: Promise.resolve({ customerId }) }
}

beforeEach(() => {
  mocks.getPayload.mockReset().mockResolvedValue({})
  mocks.systemAdminRequest.mockReset().mockResolvedValue({
    req: { user: { collection: 'admins', id: 7, roles: ['system_admin'], status: 'active' } },
    user: { id: 7 },
  })
  mocks.revoke.mockReset().mockResolvedValue({ revokedCount: 2 })
  mocks.createApproval.mockReset().mockResolvedValue({
    id: 19,
    operationType: 'high_risk_account_unfreeze',
    status: 'pending_approval',
  })
  mocks.transition.mockReset().mockResolvedValue({
    capabilityRestrictions: ['purchase_disabled'],
    changedAt: '2026-08-16T08:00:00.000Z',
    customerId: 42,
    status: 'restricted',
  })
})

describe('D9-A A3 admin account-security route', () => {
  it('rejects non-JSON bodies before authentication', async () => {
    const response = await POST(request(revokeBody(), { 'content-type': 'text/plain' }), context())
    expect(response.status).toBe(415)
    expect((await response.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('rejects an oversized declared content length before reading the body', async () => {
    const response = await POST(request(revokeBody(), { 'content-length': '8193' }), context())
    expect(response.status).toBe(413)
    expect((await response.json()).code).toBe('ACCOUNT_SECURITY_REQUEST_TOO_LARGE')
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('rejects an oversized actual UTF-8 body even without a declared length', async () => {
    const response = await POST(request(`${revokeBody()}${' '.repeat(8_193)}`), context())
    expect(response.status).toBe(413)
    expect((await response.json()).code).toBe('ACCOUNT_SECURITY_REQUEST_TOO_LARGE')
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('maps malformed JSON to the stable invalid-request response', async () => {
    const response = await POST(request('{not-json'), context())
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('INVALID_REQUEST')
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('rejects a non-positive customer id before authentication', async () => {
    const response = await POST(request(revokeBody()), context('0'))
    expect(response.status).toBe(400)
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('fails closed when the system-admin request gate rejects', async () => {
    mocks.systemAdminRequest.mockRejectedValueOnce(
      new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', 'system admin required', 403),
    )
    const response = await POST(request(revokeBody()), context())
    expect(response.status).toBe(403)
    expect(mocks.revoke).not.toHaveBeenCalled()
    expect(mocks.transition).not.toHaveBeenCalled()
  })

  it('routes revoke_sessions only to the session security action', async () => {
    const response = await POST(request(revokeBody()), context())
    expect(response.status).toBe(200)
    expect(mocks.revoke).toHaveBeenCalledOnce()
    expect(mocks.revoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: { id: 7, type: 'admin' },
        customerId: 42,
        evidence,
        reason: 'credential compromise',
      }),
    )
    expect(mocks.transition).not.toHaveBeenCalled()
  })

  it('routes change_state only to the atomic transition service', async () => {
    const response = await POST(
      request(
        JSON.stringify({
          action: 'change_state',
          evidence,
          expectedRestrictions: [],
          expectedStatus: 'active',
          reason: 'manual security review',
          restrictions: ['purchase_disabled'],
          status: 'restricted',
        }),
      ),
      context(),
    )
    expect(response.status).toBe(200)
    expect(mocks.transition).toHaveBeenCalledOnce()
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: { id: 7, type: 'admin' },
        customerId: 42,
        expectedStatus: 'active',
        status: 'restricted',
      }),
    )
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it('initiates approval instead of directly unfreezing a high-risk account', async () => {
    const response = await POST(
      request(
        JSON.stringify({
          action: 'change_state',
          evidence,
          expectedRestrictions: ['login_disabled'],
          expectedStatus: 'suspended',
          reason: 'manual security review completed',
          restrictions: [],
          status: 'active',
        }),
      ),
      context(),
    )
    expect(response.status).toBe(201)
    expect(mocks.createApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        customerId: 42,
        evidenceReference: evidence.reference,
        expectedRestrictions: ['login_disabled'],
        expectedStatus: 'suspended',
        operationType: 'high_risk_account_unfreeze',
      }),
    )
    expect(mocks.transition).not.toHaveBeenCalled()
  })

  it('rejects duplicate restrictions and unexpected fields before authentication', async () => {
    const body = JSON.stringify({
      action: 'change_state',
      evidence,
      expectedRestrictions: [],
      expectedStatus: 'active',
      providerSecret: 'must-not-pass',
      reason: 'manual security review',
      restrictions: ['purchase_disabled', 'purchase_disabled'],
      status: 'restricted',
    })
    const response = await POST(request(body), context())
    expect(response.status).toBe(400)
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('rejects duplicate account restrictions at the admin schema boundary', () => {
    expect(
      adminCustomerAccountActionSchema.safeParse({
        action: 'change_state',
        evidence,
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'manual security review',
        restrictions: ['purchase_disabled', 'purchase_disabled'],
        status: 'restricted',
      }).success,
    ).toBe(false)
  })

  it('rejects unknown account states at the admin schema boundary', () => {
    expect(
      adminCustomerAccountActionSchema.safeParse({
        action: 'change_state',
        evidence,
        expectedRestrictions: [],
        expectedStatus: 'future_state',
        reason: 'manual security review',
        restrictions: [],
        status: 'active',
      }).success,
    ).toBe(false)
  })

  it('rejects incomplete or unstructured account-state evidence', () => {
    expect(
      adminCustomerAccountActionSchema.safeParse({
        action: 'change_state',
        evidence: { observedAt: evidence.observedAt, reference: evidence.reference },
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'manual security review',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }).success,
    ).toBe(false)
    expect(
      adminCustomerAccountActionSchema.safeParse({
        action: 'change_state',
        evidence: { ...evidence, providerSecret: 'must-not-pass' },
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'manual security review',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }).success,
    ).toBe(false)
  })

  it('rejects unexpected admin account-action fields', () => {
    expect(
      adminCustomerAccountActionSchema.safeParse({
        action: 'change_state',
        evidence,
        expectedRestrictions: [],
        expectedStatus: 'active',
        providerSecret: 'must-not-pass',
        reason: 'manual security review',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }).success,
    ).toBe(false)
  })

  it.each([
    [
      'confirmation',
      {
        confirmation: 'NOT_CONFIRMED',
        deviceId: 'account-device-0001',
        stepUpToken: 'a'.repeat(43),
      },
    ],
    ['deviceId', { confirmation: 'DELETE_MY_ACCOUNT', stepUpToken: 'a'.repeat(43) }],
    ['stepUpToken', { confirmation: 'DELETE_MY_ACCOUNT', deviceId: 'account-device-0001' }],
    [
      'unknown field',
      {
        confirmation: 'DELETE_MY_ACCOUNT',
        deviceId: 'account-device-0001',
        providerSecret: 'must-not-pass',
        stepUpToken: 'a'.repeat(43),
      },
    ],
  ])('requires deletion %s at the strict request schema boundary', (_case, input) => {
    expect(customerDeletionRequestSchema.safeParse(input).success).toBe(false)
  })
})
