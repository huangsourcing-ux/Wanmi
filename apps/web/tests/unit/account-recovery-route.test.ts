import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createApproval: vi.fn(),
  createLocalReq: vi.fn(),
  getPayload: vi.fn(),
  submit: vi.fn(),
  systemAdminRequest: vi.fn(),
}))

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  createLocalReq: mocks.createLocalReq,
  getPayload: mocks.getPayload,
}))

vi.mock('@/services/auth/account-recovery', () => ({
  submitAccountRecoveryRequest: mocks.submit,
}))

vi.mock('@/services/admin/approvals', () => ({
  createAdminApprovalRequest: mocks.createApproval,
}))

vi.mock('@/services/auth/admin-session', () => ({
  systemAdminRequest: mocks.systemAdminRequest,
}))

import { POST as decideRoute } from '@/app/api/v1/admin/account-recoveries/[reviewId]/decision/route'
import { POST as submitRoute } from '@/app/api/v1/auth/account-recovery/route'
import { AppError } from '@/lib/errors'
import { accountRecoveryDecisionSchema, accountRecoveryRequestSchema } from '@/schemas/auth'

const validRequest = {
  fullNameChinese: '李小明',
  historicalOrderNumber: 'A5-ORDER-20260816',
  identityDocumentNumber: '11010519491231002X',
  paymentTransactionId: '420000202608160000001',
  phone: '+8613912345678',
  phoneUnavailable: true,
  wechatUnavailable: true,
} as const

