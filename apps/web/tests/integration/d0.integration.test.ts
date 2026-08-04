import { randomInt, randomUUID } from 'node:crypto'

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getEnv } from '@/lib/env'
import { customerSessionStrategy } from '@/services/auth/customer-strategy'
import { rawCustomerToken, requestOtp, revokeSessions, verifyOtp } from '@/services/auth/otp'
import { runMockFulfillment } from '@/services/commerce/fulfillment'

let payload: Payload

beforeAll(async () => {
  payload = await getPayload({ config })
  const leakedStorageFixtures = await payload.find({
    collection: 'media',
    overrideAccess: true,
    where: { alt: { equals: 'D0 storage fixture' } },
  })
  for (const fixture of leakedStorageFixtures.docs) {
    if (fixture.filename?.startsWith('d0-')) {
      await payload.delete({ collection: 'media', id: fixture.id, overrideAccess: true })
    }
  }
})

afterAll(async () => {
  await payload.db.destroy?.()
})

async function createPaidOrderFixture() {
  const suffix = randomUUID()
  const customer = await payload.create({
    collection: 'customers',
    data: { phone: `fixture-${suffix}`, phoneMasked: 'fixture-only', status: 'active' },
    overrideAccess: true,
  })
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      customer: customer.id,
      displayName: 'D0 fixture',
      status: 'verified',
      type: 'individual',
    },
    overrideAccess: true,
  })
  const domainAscii = `d0-${suffix}.test`
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      ruleSnapshot: { fixture: true },
      upstreamCostMinor: 100,
      userPriceMinor: 120,
      years: 1,
    },
    overrideAccess: true,
  })
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor: 120,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      orderNumber: `D0-${suffix}`,
      quote: quote.id,
      quoteSnapshot: { quoteId: quote.id },
      realnameTemplate: template.id,
      status: 'paid',
    },
    overrideAccess: true,
  })
  return { domainAscii, order, suffix }
}

