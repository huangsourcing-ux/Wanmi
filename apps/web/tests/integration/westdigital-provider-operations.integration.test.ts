import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  FixtureWestDigitalWriteTransport,
  retryableBeforeSubmission,
  timeoutAfterSubmission,
} from '@/providers/westdigital-write-fixtures'
import { WestDigitalWriteAdapter, WestDigitalWriteTransportError } from '@/providers/westdigital-write'
import {
  executeWestDigitalWriteOperation,
  generateWestDigitalOperationKey,
  WESTDIGITAL_WRITE_MAX_ATTEMPTS,
  type WestDigitalWriteOperationInput,
} from '@/services/providers/westdigital-operations'

const fixturePrefix = `d6-west-${randomUUID()}`
let payload: Payload

type RegisterInput = Extract<WestDigitalWriteOperationInput, { operation: 'register' }>

function registerInput(suffix: string): RegisterInput {
  return {
    actor: { type: 'system' },
    clientPriceFen: 2_999,
    domainAscii: `${suffix}.com`,
    nameservers: ['ns1.example.com', 'ns2.example.com'],
    operation: 'register',
    premium: false,
    providerTemplateId: '1664777',
    targetId: `${fixturePrefix}-${suffix}`,
    traceId: `${fixturePrefix}-${suffix}`,
    years: 1,
  }
}

