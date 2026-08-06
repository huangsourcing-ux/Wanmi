import { describe, expect, it, vi } from 'vitest'

import type { ProviderResult } from '@/lib/domain'
import type { PublicRegistrationProvider, PublicRegistrationRecord } from '@/providers/types'
import { queryPublicRegistration } from '@/services/whois/query-public-registration'

const observedAt = '2026-08-05T12:00:00.000Z'
const traceId = 'trace-whois-service'

function record(
  domainAscii = 'example.test',
  options: {
    protocol?: 'rdap' | 'whois'
    provider?: 'whodat' | 'westdigital'
    recordStatus?: 'record_found' | 'no_public_record'
  } = {},
): PublicRegistrationRecord {
  return {
    dates: { created: null, expires: null, updated: null },
    domainAscii,
    domainUnicode: domainAscii,
    nameServers: [],
    recordStatus: options.recordStatus ?? 'record_found',
    registrar: 'Fixture Registrar',
    source: {
      protocol: options.protocol ?? 'rdap',
      provider: options.provider ?? 'whodat',
    },
    statuses: [],
  }
}

function success(
  data: PublicRegistrationRecord,
  cached = false,
): ProviderResult<PublicRegistrationRecord> {
  return {
    cache: { status: cached ? 'hit' : 'miss' },
    data,
    observedAt,
    ok: true,
    requestId: 'provider-request-id',
  }
}

function failure(
  code: string,
  retryable = true,
  retryAfterSeconds?: number,
): ProviderResult<PublicRegistrationRecord> {
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message: 'safe provider failure',
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      retryable,
      statusKnown: false,
    },
    observedAt,
    ok: false,
    requestId: 'provider-request-id',
  }
}

function provider(result: ProviderResult<PublicRegistrationRecord>): PublicRegistrationProvider {
  const queryPublicRegistration: PublicRegistrationProvider['queryPublicRegistration'] = vi.fn(
    async () => result,
  )
  return {
    health: async () => ({
      data: { healthy: true },
      observedAt,
      ok: true,
      requestId: 'health-request-id',
    }),
    queryPublicRegistration,
  }
}

describe('WHOIS public registration orchestration', () => {
  it('normalizes Unicode input and returns a ready RDAP result with public-only fields', async () => {
    const primary = provider(success(record('xn--fsqu00a.xn--0zwm56d'), true))
    const result = await queryPublicRegistration({ query: '例子.测试' }, { primary, traceId })
    expect(result).toMatchObject({
      data: {
        domainAscii: 'xn--fsqu00a.xn--0zwm56d',
        normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
        normalizedQueryUnicode: '例子.测试',
        recordStatus: 'record_found',
      },
      meta: {
        cacheStatus: 'hit',
        dataSource: 'Who-Dat RDAP',
        observedAt,
        traceId,
      },
      state: 'ready',
    })
    expect(primary.queryPublicRegistration).toHaveBeenCalledWith({
      domainAscii: 'xn--fsqu00a.xn--0zwm56d',
      traceId,
    })
    expect(JSON.stringify(result)).not.toMatch(/available|price|purchase/i)
  })

  it('maps no public record only to empty and treats Who-Dat WHOIS as normal coverage', async () => {
    const empty = await queryPublicRegistration(
      { query: 'example.test' },
      {
        primary: provider(
          success(record('example.test', { protocol: 'whois', recordStatus: 'no_public_record' })),
        ),
        traceId,
      },
    )
    expect(empty).toMatchObject({
      data: {
        recordStatus: 'no_public_record',
        source: { protocol: 'whois', provider: 'whodat' },
      },
      state: 'empty',
    })
    expect(JSON.stringify(empty)).not.toContain('available')
  })

  it('does not bypass Who-Dat rate limiting with the fallback provider', async () => {
    const fallback = provider(
      success(record('example.test', { provider: 'westdigital', protocol: 'whois' })),
    )
    const result = await queryPublicRegistration(
      { query: 'example.test' },
      {
        fallback,
        primary: provider(failure('WHODAT_RATE_LIMITED', true, 9)),
        traceId,
      },
    )
    expect(result).toMatchObject({
      problem: { code: 'WHODAT_RATE_LIMITED', retryAfterSeconds: 9 },
      state: 'rate_limited',
    })
    expect(fallback.queryPublicRegistration).not.toHaveBeenCalled()
  })

  it.each([
    'WHODAT_UNSUPPORTED_TLD',
    'WHODAT_UPSTREAM_ERROR',
    'WHODAT_TIMEOUT',
    'WHODAT_UNAVAILABLE',
    'WHODAT_RESPONSE_TOO_LARGE',
    'WHODAT_INVALID_RESPONSE',
    'WHODAT_REDIRECT_REJECTED',
  ])('returns degraded when %s falls back successfully', async (code) => {
    const fallback = provider(
      success(record('example.test', { protocol: 'whois', provider: 'westdigital' })),
    )
    const result = await queryPublicRegistration(
      { query: 'example.test' },
      { fallback, primary: provider(failure(code)), traceId },
    )
    expect(result).toMatchObject({
      data: {
        recordStatus: 'record_found',
        source: { protocol: 'whois', provider: 'westdigital' },
      },
      meta: { dataSource: '西部数码 WHOIS（Who-Dat 降级）' },
      problem: { code: 'WHOIS_FALLBACK_USED' },
      state: 'degraded',
    })
  })

  it('returns a safe aggregate error when both sources fail and preserves fallback rate limiting', async () => {
    const unavailable = await queryPublicRegistration(
      { query: 'example.test' },
      {
        fallback: provider(failure('WESTDIGITAL_UNAVAILABLE')),
        primary: provider(failure('WHODAT_TIMEOUT')),
        traceId,
      },
    )
    expect(unavailable).toMatchObject({
      meta: { dataSource: 'Who-Dat RDAP/WHOIS + 西部数码 WHOIS' },
      problem: { code: 'WHOIS_SOURCES_UNAVAILABLE' },
      state: 'error',
    })

    const rateLimited = await queryPublicRegistration(
      { query: 'example.test' },
      {
        fallback: provider(failure('WESTDIGITAL_RATE_LIMITED', true, 3)),
        primary: provider(failure('WHODAT_TIMEOUT')),
        traceId,
      },
    )
    expect(rateLimited).toMatchObject({
      problem: { code: 'WESTDIGITAL_RATE_LIMITED', retryAfterSeconds: 3 },
      state: 'rate_limited',
    })
  })

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.100.100.200',
    '::1',
    'fc00::1',
    'fe80::1',
    'metadata.google.internal',
    'service.localhost',
  ])('rejects forbidden IP, local and metadata target %s before provider access', async (query) => {
    const primary = provider(success(record()))
    await expect(queryPublicRegistration({ query }, { primary, traceId })).rejects.toMatchObject({
      code: 'DOMAIN_TARGET_FORBIDDEN',
    })
    expect(primary.queryPublicRegistration).not.toHaveBeenCalled()
  })

  it.each([
    'localhost',
    'https://example.test',
    'user@example.test',
    'example.test/path',
    'example.test:43',
  ])('rejects non-domain or single-label input %s', async (query) => {
    const primary = provider(success(record()))
    await expect(queryPublicRegistration({ query }, { primary, traceId })).rejects.toBeDefined()
    expect(primary.queryPublicRegistration).not.toHaveBeenCalled()
  })
})
