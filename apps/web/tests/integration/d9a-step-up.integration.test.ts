import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hmac } from '@/lib/crypto'
import { ONE_TIME_STEP_UP_PURPOSES, STEP_UP_PURPOSES, type StepUpPurpose } from '@/lib/domain'
import { getEnv } from '@/lib/env'
import type { Customer } from '@/payload-types'
import { CAPTCHA_FIXTURE_TOKEN } from '@/providers/aliyuncaptcha'
import { mockFailure, mockSuccess } from '@/providers/mock'
import type { SmsProvider } from '@/providers/types'
import { clientHashes, maskPhone } from '@/services/auth/client-facts'
import { verifyOtp } from '@/services/auth/otp'
import {
  authorizeStepUpGrant,
  isOneTimeStepUpPurpose,
  requestStepUpOtp,
  verifyStepUpOtp,
} from '@/services/auth/step-up'

let payload: Payload

function phone(): string {
  return `+86198${randomInt(10_000_000, 100_000_000)}`
}

function headers(suffix = randomUUID()): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9A-Step-Up/${suffix}`,
    'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
    'x-request-id': `d9a-step-up-${suffix}`,
  })
}

async function request(requestHeaders: Headers, customer?: Customer): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: requestHeaders } }, payload)
  if (customer) req.user = { ...customer, collection: 'customers' }
  return req
}

async function createCustomer(): Promise<Customer> {
  const customerPhone = phone()
  return payload.create({
    collection: 'customers',
    data: {
      phone: customerPhone,
      phoneMasked: maskPhone(customerPhone),
      status: 'active',
    },
    overrideAccess: true,
  })
}

async function issueGrant(
  purpose: StepUpPurpose,
  input: { customer?: Customer; deviceId?: string; requestHeaders?: Headers } = {},
) {
  const customer = input.customer ?? (await createCustomer())
  const deviceId = input.deviceId ?? `step-up-device-${randomUUID()}`
  const requestHeaders = input.requestHeaders ?? headers()
  const challenge = await requestStepUpOtp(
    await request(requestHeaders, customer),
    customer,
    {
      captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
      deviceId,
      purpose,
    },
    requestHeaders,
    `step-up-request-${randomUUID()}`,
  )
  const verified = await verifyStepUpOtp(
    await request(requestHeaders, customer),
    customer,
    {
      challengeId: challenge.challengeId,
      code: getEnv().MOCK_SMS_OTP_CODE,
      deviceId,
      purpose,
    },
    requestHeaders,
  )
  return { customer, deviceId, requestHeaders, ...verified }
}

async function waitForBlockedGrantUpdates(
  client: { query: (statement: string) => Promise<{ rows: Array<{ count?: number }> }> },
  expected: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%update%step_up_grants%'`,
    )
    if ((result.rows[0]?.count ?? 0) >= expected) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function deliveredSmsProvider() {
  const sendOtp = vi.fn(async () => mockFailure('WRONG_LOGIN_TEMPLATE'))
  const sendStepUpOtp = vi.fn(async ({ traceId }: { traceId: string }) =>
    mockSuccess(
      {
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: `mock-step-up-${traceId}`,
      },
      `mock-step-up-request-${traceId}`,
    ),
  )
  const provider: SmsProvider = {
    health: async () => mockSuccess({ healthy: true }),
    queryReceipt: async () => mockSuccess({ status: 'delivered' as const }),
    sendDomainExpiry: async () => mockFailure('NOT_USED'),
    sendOtp,
    sendStepUpOtp,
  }
  return { provider, sendOtp, sendStepUpOtp }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-A A4 SMS step-up grants', () => {
  it('enumerates every risk-table purpose and limits one-time grants to the two exceptions', () => {
    expect(STEP_UP_PURPOSES).toEqual([
      'dns_record_change',
      'nameserver_change',
      'mx_record_change',
      'dns_bulk_delete',
      'domain_lock_change',
      'realname_change',
      'domain_management_password',
      'balance_spend',
      'account_deletion',
    ])
    expect(ONE_TIME_STEP_UP_PURPOSES).toEqual(['realname_change', 'account_deletion'])
    expect(STEP_UP_PURPOSES.filter(isOneTimeStepUpPurpose)).toEqual(ONE_TIME_STEP_UP_PURPOSES)
  })

  it('uses the dedicated step-up SMS template and stores only an HMAC grant for ten minutes', async () => {
    const customer = await createCustomer()
    const deviceId = `step-up-template-${randomUUID()}`
    const requestHeaders = headers()
    const { provider, sendOtp, sendStepUpOtp } = deliveredSmsProvider()
    const challenge = await requestStepUpOtp(
      await request(requestHeaders, customer),
      customer,
      {
        captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
        deviceId,
        purpose: 'dns_record_change',
      },
      requestHeaders,
      `step-up-template-${randomUUID()}`,
      { smsProvider: provider },
    )
    expect(sendStepUpOtp).toHaveBeenCalledOnce()
    expect(sendOtp).not.toHaveBeenCalled()

    await expect(
      verifyOtp(
        await request(requestHeaders, customer),
        {
          challengeId: challenge.challengeId,
          code: getEnv().MOCK_SMS_OTP_CODE,
          deviceId,
        },
        requestHeaders,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CHALLENGE' })

    const startedAt = Date.now()
    const grant = await verifyStepUpOtp(
      await request(requestHeaders, customer),
      customer,
      {
        challengeId: challenge.challengeId,
        code: getEnv().MOCK_SMS_OTP_CODE,
        deviceId,
        purpose: 'dns_record_change',
      },
      requestHeaders,
    )
    const rows = await payload.find({
      collection: 'stepUpGrants',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: customer.id } }, { purpose: { equals: 'dns_record_change' } }],
      },
    })
    expect(rows.docs).toHaveLength(1)
    const row = rows.docs[0]!
    const expectedHashes = clientHashes(requestHeaders, deviceId)
    expect(row).toMatchObject({
      consumedAt: null,
      customer: customer.id,
      deviceHash: expectedHashes.deviceHash,
      ipHash: expectedHashes.ipHash,
      purpose: 'dns_record_change',
      tokenHash: hmac(grant.stepUpToken, getEnv().SESSION_PEPPER),
    })
    expect(JSON.stringify(row)).not.toContain(grant.stepUpToken)
    expect(new Date(grant.expiresAt).getTime() - startedAt).toBeGreaterThanOrEqual(
      getEnv().STEP_UP_GRANT_TTL_SECONDS * 1_000 - 1_000,
    )
    expect(new Date(grant.expiresAt).getTime() - startedAt).toBeLessThanOrEqual(
      getEnv().STEP_UP_GRANT_TTL_SECONDS * 1_000 + 1_000,
    )
  })

  it('does not let a grant for one purpose authorize a different purpose', async () => {
    const grant = await issueGrant('dns_record_change')
    const matching = await authorizeStepUpGrant(
      await request(grant.requestHeaders, grant.customer),
      {
        customerId: grant.customer.id,
        deviceId: grant.deviceId,
        headers: grant.requestHeaders,
        purpose: 'dns_record_change',
        stepUpToken: grant.stepUpToken,
      },
    )
    expect(matching).toMatchObject({ oneTime: false, purpose: 'dns_record_change' })
    await expect(
      authorizeStepUpGrant(await request(grant.requestHeaders, grant.customer), {
        customerId: grant.customer.id,
        deviceId: grant.deviceId,
        headers: grant.requestHeaders,
        purpose: 'balance_spend',
        stepUpToken: grant.stepUpToken,
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
  })

  it('reuses a default-purpose grant within its TTL', async () => {
    const grant = await issueGrant('nameserver_change')
    const authorize = async () =>
      authorizeStepUpGrant(await request(grant.requestHeaders, grant.customer), {
        customerId: grant.customer.id,
        deviceId: grant.deviceId,
        headers: grant.requestHeaders,
        purpose: 'nameserver_change',
        stepUpToken: grant.stepUpToken,
      })
    await expect(authorize()).resolves.toMatchObject({ oneTime: false })
    await expect(authorize()).resolves.toMatchObject({ oneTime: false })
    const rows = await payload.find({
      collection: 'stepUpGrants',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: grant.customer.id } },
          { purpose: { equals: 'nameserver_change' } },
        ],
      },
    })
    expect(rows.docs).toHaveLength(1)
    expect(rows.docs[0]?.consumedAt).toBeNull()
  })

  it.each(['account_deletion', 'realname_change'] as const)(
    'consumes a fresh %s grant exactly once',
    async (purpose) => {
      const grant = await issueGrant(purpose)
      const authorize = async () =>
        authorizeStepUpGrant(await request(grant.requestHeaders, grant.customer), {
          customerId: grant.customer.id,
          deviceId: grant.deviceId,
          headers: grant.requestHeaders,
          purpose,
          stepUpToken: grant.stepUpToken,
        })
      await expect(authorize()).resolves.toMatchObject({ oneTime: true, purpose })
      await expect(authorize()).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
      const rows = await payload.find({
        collection: 'stepUpGrants',
        depth: 0,
        limit: 2,
        overrideAccess: true,
        where: {
          and: [{ customer: { equals: grant.customer.id } }, { purpose: { equals: purpose } }],
        },
      })
      expect(rows.docs).toHaveLength(1)
      expect(rows.docs[0]?.consumedAt).toBeTruthy()
    },
  )

  it('atomically lets exactly one concurrent consumer use a one-time grant', async () => {
    const grant = await issueGrant('account_deletion')
    const consumers = 8
    if (!payload.db.pg) throw new Error('PostgreSQL driver is unavailable')
    const blockerPool = new payload.db.pg.Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 1,
    })
    const blocker = await blockerPool.connect()
    let released = false
    let blocked = false
    let pending: Array<ReturnType<typeof authorizeStepUpGrant>> = []
    try {
      await blocker.query('BEGIN')
      const locked = await blocker.query(
        'SELECT id FROM step_up_grants WHERE token_hash = $1 FOR UPDATE',
        [hmac(grant.stepUpToken, getEnv().SESSION_PEPPER)],
      )
      expect(locked.rowCount).toBe(1)
      const requests = await Promise.all(
        Array.from({ length: consumers }, () => request(grant.requestHeaders, grant.customer)),
      )
      pending = requests.map((consumerRequest) =>
        authorizeStepUpGrant(consumerRequest, {
          customerId: grant.customer.id,
          deviceId: grant.deviceId,
          headers: grant.requestHeaders,
          purpose: 'account_deletion',
          stepUpToken: grant.stepUpToken,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      blocked = await waitForBlockedGrantUpdates(blocker, 2)
      await blocker.query('COMMIT')
      released = true
    } finally {
      if (!released) await blocker.query('ROLLBACK')
      blocker.release()
      await blockerPool.end()
    }
    const results = await Promise.allSettled(pending)
    expect(blocked).toBe(true)
    const successes = results.filter((result) => result.status === 'fulfilled')
    const failures = results.filter((result) => result.status === 'rejected')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(consumers - 1)
    expect(
      failures.every(
        (failure) =>
          failure.status === 'rejected' &&
          (failure.reason as { code?: unknown }).code === 'STEP_UP_GRANT_INVALID',
      ),
    ).toBe(true)
    const rows = await payload.find({
      collection: 'stepUpGrants',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: grant.customer.id } },
          { purpose: { equals: 'account_deletion' } },
          { tokenHash: { equals: hmac(grant.stepUpToken, getEnv().SESSION_PEPPER) } },
        ],
      },
    })
    expect(rows.docs).toHaveLength(1)
    expect(rows.docs[0]?.consumedAt).toBeTruthy()
  })

  it('blocks every high-risk purpose during the identity-risk cooldown even with a valid grant', async () => {
    const grant = await issueGrant('domain_lock_change')
    await payload.update({
      collection: 'customers',
      data: { identityRiskCooldownStartedAt: new Date().toISOString() },
      id: grant.customer.id,
      overrideAccess: true,
    })
    await expect(
      authorizeStepUpGrant(await request(grant.requestHeaders, grant.customer), {
        customerId: grant.customer.id,
        deviceId: grant.deviceId,
        headers: grant.requestHeaders,
        purpose: 'domain_lock_change',
        stepUpToken: grant.stepUpToken,
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE' })
    const rows = await payload.find({
      collection: 'stepUpGrants',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: grant.customer.id } },
          { purpose: { equals: 'domain_lock_change' } },
        ],
      },
    })
    expect(rows.docs).toHaveLength(1)
    expect(rows.docs[0]?.consumedAt).toBeNull()
  })

  it('rate-limits repeated step-up SMS requests through the shared SMS buckets', async () => {
    const customer = await createCustomer()
    const deviceId = `step-up-rate-${randomUUID()}`
    const requestHeaders = headers()
    for (let index = 0; index < getEnv().OTP_PHONE_LIMIT_PER_HOUR; index += 1) {
      await expect(
        requestStepUpOtp(
          await request(requestHeaders, customer),
          customer,
          {
            captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
            deviceId,
            purpose: 'balance_spend',
          },
          requestHeaders,
          `step-up-rate-${index}-${randomUUID()}`,
        ),
      ).resolves.toMatchObject({ accepted: true })
    }
    await expect(
      requestStepUpOtp(
        await request(requestHeaders, customer),
        customer,
        {
          captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
          deviceId,
          purpose: 'balance_spend',
        },
        requestHeaders,
        `step-up-rate-rejected-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' })
    expect(
      await payload.count({
        collection: 'smsChallenges',
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: customer.id } },
            { purpose: { equals: 'step_up' } },
            { stepUpPurpose: { equals: 'balance_spend' } },
          ],
        },
      }),
    ).toMatchObject({ totalDocs: getEnv().OTP_PHONE_LIMIT_PER_HOUR })
  })
})