function assetResponse(domain: string, clientid = 'fixture-query') {
  return {
    body: {
      clientid,
      data: {
        dns1: 'ns1.example.com',
        dns2: 'ns2.example.com',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain,
        expdate: '2027-08-08 12:00:00',
        id: '44169980',
        regdate: '2026-08-08 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function successResponse(domain: string, clientid = 'fixture-write') {
  return { body: { clientid, data: { [domain]: 200 }, result: 200 }, status: 200 }
}

async function req(suffix: string) {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
}

async function run(
  input: WestDigitalWriteOperationInput,
  transport: FixtureWestDigitalWriteTransport,
) {
  return executeWestDigitalWriteOperation(
    await req(String(input.targetId)),
    input,
    new WestDigitalWriteAdapter({ transport }),
  )
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  const operations = await payload.find({
    collection: 'providerOperations',
    limit: 100,
    overrideAccess: true,
    where: { targetId: { contains: fixturePrefix } },
  })
  for (const operation of operations.docs) {
    await payload.delete({ collection: 'providerOperations', id: operation.id, overrideAccess: true })
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 500,
    overrideAccess: true,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of audits.docs) {
    await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
  }
  await payload.db.destroy?.()
}, 30_000)

describe('D6 WestDigital provider operation safety', () => {
  it('records a successful write, status confirmation, unique key and transaction-coupled audit', async () => {
    const input = registerInput('success')
    const transport = new FixtureWestDigitalWriteTransport((request) =>
      request.operation === 'register'
        ? successResponse(input.domainAscii, 'success-client')
        : assetResponse(input.domainAscii),
    )
    const result = await run(input, transport)
    expect(result).toMatchObject({ data: { attemptCount: 1, status: 'succeeded' }, state: 'ready' })
    expect(transport.writeCount).toBe(1)

    const operations = await payload.find({
      collection: 'providerOperations',
      overrideAccess: true,
      where: { operationKey: { equals: generateWestDigitalOperationKey(input) } },
    })
    expect(operations.totalDocs).toBe(1)
    expect(operations.docs[0]).toMatchObject({
      attemptCount: 1,
      maxAttempts: WESTDIGITAL_WRITE_MAX_ATTEMPTS,
      status: 'succeeded',
      targetId: input.targetId,
      targetType: 'domain',
    })
    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'provider.operation.recorded' } },
          { targetId: { equals: String(operations.docs[0]!.id) } },
        ],
      },
    })
    expect(audits.docs.map((audit) => audit.action)).toEqual([
      'provider.operation.recorded',
      'provider.operation.recorded',
      'provider.operation.recorded',
      'provider.operation.recorded',
    ])
    expect(JSON.stringify(audits.docs)).not.toContain('1664777')
  })

  it('persists an explicit provider rejection as failed without retry', async () => {
    const input = registerInput('explicit-failure')
    const transport = new FixtureWestDigitalWriteTransport(() => ({
      body: { clientid: 'explicit-failure', result: 500 },
      status: 200,
    }))
    const result = await run(input, transport)
    expect(result).toMatchObject({ state: 'error' })
    expect(transport.writeCount).toBe(1)
    const operation = await payload.find({
      collection: 'providerOperations',
      overrideAccess: true,
      where: { operationKey: { equals: generateWestDigitalOperationKey(input) } },
    })
    expect(operation.docs[0]).toMatchObject({ attemptCount: 1, status: 'failed' })
  })

  it('treats a timeout after possible submission as unknown and never retries the write', async () => {
    const input = registerInput('timeout')
    const transport = new FixtureWestDigitalWriteTransport((request) => {
      if (request.operation === 'register') timeoutAfterSubmission()
      throw new WestDigitalWriteTransportError('UNAVAILABLE', 'not_submitted')
    })
    const first = await run(input, transport)
    const replay = await run(input, transport)
    expect(first).toMatchObject({ data: { status: 'unknown' }, state: 'degraded' })
    expect(replay).toMatchObject({ data: { idempotentReplay: true, status: 'unknown' }, state: 'degraded' })
    expect(transport.writeCount).toBe(1)
    expect(transport.requests.filter((request) => request.operation === 'asset_query')).toHaveLength(1)
  })

  it('converges duplicate submissions and duplicate successful responses to one provider write', async () => {
    const input = registerInput('duplicate')
    const transport = new FixtureWestDigitalWriteTransport((request) =>
      request.operation === 'register'
        ? successResponse(input.domainAscii, 'same-provider-client-id')
        : assetResponse(input.domainAscii, 'same-provider-client-id'),
    )
    const first = await run(input, transport)
    const duplicate = await run(input, transport)
    expect(first.state).toBe('ready')
    expect(duplicate).toMatchObject({ data: { idempotentReplay: true }, state: 'ready' })
    expect(transport.writeCount).toBe(1)
    const operations = await payload.find({
      collection: 'providerOperations',
      overrideAccess: true,
      where: { operationKey: { equals: generateWestDigitalOperationKey(input) } },
    })
    expect(operations.totalDocs).toBe(1)
  })

  it('keeps a submitted write unknown when status query is inconclusive and later only queries', async () => {
    const input = registerInput('status-unknown')
    const transport = new FixtureWestDigitalWriteTransport((request) => {
      if (request.operation === 'register') return successResponse(input.domainAscii)
      throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
    })
    const first = await run(input, transport)
    const replay = await run(input, transport)
    expect(first).toMatchObject({ data: { status: 'unknown' }, state: 'degraded' })
    expect(replay).toMatchObject({ data: { idempotentReplay: true, status: 'unknown' }, state: 'degraded' })
    expect(transport.writeCount).toBe(1)
    expect(transport.requests.filter((request) => request.operation === 'asset_query')).toHaveLength(2)
  })

  it('retries only the explicit not-submitted allowlist and stops at the finite limit', async () => {
    const input = registerInput('finite-retry')
    const transport = new FixtureWestDigitalWriteTransport(() => retryableBeforeSubmission())
    const result = await run(input, transport)
    expect(result.state).toBe('error')
    expect(transport.writeCount).toBe(WESTDIGITAL_WRITE_MAX_ATTEMPTS)
    const operation = await payload.find({
      collection: 'providerOperations',
      overrideAccess: true,
      where: { operationKey: { equals: generateWestDigitalOperationKey(input) } },
    })
    expect(operation.docs[0]).toMatchObject({
      attemptCount: WESTDIGITAL_WRITE_MAX_ATTEMPTS,
      status: 'failed',
    })
  })
})
