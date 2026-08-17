import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticatedCustomerRequest: vi.fn(),
  execute: vi.fn(),
  getPayload: vi.fn(),
  request: vi.fn(),
  revoke: vi.fn(),
  systemAdminRequest: vi.fn(),
}))

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  getPayload: mocks.getPayload,
}))

vi.mock('@/services/auth/otp', () => ({
  authenticatedCustomerRequest: mocks.authenticatedCustomerRequest,
  requestCustomerDeletion: mocks.request,
}))

vi.mock('@/services/auth/account-closure', () => ({
  executeAccountClosure: mocks.execute,
  revokeAccountClosure: mocks.revoke,
}))

vi.mock('@/services/auth/admin-session', () => ({
  systemAdminRequest: mocks.systemAdminRequest,
}))

import { POST as revokeRoute } from '@/app/api/v1/account/closure-requests/[requestId]/revoke/route'
import { POST as executeRoute } from '@/app/api/v1/admin/account-closures/[requestId]/execute/route'
import { POST as requestRoute } from '@/app/api/v1/auth/deletion-request/route'
import { AppError } from '@/lib/errors'
import {
  accountClosureExecuteSchema,
  accountClosureRequestIdSchema,
  accountClosureRevokeSchema,
  customerDeletionRequestSchema,
} from '@/schemas/auth'

const requestId = 'b8eeaf9e-ff69-4a63-b62a-2bf7aba8046e'
const validRequest = {
  confirmation: 'DELETE_MY_ACCOUNT',
  deviceId: 'device-fixture-1234567890',
  reason: '不再使用这个账号',
  stepUpToken: 'A'.repeat(43),
} as const
const validRevoke = { confirmation: 'KEEP_MY_ACCOUNT', reason: '暂时继续使用账号' } as const
const validExecute = {
  confirmation: 'EXECUTE_ACCOUNT_CLOSURE',
  note: '全部阻塞项与冷静期已复核',
} as const