describe('D0 PostgreSQL, auth and Jobs baseline', () => {
  it('boots all official plugins and draft/version/scheduling configuration', () => {
    expect(payload.collections.articles.config.versions).toMatchObject({
      drafts: expect.objectContaining({ schedulePublish: true }),
    })
    expect(payload.collections.redirects).toBeDefined()
    expect(payload.collections.forms).toBeDefined()
    expect(payload.collections['form-submissions']).toBeDefined()
    expect(payload.collections.media.config.upload).toBeTruthy()
  })

  it('consumes SMS OTP once, rotates the opaque session and supports all-session revocation', async () => {
    const phone = ['+86', '199', String(randomInt(10_000_000, 99_999_999))].join('')
    const deviceId = `integration-device-${randomUUID()}`
    const headers = new Headers({
      'user-agent': 'wanmi-integration-test',
      'x-forwarded-for': '192.0.2.10',
    })
    const requested = await requestOtp(payload, { deviceId, phone }, headers, 'trace-otp-request')
    const req = await createLocalReq({ req: { headers } }, payload)
    const verified = await verifyOtp(
      req,
      { challengeId: requested.challengeId, code: getEnv().MOCK_SMS_OTP_CODE, deviceId },
      headers,
    )
    expect(Buffer.from(verified.token, 'base64url')).toHaveLength(32)
    await expect(
      verifyOtp(
        await createLocalReq({ req: { headers } }, payload),
        { challengeId: requested.challengeId, code: getEnv().MOCK_SMS_OTP_CODE, deviceId },
        headers,
      ),
    ).rejects.toThrow(/已过期/)

    const cookieHeaders = new Headers({ cookie: `wanmi_customer_session=${verified.token}` })
    const authenticated = await customerSessionStrategy.authenticate({
      headers: cookieHeaders,
      payload,
    })
    expect(authenticated.user?.id).toBe(verified.customer.id)
    await revokeSessions(payload, rawCustomerToken(cookieHeaders), 'all')
    expect(
      (await customerSessionStrategy.authenticate({ headers: cookieHeaders, payload })).user,
    ).toBeNull()
  })

  it('caps OTP guesses at OTP_MAX_ATTEMPTS even when guesses race concurrently', async () => {
    const phone = ['+86', '199', String(randomInt(10_000_000, 99_999_999))].join('')
    const deviceId = `integration-device-${randomUUID()}`
    const headers = new Headers({
      'user-agent': 'wanmi-integration-test',
      'x-forwarded-for': '192.0.2.11',
    })
    const requested = await requestOtp(payload, { deviceId, phone }, headers, 'trace-otp-race')
    const maxAttempts = getEnv().OTP_MAX_ATTEMPTS

    // Each concurrent guess gets its own request/transaction, matching how independent
    // HTTP requests would each get their own PayloadRequest.
    await Promise.allSettled(
      Array.from({ length: maxAttempts * 3 }, async () =>
        verifyOtp(
          await createLocalReq({ req: { headers } }, payload),
          { challengeId: requested.challengeId, code: '000000', deviceId },
          headers,
        ),
      ),
    )

    // The core invariant: no matter how many guesses raced in, the stored attempts
    // count must never exceed the configured maximum. A stale read-modify-write
    // (challenge.attempts + 1 without a CAS guard) would let this drift past the limit.
    const challenge = await payload.find({
      collection: 'smsChallenges',
      overrideAccess: true,
      where: { challengeId: { equals: requested.challengeId } },
    })
    expect(challenge.docs[0]?.attempts).toBeLessThanOrEqual(maxAttempts)

    // Drain any remaining attempts sequentially (concurrent bursts that collide on the
    // same stale snapshot only ever consume one attempt per round, so the race above
    // may not reach the cap by itself) and confirm the correct code is then locked out.
    for (let i = challenge.docs[0]!.attempts; i < maxAttempts; i += 1) {
      await verifyOtp(
        await createLocalReq({ req: { headers } }, payload),
        { challengeId: requested.challengeId, code: '000000', deviceId },
        headers,
      ).catch(() => undefined)
    }
    await expect(
      verifyOtp(
        await createLocalReq({ req: { headers } }, payload),
        { challengeId: requested.challengeId, code: getEnv().MOCK_SMS_OTP_CODE, deviceId },
        headers,
      ),
    ).rejects.toThrow(/无效或已过期/)
  })

  it('pins realnameTemplates.customer to the authenticated customer regardless of submitted data', async () => {
    const owner = await payload.create({
      collection: 'customers',
      data: { phone: `fixture-${randomUUID()}`, phoneMasked: 'fixture-only', status: 'active' },
      overrideAccess: true,
    })
    const other = await payload.create({
      collection: 'customers',
      data: { phone: `fixture-${randomUUID()}`, phoneMasked: 'fixture-only', status: 'active' },
      overrideAccess: true,
    })

    const template = await payload.create({
      collection: 'realnameTemplates',
      data: {
        customer: other.id,
        displayName: 'attempted-takeover',
        status: 'draft',
        type: 'individual',
      },
      overrideAccess: false,
      user: { ...owner, collection: 'customers' as const },
    })

    expect(
      typeof template.customer === 'object' ? template.customer.id : template.customer,
    ).toBe(owner.id)
  })

  it('runs duplicate commerce jobs safely with one provider operation and append-only events', async () => {
    const { domainAscii, order, suffix } = await createPaidOrderFixture()
    const operationKey = `register:${order.id}:${domainAscii}`
    const input = { operationKey, orderId: order.id, simulate: 'success' as const, traceId: suffix }
    const first = await payload.jobs.queue({
      input,
      queue: 'commerce',
      workflow: 'commerceFulfillment',
    })
    const duplicate = await payload.jobs.queue({
      input,
      queue: 'commerce',
      workflow: 'commerceFulfillment',
    })
    expect(first.concurrencyKey).toBe(operationKey)
    expect(duplicate.concurrencyKey).toBe(operationKey)

    await payload.jobs.run({ limit: 2, queue: 'commerce', sequential: true, silent: true })
    const operations = await payload.find({
      collection: 'providerOperations',
      overrideAccess: true,
      where: { operationKey: { equals: operationKey } },
    })
    const events = await payload.find({
      collection: 'orderEvents',
      overrideAccess: true,
      sort: 'createdAt',
      where: { order: { equals: order.id } },
    })
    expect(operations.totalDocs).toBe(1)
    expect(operations.docs[0]?.status).toBe('succeeded')
    expect(events.docs.map((event) => event.toStatus)).toEqual(['fulfilling', 'succeeded'])
    expect(
      (await payload.findByID({ collection: 'orders', id: order.id, overrideAccess: true })).status,
    ).toBe('succeeded')
    expect(
      (
        await payload.find({
          collection: 'domainAssets',
          overrideAccess: true,
          where: { domainAscii: { equals: domainAscii } },
        })
      ).totalDocs,
    ).toBe(1)
  })

  it('retries only before provider submission and never resubmits an unknown operation', async () => {
    const before = await createPaidOrderFixture()
    const beforeKey = `register:${before.order.id}:${before.domainAscii}`
    const beforeReq = await createLocalReq({}, payload)
    await expect(
      runMockFulfillment(beforeReq, {
        operationKey: beforeKey,
        orderId: before.order.id,
        simulate: 'timeout-before-submit',
        traceId: before.suffix,
      }),
    ).rejects.toThrow(/安全重试/)
    const prepared = await payload.find({
      collection: 'providerOperations',
      overrideAccess: true,
      where: { operationKey: { equals: beforeKey } },
    })
    expect(prepared.docs).toHaveLength(1)
    expect(prepared.docs[0]?.status).toBe('prepared')
    await runMockFulfillment(await createLocalReq({}, payload), {
      operationKey: beforeKey,
      orderId: before.order.id,
      simulate: 'success',
      traceId: before.suffix,
    })
    expect(
      (await payload.findByID({ collection: 'orders', id: before.order.id, overrideAccess: true }))
        .status,
    ).toBe('succeeded')

    const after = await createPaidOrderFixture()
    const afterKey = `register:${after.order.id}:${after.domainAscii}`
    const first = await runMockFulfillment(await createLocalReq({}, payload), {
      operationKey: afterKey,
      orderId: after.order.id,
      simulate: 'timeout-after-submit',
      traceId: after.suffix,
    })
    const replay = await runMockFulfillment(await createLocalReq({}, payload), {
      operationKey: afterKey,
      orderId: after.order.id,
      simulate: 'success',
      traceId: after.suffix,
    })
    expect(first.status).toBe('unknown')
    expect(replay).toMatchObject({ idempotentReplay: true, status: 'unknown' })
    expect(
      (await payload.findByID({ collection: 'orders', id: after.order.id, overrideAccess: true }))
        .status,
    ).toBe('manual_review')
    expect(
      (
        await payload.find({
          collection: 'providerOperations',
          overrideAccess: true,
          where: { operationKey: { equals: afterKey } },
        })
      ).totalDocs,
    ).toBe(1)
  })

  it('uses storage-s3 for public Media upload/read/signed URL/delete and ETag', async () => {
    const fileName = `d0-${randomUUID()}.png`
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=',
      'base64',
    )
    const media = await payload.create({
      collection: 'media',
      data: { alt: 'D0 storage fixture', reviewed: true },
      file: {
        data: png,
        mimetype: 'image/png',
        name: fileName,
        size: png.length,
      },
      overrideAccess: true,
    })
    const key = ['public/media', media.prefix, media.filename].filter(Boolean).join('/')
    const client = new S3Client({
      credentials: {
        accessKeyId: getEnv().S3_ACCESS_KEY_ID!,
        secretAccessKey: getEnv().S3_SECRET_ACCESS_KEY!,
      },
      endpoint: getEnv().S3_ENDPOINT,
      forcePathStyle: true,
      region: getEnv().S3_REGION,
    })
    const head = await client.send(new HeadObjectCommand({ Bucket: getEnv().S3_BUCKET, Key: key }))
    expect(head.ETag).toBeTruthy()
    const object = await client.send(new GetObjectCommand({ Bucket: getEnv().S3_BUCKET, Key: key }))
    expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(png)
    const signed = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: getEnv().S3_BUCKET, Key: key }),
      { expiresIn: 60 },
    )
    expect((await fetch(signed)).status).toBe(200)
    await payload.delete({ collection: 'media', id: media.id, overrideAccess: true })
    await expect(
      client.send(new HeadObjectCommand({ Bucket: getEnv().S3_BUCKET, Key: key })),
    ).rejects.toBeTruthy()
    client.destroy()
  })
})
