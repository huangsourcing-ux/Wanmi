import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import {
  commitTransaction,
  createLocalReq,
  getPayload,
  initTransaction,
  type Payload,
} from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { resetEnvForTests } from '@/lib/env'
import {
  authorizeWestDigitalWrite,
  type ProviderWriteBudgetAuthorization,
} from '@/lib/provider-write-guardrails'
import { createWechatPayFixture, SafetyFencedWechatPayProvider } from '@/providers/wechatpay'
import { FixtureWestDigitalWriteTransport } from '@/providers/westdigital-write-fixtures'
import { WestDigitalWriteAdapter } from '@/providers/westdigital-write'
import { consumeProviderWriteBudget } from '@/services/providers/provider-write-budget'
import {
  executeWestDigitalWriteOperation,
  generateWestDigitalOperationKey,
  type WestDigitalWriteOperationInput,
} from '@/services/providers/westdigital-operations'

import { cleanupProviderWriteBudgetFixtures, ignorePayloadNotFound } from '../test-cleanup'

const fixturePrefix = `d7-budget-${randomUUID()}`
const now = new Date('2026-08-10T00:00:00.000Z')
let authorizations: ProviderWriteBudgetAuthorization[] = []
let payload: Payload

type RegisterInput = Extract<WestDigitalWriteOperationInput, { operation: 'register' }>

function registerInput(index: number): RegisterInput {
  return {
    actor: { type: 'system' },
    clientPriceFen: 100,
    domainAscii: `${fixturePrefix}-${index}.com`,
    nameservers: ['ns1.example.com', 'ns2.example.com'],
    operation: 'register',
    premium: false,
    providerTemplateId: '1664777',
    targetId: `${fixturePrefix}-${index}`,
    traceId: `${fixturePrefix}-${index}`,
    years: 1,
  }
}