function request(url: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

function decisionContext(reviewId = '42') {
  return { params: Promise.resolve({ reviewId }) }
}

beforeEach(() => {
  mocks.getPayload.mockReset().mockResolvedValue({})
  mocks.createLocalReq.mockReset().mockResolvedValue({ headers: new Headers(), payload: {} })
  mocks.systemAdminRequest.mockReset().mockResolvedValue({
    req: {
      headers: new Headers(),
      payload: {
        findByID: vi.fn().mockResolvedValue({
          customer: 9,
          reasonCode: 'customer_account_recovery',
          status: 'open',
        }),
      },
      user: { id: 7 },
    },
    user: { id: 7 },
  })
  mocks.submit.mockReset().mockResolvedValue({
    recoveryRequestId: 'b8eeaf9e-ff69-4a63-b62a-2bf7aba8046e',
    status: 'manual_review',
    submittedAt: '2026-08-16T15:00:00.000Z',
  })
  mocks.createApproval.mockReset().mockResolvedValue({
    id: 19,
    operationType: 'account_recovery',
    status: 'pending_approval',
  })
})

describe('D9-A A5 public account-recovery route', () => {
  it('accepts the strict evidence request and routes it to the manual-review service', async () => {
    const response = await submitRoute(
      request('http://wanmi.local/api/v1/auth/account-recovery', JSON.stringify(validRequest)),
    )
    expect(response.status).toBe(202)
    expect(mocks.submit).toHaveBeenCalledWith(expect.anything(), validRequest)
  })

  it('rejects non-JSON request bodies before creating a Payload request', async () => {
    const response = await submitRoute(
      request('http://wanmi.local/api/v1/auth/account-recovery', '{}', {
        'content-type': 'text/plain',
      }),
    )
    expect(response.status).toBe(415)
    expect(mocks.createLocalReq).not.toHaveBeenCalled()
  })

  it('rejects invalid or oversized declared request lengths before reading evidence', async () => {
    for (const declaredLength of ['-1', 'not-a-number', '4097']) {
      const response = await submitRoute(
        request('http://wanmi.local/api/v1/auth/account-recovery', '{}', {
          'content-length': declaredLength,
        }),
      )
      expect(response.status, declaredLength).toBe(413)
    }
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('rejects an oversized actual UTF-8 account-recovery body', async () => {
    const response = await submitRoute(
      request(
        'http://wanmi.local/api/v1/auth/account-recovery',
        JSON.stringify('界'.repeat(2_000)),
      ),
    )
    expect(response.status).toBe(413)
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('maps malformed JSON to the stable invalid-request response', async () => {
    const response = await submitRoute(
      request('http://wanmi.local/api/v1/auth/account-recovery', '{not-json'),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('INVALID_REQUEST')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('requires every evidence field, both unavailable-channel declarations, and no unknown fields', () => {
    for (const field of [
      'fullNameChinese',
      'historicalOrderNumber',
      'identityDocumentNumber',
      'paymentTransactionId',
      'phone',
      'phoneUnavailable',
      'wechatUnavailable',
    ] as const) {
      const candidate = { ...validRequest } as Record<string, unknown>
      delete candidate[field]
      expect(accountRecoveryRequestSchema.safeParse(candidate).success, field).toBe(false)
    }
    expect(
      accountRecoveryRequestSchema.safeParse({ ...validRequest, rawDocument: 'must-not-pass' })
        .success,
    ).toBe(false)
    expect(
      accountRecoveryRequestSchema.safeParse({ ...validRequest, phoneUnavailable: false }).success,
    ).toBe(false)
    expect(
      accountRecoveryRequestSchema.safeParse({ ...validRequest, wechatUnavailable: false }).success,
    ).toBe(false)
    const bounds: Array<[keyof typeof validRequest, unknown, unknown]> = [
      ['fullNameChinese', '李', '李'.repeat(51)],
      ['historicalOrderNumber', 'short', 'O'.repeat(65)],
      ['identityDocumentNumber', 'A5', 'I'.repeat(65)],
      ['paymentTransactionId', 'short', 'P'.repeat(129)],
      ['phone', '1234567890', '1'.repeat(17)],
    ]
    for (const [field, tooShort, tooLong] of bounds) {
      expect(
        accountRecoveryRequestSchema.safeParse({ ...validRequest, [field]: ' '.repeat(16) })
          .success,
        `${field} trimmed blank`,
      ).toBe(false)
      expect(
        accountRecoveryRequestSchema.safeParse({ ...validRequest, [field]: tooShort }).success,
        `${field} minimum`,
      ).toBe(false)
      expect(
        accountRecoveryRequestSchema.safeParse({ ...validRequest, [field]: tooLong }).success,
        `${field} maximum`,
      ).toBe(false)
    }
  })
})

describe('D9-A A5 system-admin recovery approval initiation route', () => {
  const validDecision = { conclusion: 'approved', note: '证据已由人工逐项核验' } as const

  it('routes a valid decision through the system-admin gate', async () => {
    const response = await decideRoute(
      request(
        'http://wanmi.local/api/v1/admin/account-recoveries/42/decision',
        JSON.stringify(validDecision),
      ),
      decisionContext(),
    )
    expect(response.status).toBe(201)
    expect(mocks.systemAdminRequest).toHaveBeenCalledOnce()
    expect(mocks.createApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        customerId: 9,
        decision: 'approved',
        operationType: 'account_recovery',
        reasonNote: validDecision.note,
        reviewId: 42,
      }),
    )
  })

  it('fails closed when the system-admin request gate rejects', async () => {
    mocks.systemAdminRequest.mockRejectedValueOnce(
      new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', 'system admin required', 403),
    )
    const response = await decideRoute(
      request(
        'http://wanmi.local/api/v1/admin/account-recoveries/42/decision',
        JSON.stringify(validDecision),
      ),
      decisionContext(),
    )
    expect(response.status).toBe(403)
    expect(mocks.createApproval).not.toHaveBeenCalled()
  })

  it('rejects invalid review ids before authentication', async () => {
    for (const reviewId of ['0', '1.5', 'not-a-number']) {
      const response = await decideRoute(
        request(
          `http://wanmi.local/api/v1/admin/account-recoveries/${reviewId}/decision`,
          JSON.stringify(validDecision),
        ),
        decisionContext(reviewId),
      )
      expect(response.status, reviewId).toBe(400)
    }
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('rejects non-JSON, malformed, and oversized review bodies before authentication', async () => {
    const cases: Array<[string, Record<string, string>, number]> = [
      ['{}', { 'content-type': 'text/plain' }, 415],
      ['{not-json', {}, 400],
      ['{}', { 'content-length': '8193' }, 413],
      ['{}', { 'content-length': '-1' }, 413],
      ['{}', { 'content-length': 'invalid' }, 413],
    ]
    for (const [body, headers, status] of cases) {
      const response = await decideRoute(
        request('http://wanmi.local/api/v1/admin/account-recoveries/42/decision', body, headers),
        decisionContext(),
      )
      expect(response.status).toBe(status)
    }
    const oversized = await decideRoute(
      request(
        'http://wanmi.local/api/v1/admin/account-recoveries/42/decision',
        JSON.stringify('界'.repeat(3_000)),
      ),
      decisionContext(),
    )
    expect(oversized.status).toBe(413)
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('requires one approved/rejected conclusion, a bounded note, and no unknown fields', () => {
    expect(accountRecoveryDecisionSchema.safeParse(validDecision).success).toBe(true)
    expect(accountRecoveryDecisionSchema.safeParse({ note: validDecision.note }).success).toBe(
      false,
    )
    expect(
      accountRecoveryDecisionSchema.safeParse({ conclusion: 'allow', note: validDecision.note })
        .success,
    ).toBe(false)
    expect(accountRecoveryDecisionSchema.safeParse({ conclusion: 'approved' }).success).toBe(false)
    expect(
      accountRecoveryDecisionSchema.safeParse({ conclusion: 'approved', note: 'x' }).success,
    ).toBe(false)
    expect(
      accountRecoveryDecisionSchema.safeParse({ conclusion: 'approved', note: '   ' }).success,
    ).toBe(false)
    expect(
      accountRecoveryDecisionSchema.safeParse({
        conclusion: 'approved',
        note: 'x'.repeat(2_001),
      }).success,
    ).toBe(false)
    expect(
      accountRecoveryDecisionSchema.safeParse({ ...validDecision, providerSecret: 'no' }).success,
    ).toBe(false)
  })
})
