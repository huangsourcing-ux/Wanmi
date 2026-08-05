import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FixtureWestDigitalTransport,
  WESTDIGITAL_AVAILABILITY_FIXTURE,
  WESTDIGITAL_PRICE_FIXTURE,
  type WestDigitalFixtureHandler,
} from '@/providers/westdigital-fixtures'
import {
  MockWestDigitalProvider,
  WestDigitalReadAdapter,
  type WestDigitalLogger,
  type WestDigitalReadConfig,
  type WestDigitalTransportRequest,
  type WestDigitalTransportResponse,
} from '@/providers/westdigital'

const baseConfig: WestDigitalReadConfig = {
  availabilityCacheMaxEntries: 5_000,
  availabilityCacheTtlMs: 45_000,
  burst: 100,
  priceCacheMaxEntries: 512,
  priceCacheTtlMs: 3_600_000,
  queueCapacity: 32,
  queueWaitMs: 5_000,
  ratePerSecond: 1_000,
  transportTimeoutMs: 5_000,
}

const noopLogger: WestDigitalLogger = {
  info() {},
  warn() {},
}

function availabilityResponse(
  request: WestDigitalTransportRequest,
  overrides: Partial<{
    avail: 0 | 1
    name: string
    price: number
    type: 'premium'
  }> = {},
): WestDigitalTransportResponse {
  return {
    body: {
      clientid: 'fixture-availability-request',
      data: [
        {
          avail: overrides.avail ?? 1,
          name: overrides.name ?? `${request.body.domain}${request.body.suffix}`,
          ...(overrides.price === undefined ? {} : { price: overrides.price }),
          ...(overrides.type === undefined ? {} : { type: overrides.type }),
        },
      ],
      result: 200,
    },
    status: 200,
  }
}

function priceResponse(
  request: WestDigitalTransportRequest,
  overrides: Partial<{
    buyprice: number
    buyyear: string
    proid: string
    renewprice: number
  }> = {},
): WestDigitalTransportResponse {
  return {
    body: {
      clientid: 'fixture-price-request',
      data: {
        buyprice: overrides.buyprice ?? 29,
        buyyear: overrides.buyyear ?? request.body.year,
        proid: overrides.proid ?? 'domcn',
        renewprice: overrides.renewprice ?? 35,
      },
      result: 200,
    },
    status: 200,
  }
}

function createProvider(
  handler?: WestDigitalFixtureHandler,
  options: {
    config?: Partial<WestDigitalReadConfig>
    logger?: WestDigitalLogger
    now?: () => number
  } = {},
) {
  const transport = new FixtureWestDigitalTransport(handler)
  const provider = new WestDigitalReadAdapter({
    config: { ...baseConfig, ...options.config },
    logger: options.logger ?? noopLogger,
    now: options.now,
    requestIdFactory: (() => {
      let sequence = 0
      return () => `westdigital-test-${++sequence}`
    })(),
    transport,
  })
  return { provider, transport }
}

