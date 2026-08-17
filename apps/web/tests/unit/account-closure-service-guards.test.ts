import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  authorize: vi.fn(),
  create: vi.fn(),
  database: { execute: vi.fn() },
  disableTemplates: vi.fn(),
  positiveBalance: vi.fn(),
  security: vi.fn(),
  transition: vi.fn(),
}))

vi.mock('@/services/auth/atomic', () => ({
  authTransactionDatabase: vi.fn().mockResolvedValue(mocks.database),
  inAuthTransaction: vi.fn(async (_req, work: () => Promise<unknown>) => work()),
}))

vi.mock('@/services/auth/account-state', () => ({
  accountRestrictions: vi.fn(({ capabilityRestrictions }) => capabilityRestrictions),
  transitionCustomerAccount: mocks.transition,
}))

vi.mock('@/services/auth/step-up', () => ({ authorizeStepUpGrant: mocks.authorize }))
vi.mock('@/services/wallet/ledger', () => ({
  hasPositiveWalletAvailableBalance: mocks.positiveBalance,
}))
vi.mock('@/services/audit/record-audit-event', () => ({ recordAuditEvent: mocks.audit }))
vi.mock('@/services/auth/security-events', () => ({
  recordCustomerSecurityEvent: mocks.security,
}))
vi.mock('@/services/realname/lifecycle', () => ({
  disableCustomerRealnameTemplates: mocks.disableTemplates,
}))

import { executeAccountClosure } from '@/services/auth/account-closure'

const requestId = 'b8eeaf9e-ff69-4a63-b62a-2bf7aba8046e'
const requestedRow = {
  cooldown_ends_at: '2026-08-16T19:00:00.000Z',
  cooldown_started_at: '2026-08-09T20:00:00.000Z',
  current_blockers: [],
  customer_id: 9,
  reason: '关闭账号',
  request_key: requestId,
  requested_at: '2026-08-09T20:00:00.000Z',
}
const claimRow = { capability_restrictions: [], id: 9, status: 'active' }

function req() {
  return {
    headers: new Headers({ 'x-request-id': 'd9a-a6-service-guards' }),
    payload: { create: mocks.create },
    user: {
      collection: 'admins',
      id: 7,
      roles: ['system_admin'],
      status: 'active',
    },
  } as never
}

function execute() {
  return executeAccountClosure(req(), {
    actorId: 7,
    note: '守卫行为测试',
    requestId,
  })
}

function queueRequested(row: Record<string, unknown> | null = requestedRow) {
  mocks.database.execute.mockResolvedValueOnce({ rows: row ? [row] : [] })
}

function queueClaim(row: Record<string, unknown> | undefined = claimRow) {
  mocks.database.execute.mockResolvedValueOnce({ rows: row ? [row] : [] })
}

function queueCleanPreconditions() {
  for (let index = 0; index < 6; index += 1) {
    mocks.database.execute.mockResolvedValueOnce({ rows: [{ blocked: false }] })
  }
  mocks.database.execute.mockResolvedValueOnce({ rows: [{ relation_name: null }] })
}

beforeEach(() => {
  mocks.database.execute.mockReset()
  mocks.create.mockReset().mockResolvedValue({ id: 1 })
  mocks.transition.mockReset().mockResolvedValue({ status: 'closed' })
  mocks.disableTemplates.mockReset().mockResolvedValue(0)
  mocks.positiveBalance.mockReset().mockResolvedValue(false)
  mocks.audit.mockReset().mockResolvedValue(undefined)
  mocks.security.mockReset().mockResolvedValue(undefined)
  mocks.authorize.mockReset().mockResolvedValue({
    grantId: 1,
    oneTime: true,
    purpose: 'account_deletion',
  })
})

describe('D9-A A6 account-closure service fail-closed guards', () => {
  it('rejects missing, unreadable, malformed-id, malformed-blocker, and malformed-time requested records', async () => {
    queueRequested(null)
    await expect(execute()).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUEST_NOT_FOUND' })

    mocks.database.execute.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(execute()).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_STATE_UNAVAILABLE' })

    for (const customerId of [0, 1.5]) {
      queueRequested({ ...requestedRow, customer_id: customerId })
      await expect(execute(), String(customerId)).rejects.toMatchObject({
        code: 'ACCOUNT_CLOSURE_STATE_UNAVAILABLE',
      })
    }
    for (const blockers of ['abc', ['domains_held', 'domains_held'], ['not_a_blocker'], [42]]) {
      queueRequested({ ...requestedRow, current_blockers: blockers })
      await expect(execute(), JSON.stringify(blockers)).rejects.toMatchObject({
        code: 'ACCOUNT_CLOSURE_STATE_UNAVAILABLE',
      })
    }
    for (const field of ['cooldown_ends_at', 'cooldown_started_at', 'requested_at'] as const) {
      queueRequested({ ...requestedRow, [field]: 'not-a-date' })
      await expect(execute(), field).rejects.toMatchObject({
        code: 'ACCOUNT_CLOSURE_STATE_UNAVAILABLE',
      })
    }
  })

  it('rejects a malformed claimed customer id before any state transition', async () => {
    for (const id of [0, 1.5]) {
      queueRequested()
      queueClaim({ ...claimRow, id })
      await expect(execute(), String(id)).rejects.toMatchObject({
        code: 'ACCOUNT_CLOSURE_STATE_UNAVAILABLE',
      })
    }
    expect(mocks.transition).not.toHaveBeenCalled()
  })

  it('fails closed when releasing a blocked execution claim returns no target row', async () => {
    queueRequested()
    queueClaim()
    mocks.database.execute.mockResolvedValueOnce({ rows: [{ blocked: true }] })
    for (let index = 0; index < 5; index += 1) {
      mocks.database.execute.mockResolvedValueOnce({ rows: [{ blocked: false }] })
    }
    mocks.database.execute.mockResolvedValueOnce({ rows: [{ relation_name: null }] })
    mocks.database.execute.mockResolvedValueOnce({ rows: [] })
    await expect(execute()).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_STATE_UNAVAILABLE' })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('fails closed when final anonymization returns no target row', async () => {
    queueRequested()
    queueClaim()
    queueCleanPreconditions()
    mocks.database.execute.mockResolvedValueOnce({ rows: [] })
    mocks.database.execute.mockResolvedValueOnce({ rows: [] })
    await expect(execute()).rejects.toMatchObject({
      code: 'ACCOUNT_CLOSURE_ANONYMIZATION_CONFLICT',
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