function assetResponse(domain: string) {
  return {
    body: {
      clientid: `query-${domain}`,
      data: {
        dns1: 'ns1.example.com',
        dns2: 'ns2.example.com',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain,
        expdate: '2027-08-10 12:00:00',
        id: '44169980',
        regdate: '2026-08-10 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function writeResponse(domain: string) {
  return {
    body: { clientid: `write-${domain}`, data: { [domain]: 200 }, result: 200 },
    status: 200,
  }
}

async function request(suffix: string) {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
}

async function budget(scope: string) {
  const found = await payload.find({
    collection: 'providerWriteBudgets',
    limit: 1,
    overrideAccess: true,
    where: { scopeKey: { equals: scope } },
  })
  return found.docs[0]
}

function enableWestDigital(
  inputs: readonly RegisterInput[],
  operationLimit: number,
  cumulativeAmountLimitFen = 10_000,
): void {
  vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
  vi.stubEnv('ALLOW_REAL_WESTDIGITAL', 'true')
  vi.stubEnv('ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES', 'true')
  vi.stubEnv('CI', 'false')
  vi.stubEnv(
    'WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST',
    inputs.map(({ domainAscii }) => domainAscii).join(','),
  )
  vi.stubEnv('WESTDIGITAL_WRITE_MAX_REGISTER_RENEW_OPERATIONS', String(operationLimit))
  vi.stubEnv('WESTDIGITAL_WRITE_SINGLE_AMOUNT_LIMIT_FEN', '100')
  vi.stubEnv('WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN', String(cumulativeAmountLimitFen))
  resetEnvForTests()
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterEach(async () => {
  await cleanupProviderWriteBudgetFixtures(payload, authorizations)
  authorizations = []
  vi.unstubAllEnvs()
  resetEnvForTests()
})

afterAll(async () => {
  const operations = await payload.find({
    collection: 'providerOperations',
    limit: 100,
    overrideAccess: true,
    where: { targetId: { contains: fixturePrefix } },
  })
  for (const operation of operations.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'providerOperations', id: operation.id, overrideAccess: true }),
    )
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 500,
    overrideAccess: true,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of audits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  await payload.db.destroy?.()
}, 90_000)

describe('D7 persistent provider write budgets', () => {
  it('atomically allows only the configured West Digital count under Promise.all concurrency', async () => {
    const inputs = Array.from({ length: 8 }, (_, index) => registerInput(index))
    enableWestDigital(inputs, 3)
    authorizations = inputs.map((input) => {
      const authorization = authorizeWestDigitalWrite(input, generateWestDigitalOperationKey(input))
      if (!authorization) throw new Error('Expected a live West Digital budget authorization')
      return authorization
    })
    const transport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'register'
        ? writeResponse(input.body.domain!)
        : assetResponse(input.body.domain!),
    )
    const provider = new WestDigitalWriteAdapter({ transport })

    const results = await Promise.all(
      inputs.map(async (input) =>
        executeWestDigitalWriteOperation(await request(String(input.targetId)), input, provider),
      ),
    )

    expect(results.filter(({ state }) => state === 'ready')).toHaveLength(3)
    expect(
      results.filter(
        (result) =>
          result.state === 'degraded' &&
          result.problem?.code === 'WESTDIGITAL_WRITE_OPERATION_LIMIT_EXCEEDED',
      ),
    ).toHaveLength(5)
    expect(transport.writeCount).toBe(3)
    await expect(budget('westdigital:register_renew')).resolves.toMatchObject({
      usedAmountFen: 300,
      usedOperations: 3,
    })
  })

  it('persists operation-key idempotency across independent requests and concurrent retries', async () => {
    const input = registerInput(100)
    enableWestDigital([input], 5)
    const authorization = authorizeWestDigitalWrite(input, generateWestDigitalOperationKey(input))
    if (!authorization) throw new Error('Expected a live West Digital budget authorization')
    authorizations = [authorization]

    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        consumeProviderWriteBudget(await request(`idempotency-${index}`), authorization),
      ),
    )

    expect(results.filter(({ debited }) => debited)).toHaveLength(1)
    await expect(budget('westdigital:register_renew')).resolves.toMatchObject({
      usedAmountFen: 100,
      usedOperations: 1,
    })
  })

  it('removes a rejected debit when the caller owns the surrounding transaction', async () => {
    const first = registerInput(110)
    const rejected = registerInput(111)
    enableWestDigital([first, rejected], 1)
    const firstAuthorization = authorizeWestDigitalWrite(
      first,
      generateWestDigitalOperationKey(first),
    )
    const rejectedAuthorization = authorizeWestDigitalWrite(
      rejected,
      generateWestDigitalOperationKey(rejected),
    )
    if (!firstAuthorization || !rejectedAuthorization) {
      throw new Error('Expected live West Digital budget authorizations')
    }
    authorizations = [firstAuthorization, rejectedAuthorization]
    await consumeProviderWriteBudget(await request('nested-first'), firstAuthorization)

    const outerReq = await request('nested-rejected')
    await initTransaction(outerReq)
    await expect(consumeProviderWriteBudget(outerReq, rejectedAuthorization)).rejects.toMatchObject(
      {
        code: 'WESTDIGITAL_WRITE_OPERATION_LIMIT_EXCEEDED',
      },
    )
    await commitTransaction(outerReq)

    await expect(
      consumeProviderWriteBudget(await request('nested-retry'), {
        ...rejectedAuthorization,
        operationLimit: 2,
      }),
    ).resolves.toEqual({ debited: true })
    await expect(budget('westdigital:register_renew')).resolves.toMatchObject({
      usedAmountFen: 200,
      usedOperations: 2,
    })
  })

  it('atomically enforces the independent West Digital cumulative amount ceiling', async () => {
    const inputs = Array.from({ length: 4 }, (_, index) => registerInput(index + 20))
    enableWestDigital(inputs, 8, 250)
    authorizations = inputs.map((input) => {
      const authorization = authorizeWestDigitalWrite(input, generateWestDigitalOperationKey(input))
      if (!authorization) throw new Error('Expected a live West Digital budget authorization')
      return authorization
    })
    const transport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'register'
        ? writeResponse(input.body.domain!)
        : assetResponse(input.body.domain!),
    )
    const provider = new WestDigitalWriteAdapter({ transport })

    const results = await Promise.all(
      inputs.map(async (input) =>
        executeWestDigitalWriteOperation(await request(String(input.targetId)), input, provider),
      ),
    )

    expect(results.filter(({ state }) => state === 'ready')).toHaveLength(2)
    expect(
      results.filter(
        (result) =>
          result.state === 'degraded' &&
          result.problem?.code === 'WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED',
      ),
    ).toHaveLength(2)
    expect(transport.writeCount).toBe(2)
    await expect(budget('westdigital:register_renew')).resolves.toMatchObject({
      usedAmountFen: 200,
      usedOperations: 2,
    })
  })

  it('keeps Wechat Pay payment and refund cumulative budgets independent and persistent', async () => {
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY_PAYMENTS', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY_REFUNDS', 'true')
    vi.stubEnv('CI', 'false')
    vi.stubEnv('WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN', '500')
    vi.stubEnv('WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN', '500')
    resetEnvForTests()
    const fixture = createWechatPayFixture({ now: () => now })
    const createPayment = vi.spyOn(fixture.provider, 'createPayment')
    const createRefund = vi.spyOn(fixture.provider, 'createRefund')
    const provider = new SafetyFencedWechatPayProvider(fixture.provider, async (authorization) => {
      authorizations.push(authorization)
      return consumeProviderWriteBudget(await request(authorization.operationKey), authorization)
    })

    const payments = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        provider.createPayment({
          amountMinor: 200,
          channel: 'native',
          description: 'persistent budget integration fixture',
          expiresAt: '2026-08-10T00:04:00.000Z',
          merchantOrderNumber: `WMBUDGET${index}`,
          traceId: `${fixturePrefix}-wechat-payment-${index}`,
        }),
      ),
    )
    expect(payments.filter(({ ok }) => ok)).toHaveLength(2)
    expect(
      payments.filter(
        (result) =>
          !result.ok && result.error.code === 'WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED',
      ),
    ).toHaveLength(2)
    expect(createPayment).toHaveBeenCalledTimes(2)

    await expect(
      provider.createRefund({
        amountMinor: 400,
        merchantOrderNumber: 'WMBUDGETREFUND',
        reason: 'persistent budget integration fixture',
        refundNumber: 'WRBUDGETREFUND',
        traceId: `${fixturePrefix}-wechat-refund`,
      }),
    ).resolves.toMatchObject({ ok: true })
    expect(createRefund).toHaveBeenCalledTimes(1)
    await expect(budget('wechatpay:payment')).resolves.toMatchObject({ usedAmountFen: 400 })
    await expect(budget('wechatpay:refund')).resolves.toMatchObject({ usedAmountFen: 400 })
  })
})