function post(url: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

function context(id = requestId) {
  return { params: Promise.resolve({ requestId: id }) }
}

beforeEach(() => {
  mocks.getPayload.mockReset().mockResolvedValue({})
  mocks.authenticatedCustomerRequest.mockReset().mockResolvedValue({
    req: { headers: new Headers(), payload: {}, user: { id: 9 } },
    user: { collection: 'customers', id: 9 },
  })
  mocks.systemAdminRequest.mockReset().mockResolvedValue({
    req: { headers: new Headers(), payload: {}, user: { id: 7 } },
    user: { collection: 'admins', id: 7 },
  })
  mocks.request.mockReset().mockResolvedValue({
    blockers: [],
    cooldownEndsAt: '2026-08-23T20:00:00.000Z',
    deletionRequestedAt: '2026-08-16T20:00:00.000Z',
    requestId,
    status: 'pending',
  })
  mocks.revoke.mockReset().mockResolvedValue({
    requestId,
    revokedAt: '2026-08-16T21:00:00.000Z',
    status: 'revoked',
  })
  mocks.execute.mockReset().mockResolvedValue({
    executedAt: '2026-08-23T20:00:01.000Z',
    identityRebindAllowedAt: '2026-09-22T20:00:01.000Z',
    requestId,
    status: 'closed',
  })
})

describe('D9-A A6 account-closure routes', () => {
  it('routes request, revocation, and final execution through their distinct identity gates', async () => {
    const requested = await requestRoute(
      post('http://wanmi.local/api/v1/auth/deletion-request', JSON.stringify(validRequest)),
    )
    expect(requested.status).toBe(202)
    expect(mocks.authenticatedCustomerRequest).toHaveBeenCalledOnce()
    expect(mocks.request).toHaveBeenCalledWith(expect.anything(), expect.anything(), validRequest)

    const revoked = await revokeRoute(
      post(
        `http://wanmi.local/api/v1/account/closure-requests/${requestId}/revoke`,
        JSON.stringify(validRevoke),
      ),
      context(),
    )
    expect(revoked.status).toBe(200)
    expect(mocks.revoke).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      reason: validRevoke.reason,
      requestId,
    })

    const executed = await executeRoute(
      post(
        `http://wanmi.local/api/v1/admin/account-closures/${requestId}/execute`,
        JSON.stringify(validExecute),
      ),
      context(),
    )
    expect(executed.status).toBe(200)
    expect(mocks.systemAdminRequest).toHaveBeenCalledOnce()
    expect(mocks.execute).toHaveBeenCalledWith(expect.anything(), {
      actorId: 7,
      note: validExecute.note,
      requestId,
    })
  })

  it('fails closed when the customer or system-admin gate rejects', async () => {
    mocks.authenticatedCustomerRequest.mockRejectedValueOnce(
      new AppError('CUSTOMER_AUTH_REQUIRED', 'customer required', 401),
    )
    const requested = await requestRoute(
      post('http://wanmi.local/api/v1/auth/deletion-request', JSON.stringify(validRequest)),
    )
    expect(requested.status).toBe(401)
    expect(mocks.request).not.toHaveBeenCalled()

    mocks.authenticatedCustomerRequest.mockRejectedValueOnce(
      new AppError('CUSTOMER_AUTH_REQUIRED', 'customer required', 401),
    )
    const revoked = await revokeRoute(
      post(
        `http://wanmi.local/api/v1/account/closure-requests/${requestId}/revoke`,
        JSON.stringify(validRevoke),
      ),
      context(),
    )
    expect(revoked.status).toBe(401)
    expect(mocks.revoke).not.toHaveBeenCalled()

    mocks.systemAdminRequest.mockRejectedValueOnce(
      new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', 'system admin required', 403),
    )
    const executed = await executeRoute(
      post(
        `http://wanmi.local/api/v1/admin/account-closures/${requestId}/execute`,
        JSON.stringify(validExecute),
      ),
      context(),
    )
    expect(executed.status).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('rejects invalid request ids before authentication', async () => {
    for (const id of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const response = await executeRoute(
        post(
          `http://wanmi.local/api/v1/admin/account-closures/${id}/execute`,
          JSON.stringify(validExecute),
        ),
        context(id),
      )
      expect(response.status, id).toBe(400)
    }
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('rejects non-JSON, malformed, declared oversized, and actual oversized bodies on every route', async () => {
    const cases: Array<{
      call: (request: Request) => Promise<Response>
      url: string
    }> = [
      {
        call: requestRoute,
        url: 'http://wanmi.local/api/v1/auth/deletion-request',
      },
      {
        call: (request) => revokeRoute(request, context()),
        url: `http://wanmi.local/api/v1/account/closure-requests/${requestId}/revoke`,
      },
      {
        call: (request) => executeRoute(request, context()),
        url: `http://wanmi.local/api/v1/admin/account-closures/${requestId}/execute`,
      },
    ]
    for (const candidate of cases) {
      expect(
        (await candidate.call(post(candidate.url, '{}', { 'content-type': 'text/plain' }))).status,
      ).toBe(415)
      expect((await candidate.call(post(candidate.url, '{not-json'))).status).toBe(400)
      for (const length of ['-1', 'not-a-number', '4097']) {
        expect(
          (await candidate.call(post(candidate.url, '{}', { 'content-length': length }))).status,
          `${candidate.url} ${length}`,
        ).toBe(413)
      }
      expect(
        (await candidate.call(post(candidate.url, JSON.stringify('界'.repeat(2_000))))).status,
      ).toBe(413)
    }
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('requires strict confirmations, bounded reasons and notes, one-time grant shape, and UUID ids', () => {
    expect(customerDeletionRequestSchema.safeParse(validRequest).success).toBe(true)
    expect(accountClosureRevokeSchema.safeParse(validRevoke).success).toBe(true)
    expect(accountClosureExecuteSchema.safeParse(validExecute).success).toBe(true)
    expect(accountClosureRequestIdSchema.safeParse(requestId).success).toBe(true)

    for (const field of ['confirmation', 'deviceId', 'reason', 'stepUpToken'] as const) {
      const input = { ...validRequest } as Record<string, unknown>
      delete input[field]
      expect(customerDeletionRequestSchema.safeParse(input).success, field).toBe(false)
    }
    expect(
      customerDeletionRequestSchema.safeParse({ ...validRequest, confirmation: 'YES' }).success,
    ).toBe(false)
    expect(
      customerDeletionRequestSchema.safeParse({ ...validRequest, deviceId: 'short' }).success,
    ).toBe(false)
    expect(
      customerDeletionRequestSchema.safeParse({ ...validRequest, deviceId: 'D'.repeat(129) })
        .success,
    ).toBe(false)
    expect(
      customerDeletionRequestSchema.safeParse({ ...validRequest, reason: '   ' }).success,
    ).toBe(false)
    expect(customerDeletionRequestSchema.safeParse({ ...validRequest, reason: '好' }).success).toBe(
      false,
    )
    expect(
      customerDeletionRequestSchema.safeParse({ ...validRequest, reason: '理'.repeat(1_001) })
        .success,
    ).toBe(false)
    expect(
      customerDeletionRequestSchema.safeParse({ ...validRequest, stepUpToken: 'A'.repeat(42) })
        .success,
    ).toBe(false)
    expect(customerDeletionRequestSchema.safeParse({ ...validRequest, extra: true }).success).toBe(
      false,
    )

    for (const field of ['confirmation', 'reason'] as const) {
      const input = { ...validRevoke } as Record<string, unknown>
      delete input[field]
      expect(accountClosureRevokeSchema.safeParse(input).success, `revoke ${field}`).toBe(false)
    }
    expect(
      accountClosureRevokeSchema.safeParse({ ...validRevoke, confirmation: 'NO' }).success,
    ).toBe(false)
    expect(accountClosureRevokeSchema.safeParse({ ...validRevoke, reason: '   ' }).success).toBe(
      false,
    )
    expect(accountClosureRevokeSchema.safeParse({ ...validRevoke, reason: '撤' }).success).toBe(
      false,
    )
    expect(
      accountClosureRevokeSchema.safeParse({ ...validRevoke, reason: '撤'.repeat(1_001) }).success,
    ).toBe(false)
    expect(accountClosureRevokeSchema.safeParse({ ...validRevoke, extra: true }).success).toBe(
      false,
    )

    for (const field of ['confirmation', 'note'] as const) {
      const input = { ...validExecute } as Record<string, unknown>
      delete input[field]
      expect(accountClosureExecuteSchema.safeParse(input).success, `execute ${field}`).toBe(false)
    }
    expect(
      accountClosureExecuteSchema.safeParse({ ...validExecute, confirmation: 'YES' }).success,
    ).toBe(false)
    expect(accountClosureExecuteSchema.safeParse({ ...validExecute, note: '   ' }).success).toBe(
      false,
    )
    expect(accountClosureExecuteSchema.safeParse({ ...validExecute, note: '核' }).success).toBe(
      false,
    )
    expect(
      accountClosureExecuteSchema.safeParse({ ...validExecute, note: '核'.repeat(2_001) }).success,
    ).toBe(false)
    expect(accountClosureExecuteSchema.safeParse({ ...validExecute, extra: true }).success).toBe(
      false,
    )
    expect(accountClosureRequestIdSchema.safeParse('not-a-uuid').success).toBe(false)
  })
})