function expectFailure(
  result: Awaited<ReturnType<WestDigitalReadAdapter['queryAvailability']>>,
  code: string,
  message: string,
  retryable: boolean,
): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected provider failure')
  expect(result.error).toMatchObject({ code, message, retryable })
  expect(result.requestId).toMatch(/^westdigital-test-/u)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('D2-02 West Digital read adapter', () => {
  it('maps the downloaded v2 query and price fixtures without making network requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const { provider, transport } = createProvider()

    const availability = await provider.queryAvailability({
      domain: 'CEO.TOP',
      traceId: 'trace-westdigital-fixture-availability',
    })
    expect(availability).toMatchObject({
      cache: { status: 'miss' },
      data: {
        available: true,
        currency: 'CNY',
        domainAscii: 'ceo.top',
        premium: true,
        premiumRegistrationPriceFen: 318_100,
      },
      ok: true,
    })

    const price = await provider.queryPrice({
      domain: 'WEST.CN',
      traceId: 'trace-westdigital-fixture-price',
      years: 1,
    })
    expect(price).toMatchObject({
      cache: { status: 'miss' },
      data: {
        currency: 'CNY',
        domainAscii: 'west.cn',
        productId: 'domcn',
        purchaseYears: 1,
        registrationPriceFen: 2_900,
        renewalPriceFen: 3_500,
      },
      ok: true,
    })

    expect(transport.requests).toEqual([
      expect.objectContaining({
        body: { act: 'query', domain: 'ceo', suffix: '.top' },
        operation: 'availability',
        path: 'v2/domain/query/',
      }),
      expect.objectContaining({
        body: { act: 'getprice', type: 'domain', value: 'west.cn', year: '1' },
        operation: 'price',
        path: 'v2/info/',
      }),
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(WESTDIGITAL_AVAILABILITY_FIXTURE.result).toBe(200)
    expect(WESTDIGITAL_PRICE_FIXTURE.result).toBe(200)
  })

  it('rejects invalid domains, missing suffixes and invalid years before transport', async () => {
    const { provider, transport } = createProvider()

    const invalidDomain = await provider.queryAvailability({
      domain: '😀.com',
      traceId: 'trace-westdigital-invalid-domain',
    })
    expectFailure(invalidDomain, 'DOMAIN_INVALID_CHARACTER', '域名包含不受支持的字符', false)

    const missingSuffix = await provider.queryAvailability({
      domain: 'example',
      traceId: 'trace-westdigital-missing-suffix',
    })
    expectFailure(
      missingSuffix,
      'WESTDIGITAL_DOMAIN_SUFFIX_REQUIRED',
      '请输入包含后缀的完整域名',
      false,
    )

    const invalidYears = await provider.queryPrice({
      domain: 'example.com',
      traceId: 'trace-westdigital-invalid-years',
      years: 11,
    })
    expect(invalidYears.ok).toBe(false)
    if (!invalidYears.ok)
      expect(invalidYears.error).toMatchObject({
        code: 'WESTDIGITAL_INVALID_YEARS',
        message: '域名价格查询年限必须为 1 至 10 年',
        retryable: false,
      })
    expect(transport.requests).toHaveLength(0)
  })

  it('merges normalized Unicode and Punycode requests in flight, then serves the cache', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { provider, transport } = createProvider(async (request) => {
      await gate
      return availabilityResponse(request)
    })

    const unicode = provider.queryAvailability({
      domain: '例子。中国',
      traceId: 'trace-westdigital-unicode',
    })
    const punycode = provider.queryAvailability({
      domain: 'XN--FSQU00A.XN--FIQS8S',
      traceId: 'trace-westdigital-punycode',
    })
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1))

    release?.()
    const [first, second] = await Promise.all([unicode, punycode])
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      cache: { status: 'miss' },
      data: { domainAscii: 'xn--fsqu00a.xn--fiqs8s' },
      ok: true,
    })

    const cached = await provider.queryAvailability({
      domain: '例子.中国',
      traceId: 'trace-westdigital-cache-hit',
    })
    expect(cached).toMatchObject({ cache: { status: 'hit' }, ok: true })
    expect(cached.requestId).toBe(first.requestId)
    expect(transport.requests).toHaveLength(1)
  })

  it('bounds availability and price caches with LRU eviction and independent TTLs', async () => {
    let currentTime = Date.UTC(2026, 7, 5, 12)
    const { provider, transport } = createProvider(
      (request) =>
        request.operation === 'availability'
          ? availabilityResponse(request)
          : priceResponse(request),
      {
        config: {
          availabilityCacheMaxEntries: 2,
          availabilityCacheTtlMs: 100,
          priceCacheMaxEntries: 1,
          priceCacheTtlMs: 1_000,
        },
        now: () => currentTime,
      },
    )

    const availability = (domain: string) =>
      provider.queryAvailability({ domain, traceId: `trace-availability-${domain}` })
    const firstAvailability = await availability('a.com')
    expect(firstAvailability).toMatchObject({
      cache: { expiresAt: new Date(currentTime + 100).toISOString(), status: 'miss' },
      observedAt: new Date(currentTime).toISOString(),
    })
    await availability('b.com')
    const cachedAvailability = await availability('a.com')
    expect(cachedAvailability).toMatchObject({
      cache: { expiresAt: new Date(currentTime + 100).toISOString(), status: 'hit' },
      observedAt: firstAvailability.observedAt,
      requestId: firstAvailability.requestId,
    })
    await availability('c.com')
    await availability('b.com')
    expect(
      transport.requests.filter((request) => request.operation === 'availability'),
    ).toHaveLength(4)

    currentTime += 101
    await availability('c.com')
    expect(
      transport.requests.filter((request) => request.operation === 'availability'),
    ).toHaveLength(5)

    const price = (domain: string) =>
      provider.queryPrice({ domain, traceId: `trace-price-${domain}`, years: 1 })
    await price('a.com')
    expect(await price('a.com')).toMatchObject({ cache: { status: 'hit' } })
    await price('b.com')
    await price('a.com')
    expect(transport.requests.filter((request) => request.operation === 'price')).toHaveLength(3)

    currentTime += 1_001
    await price('a.com')
    expect(transport.requests.filter((request) => request.operation === 'price')).toHaveLength(4)
  })

  it('enforces the token bucket and dispatches queued requests in FIFO order', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'))
    const { provider, transport } = createProvider((request) => availabilityResponse(request), {
      config: { burst: 2, queueCapacity: 4, queueWaitMs: 5_000, ratePerSecond: 2 },
    })

    const requests = ['a.com', 'b.com', 'c.com', 'd.com'].map((domain) =>
      provider.queryAvailability({ domain, traceId: `trace-rate-${domain}` }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.requests.map((request) => request.body.domain)).toEqual(['a', 'b'])

    await vi.advanceTimersByTimeAsync(500)
    expect(transport.requests.map((request) => request.body.domain)).toEqual(['a', 'b', 'c'])
    await vi.advanceTimersByTimeAsync(500)
    expect(transport.requests.map((request) => request.body.domain)).toEqual(['a', 'b', 'c', 'd'])
    expect((await Promise.all(requests)).every((result) => result.ok)).toBe(true)
  })

  it('returns explicit queue-full, transport-timeout and queue-timeout failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'))
    const { provider } = createProvider(
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted fixture')))
        }),
      {
        config: {
          burst: 1,
          queueCapacity: 1,
          queueWaitMs: 1_500,
          ratePerSecond: 0.1,
          transportTimeoutMs: 1_000,
        },
      },
    )

    const running = provider.queryAvailability({
      domain: 'a.com',
      traceId: 'trace-westdigital-running',
    })
    const queued = provider.queryAvailability({
      domain: 'b.com',
      traceId: 'trace-westdigital-queued',
    })
    const full = provider.queryAvailability({
      domain: 'c.com',
      traceId: 'trace-westdigital-full',
    })
    await vi.advanceTimersByTimeAsync(0)

    expectFailure(await full, 'WESTDIGITAL_QUEUE_FULL', '当前域名查询请求较多，请稍后重试', true)
    await vi.advanceTimersByTimeAsync(1_000)
    expectFailure(await running, 'WESTDIGITAL_TIMEOUT', '域名数据源响应超时，请稍后重试', true)
    await vi.advanceTimersByTimeAsync(500)
    expectFailure(await queued, 'WESTDIGITAL_QUEUE_TIMEOUT', '域名查询等待超时，请稍后重试', true)
  })

  it('maps upstream 429 with retry guidance and never exposes its response body', async () => {
    const logs: Record<string, unknown>[] = []
    const logger: WestDigitalLogger = {
      info(fields) {
        logs.push(fields)
      },
      warn(fields) {
        logs.push(fields)
      },
    }
    const { provider } = createProvider(
      () => ({
        body: { result: 429, token: 'provider-secret-token' },
        headers: { 'retry-after': '12' },
        status: 429,
      }),
      { logger },
    )

    const result = await provider.queryAvailability({
      domain: 'private-query.example',
      traceId: 'trace-westdigital-rate-limited',
    })
    expectFailure(result, 'WESTDIGITAL_RATE_LIMITED', '域名数据源请求过于频繁，请稍后重试', true)
    if (!result.ok) expect(result.error).toMatchObject({ retryAfterSeconds: 12, retryable: true })
    expect(JSON.stringify({ logs, result })).not.toContain('provider-secret-token')
    expect(JSON.stringify(logs)).not.toContain('private-query.example')
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: 'WESTDIGITAL_RATE_LIMITED',
          operation: 'availability',
          provider: 'westdigital',
          requestId: expect.stringMatching(/^westdigital-test-/u),
          traceId: 'trace-westdigital-rate-limited',
        }),
      ]),
    )
  })

  it('maps connection failures without leaking thrown provider details', async () => {
    const { provider } = createProvider(() => {
      throw new Error('socket failed with provider-secret-detail')
    })
    const result = await provider.queryAvailability({
      domain: 'example.com',
      traceId: 'trace-westdigital-connection',
    })

    expectFailure(result, 'WESTDIGITAL_UNAVAILABLE', '暂时无法连接域名数据源，请稍后重试', true)
    expect(JSON.stringify(result)).not.toContain('provider-secret-detail')
  })

  it('maps HTTP and provider business rejections without exposing provider messages', async () => {
    const cases: Array<[string, WestDigitalTransportResponse]> = [
      ['http', { body: { raw: 'provider-secret-http-body' }, status: 503 }],
      ['business', { body: { msg: 'provider-secret-business-message', result: 500 }, status: 200 }],
    ]

    for (const [name, response] of cases) {
      const { provider } = createProvider(() => response)
      const result = await provider.queryAvailability({
        domain: 'example.com',
        traceId: `trace-westdigital-rejected-${name}`,
      })
      expectFailure(result, 'WESTDIGITAL_REJECTED', '域名数据源未能完成查询', true)
      if (!result.ok) expect(result.error.retryable).toBe(true)
      expect(JSON.stringify(result)).not.toContain('provider-secret')
    }
  })

  it('rejects malformed fields and does not cache malformed responses', async () => {
    let calls = 0
    const malformedBodies: WestDigitalFixtureHandler = (request) => {
      calls += 1
      if (calls === 1) return availabilityResponse(request, { price: 29.5, type: 'premium' })
      return availabilityResponse(request)
    }
    const { provider } = createProvider(malformedBodies)

    const malformed = await provider.queryAvailability({
      domain: 'example.com',
      traceId: 'trace-westdigital-malformed',
    })
    expectFailure(
      malformed,
      'WESTDIGITAL_INVALID_RESPONSE',
      '域名数据源返回异常，暂时无法确认结果',
      false,
    )
    if (!malformed.ok) expect(malformed.error.retryable).toBe(false)

    const recovered = await provider.queryAvailability({
      domain: 'example.com',
      traceId: 'trace-westdigital-malformed-recovered',
    })
    expect(recovered.ok).toBe(true)
    expect(calls).toBe(2)

    const cases: Array<[string, WestDigitalFixtureHandler]> = [
      ['missing envelope', () => ({ body: { clientid: 'missing-result' }, status: 200 })],
      ['negative', (request) => availabilityResponse(request, { price: -1, type: 'premium' })],
      ['mismatched domain', (request) => availabilityResponse(request, { name: 'other.com' })],
      ['mismatched years', (request) => priceResponse(request, { buyyear: '2' })],
      ['fractional price', (request) => priceResponse(request, { buyprice: 29.5 })],
    ]
    for (const [name, handler] of cases) {
      const current = createProvider(handler).provider
      const result =
        name.includes('years') || name.includes('price')
          ? await current.queryPrice({ domain: 'example.com', traceId: `trace-${name}`, years: 1 })
          : await current.queryAvailability({ domain: 'example.com', traceId: `trace-${name}` })
      expect(result.ok, name).toBe(false)
      if (!result.ok) expect(result.error.code, name).toBe('WESTDIGITAL_INVALID_RESPONSE')
    }
  })

  it('does not serve stale data or cache a failure after a successful entry expires', async () => {
    let currentTime = Date.UTC(2026, 7, 5, 12)
    let calls = 0
    const { provider } = createProvider(
      (request) => {
        calls += 1
        if (calls === 1) return availabilityResponse(request)
        return { body: { result: 200 }, status: 200 }
      },
      { config: { availabilityCacheTtlMs: 100 }, now: () => currentTime },
    )

    expect(
      await provider.queryAvailability({ domain: 'example.com', traceId: 'trace-stale-success' }),
    ).toMatchObject({ ok: true })
    currentTime += 101

    for (const traceId of ['trace-stale-failure', 'trace-failure-not-cached']) {
      const result = await provider.queryAvailability({ domain: 'example.com', traceId })
      expectFailure(
        result,
        'WESTDIGITAL_INVALID_RESPONSE',
        '域名数据源返回异常，暂时无法确认结果',
        false,
      )
    }
    expect(calls).toBe(3)
  })

  it('preserves the existing mock write boundary for commerce fixtures', async () => {
    const provider = new MockWestDigitalProvider()
    const result = await provider.submitOperation({
      operationKey: 'order-123-register',
      traceId: 'trace-westdigital-mock-write',
    })
    expect(result).toMatchObject({
      data: { providerRequestId: 'mock-order-123-register' },
      ok: true,
    })
  })
})
