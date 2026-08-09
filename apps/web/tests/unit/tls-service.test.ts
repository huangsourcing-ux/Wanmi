import { describe, expect, it, vi } from 'vitest'

import type { ProviderResult } from '@/lib/domain'
import type {
  DnsProviderAnswer,
  DnsReadProvider,
  TlsHandshakeProvider,
  TlsHandshakeReport,
} from '@/providers/types'
import type { DnsRecord, DnsRecordType } from '@/schemas/dns'
import type { TlsFinding } from '@/schemas/tls'
import { DnsResultCache } from '@/services/dns/query-dns-records'
import { TlsResultCache, queryTlsCertificate } from '@/services/tls/query-tls-certificate'

const observedAt = '2026-08-05T12:00:00.000Z'
const now = () => Date.parse(observedAt)
const dnsCacheConfig = {
  maxEntries: 4_096,
  maxNegativeTtlMs: 30_000,
  maxPositiveTtlMs: 60_000,
  maxTargets: 16,
}
const resultCacheConfig = { emptyTtlMs: 30_000, maxEntries: 2_048, resultTtlMs: 60_000 }

function dnsSuccess(
  recordType: DnsRecordType,
  records: DnsRecord[] = [],
): ProviderResult<DnsProviderAnswer> {
  return {
    cache: { status: 'miss' },
    data: {
      fallbackUsed: false,
      ...(records.length === 0 ? { negativeTtlSeconds: 30 } : {}),
      records,
      resolverNode: 'alidns_primary',
      status: records.length > 0 ? 'records' : 'no_record',
    },
    observedAt,
    ok: true,
    requestId: `dns-${recordType}`,
  }
}

function dnsFailure(code: string): ProviderResult<DnsProviderAnswer> {
  return {
    cache: { status: 'miss' },
    error: { code, message: 'DNS 查询失败', retryable: true, statusKnown: false },
    observedAt,
    ok: false,
    requestId: 'dns-failed',
  }
}

function dnsProvider(
  implementation: (
    input: Parameters<DnsReadProvider['queryRecordSet']>[0],
  ) => ProviderResult<DnsProviderAnswer>,
): DnsReadProvider & { queryRecordSet: ReturnType<typeof vi.fn> } {
  const queryRecordSet = vi.fn(async (input) => implementation(input))
  return {
    health: async () => ({
      data: { healthy: true },
      observedAt,
      ok: true,
      requestId: 'dns-health',
    }),
    queryRecordSet,
  }
}

function certificate() {
  return {
    chain: {
      certificates: [
        {
          fingerprint256: 'AA:BB',
          issuer: { commonName: 'Test Root', organization: 'Wanmi Tests' },
          subject: { commonName: 'example.test', organization: 'Wanmi Tests' },
          validFrom: '2026-08-01T00:00:00.000Z',
          validTo: '2026-09-01T00:00:00.000Z',
        },
      ],
      depth: 1,
      status: 'trusted' as const,
      truncated: false,
    },
    daysRemaining: 27,
    hostnameMatch: true,
    issuer: { commonName: 'Test Root', organization: 'Wanmi Tests' },
    sanCount: 1,
    sanTruncated: false,
    subject: { commonName: 'example.test', organization: 'Wanmi Tests' },
    subjectAlternativeNames: ['example.test'],
    validFrom: '2026-08-01T00:00:00.000Z',
    validityStatus: 'valid' as const,
    validTo: '2026-09-01T00:00:00.000Z',
  }
}

function tlsSuccess(findings: TlsFinding[] = []): ProviderResult<TlsHandshakeReport> {
  return {
    cache: { status: 'miss' },
    data: {
      certificate: certificate(),
      cipherSuite: 'TLS_AES_256_GCM_SHA384',
      findings,
      protocol: 'TLSv1.3',
    },
    observedAt,
    ok: true,
    requestId: 'tls-success',
  }
}

function tlsFailure(code: string): ProviderResult<TlsHandshakeReport> {
  const message =
    code === 'TLS_TIMEOUT'
      ? 'TLS 连接或握手超时'
      : code === 'TLS_HANDSHAKE_FAILED'
        ? '目标未能完成 TLS 握手'
        : code === 'TLS_HANDSHAKE_TOO_LARGE'
          ? 'TLS 握手数据超过安全上限'
          : 'TLS 检查失败'
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message,
      retryable: code !== 'TLS_HANDSHAKE_TOO_LARGE' && code !== 'TLS_TARGET_CHANGED',
      statusKnown: false,
    },
    observedAt,
    ok: false,
    requestId: 'tls-failed',
  }
}

function tlsProvider(
  implementation: (
    input: Parameters<TlsHandshakeProvider['inspectCertificate']>[0],
  ) => ProviderResult<TlsHandshakeReport> = () => tlsSuccess(),
): TlsHandshakeProvider & { inspectCertificate: ReturnType<typeof vi.fn> } {
  const inspectCertificate = vi.fn(async (input) => implementation(input))
  return {
    health: async () => ({
      data: { healthy: true },
      observedAt,
      ok: true,
      requestId: 'tls-health',
    }),
    inspectCertificate,
  }
}

function options(dns: DnsReadProvider, tls: TlsHandshakeProvider, traceId = 'trace-tls-service') {
  return {
    cache: new TlsResultCache(resultCacheConfig.maxEntries, now),
    cacheConfig: resultCacheConfig,
    dnsCache: new DnsResultCache(dnsCacheConfig.maxEntries, now),
    dnsCacheConfig,
    dnsProvider: dns,
    now,
    tlsProvider: tls,
    traceId,
  }
}

describe('TLS / CAA orchestration and SSRF controls', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '192.0.2.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:93.184.216.34',
    '2001:db8::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])(
    'blocks restricted address %s before the TLS connector and does not disclose it',
    async (address) => {
      const addressType = address.includes(':') ? 'AAAA' : 'A'
      const dns = dnsProvider(({ domainAscii, recordType }) => {
        if (recordType === addressType) {
          return dnsSuccess(recordType, [
            { address, ownerName: domainAscii, ttl: 60, type: addressType },
          ] as DnsRecord[])
        }
        return dnsSuccess(recordType)
      })
      const tls = tlsProvider()
      const result = await queryTlsCertificate(
        { query: `blocked-${addressType.toLowerCase()}.example.test` },
        options(dns, tls),
      )
      expect(result).toMatchObject({ problem: { code: 'TLS_TARGET_BLOCKED' }, state: 'error' })
      expect(result).not.toHaveProperty('data')
      expect(JSON.stringify(result)).not.toContain(address)
      expect(tls.inspectCertificate).not.toHaveBeenCalled()
    },
  )

  it('blocks DNS rebinding when a later resolution changes from public to private', async () => {
    let addressLookup = 0
    const dns = dnsProvider(({ domainAscii, recordType }) => {
      if (recordType === 'A') {
        addressLookup += 1
        const address = addressLookup === 1 ? '93.184.216.34' : '127.0.0.1'
        return dnsSuccess('A', [{ address, ownerName: domainAscii, ttl: 0, type: 'A' }])
      }
      return dnsSuccess(recordType)
    })
    const tls = tlsProvider()

    await expect(
      queryTlsCertificate({ query: 'rebind.example.test' }, options(dns, tls, 'rebind-first')),
    ).resolves.toMatchObject({ state: 'ready' })
    await expect(
      queryTlsCertificate({ query: 'rebind.example.test' }, options(dns, tls, 'rebind-second')),
    ).resolves.toMatchObject({ problem: { code: 'TLS_TARGET_BLOCKED' }, state: 'error' })
    expect(tls.inspectCertificate).toHaveBeenCalledTimes(1)
    expect(tls.inspectCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ addresses: ['93.184.216.34'] }),
    )
  })

  it('uses current or inherited RFC 8659 CAA RRsets and reuses the bounded DNS/result caches', async () => {
    const dns = dnsProvider(({ domainAscii, recordType }) => {
      if (recordType === 'A') {
        return dnsSuccess('A', [
          { address: '93.184.216.34', ownerName: domainAscii, ttl: 120, type: 'A' },
        ])
      }
      if (recordType === 'CAA' && domainAscii === 'example.test') {
        return dnsSuccess('CAA', [
          {
            flags: 128,
            ownerName: domainAscii,
            tag: 'issue',
            ttl: 120,
            type: 'CAA',
            value: '',
          },
          {
            flags: 0,
            ownerName: domainAscii,
            tag: 'issuewild',
            ttl: 120,
            type: 'CAA',
            value: 'ca.example',
          },
          {
            flags: 0,
            ownerName: domainAscii,
            tag: 'iodef',
            ttl: 120,
            type: 'CAA',
            value: 'mailto:security@example.test',
          },
        ])
      }
      return dnsSuccess(recordType)
    })
    const tls = tlsProvider()
    const cache = new TlsResultCache(resultCacheConfig.maxEntries, now)
    const firstOptions = { ...options(dns, tls, 'trace-first'), cache }
    const first = await queryTlsCertificate({ query: 'www.example.test' }, firstOptions)
    const calls = dns.queryRecordSet.mock.calls.length
    const second = await queryTlsCertificate(
      { query: 'www.example.test' },
      { ...firstOptions, traceId: 'trace-second' },
    )

    expect(first).toMatchObject({
      data: {
        caa: {
          effectiveOwnerName: 'example.test',
          inherited: true,
          records: [
            { critical: true, tag: 'issue', value: '' },
            { tag: 'issuewild' },
            { tag: 'iodef' },
          ],
          status: 'records',
        },
        tls: { port: 443, status: 'connected' },
      },
      state: 'ready',
    })
    if (!('data' in first)) throw new Error('expected ready data')
    expect(first.data.caa.records[0]?.explanation).toMatch(/critical.*不允许任何 CA/u)
    expect(first.data.caa.records[2]?.explanation).toMatch(/不会访问/u)
    expect(tls.inspectCertificate).toHaveBeenCalledWith({
      addresses: ['93.184.216.34'],
      domainAscii: 'www.example.test',
      traceId: 'trace-first',
    })
    expect(second).toMatchObject({
      data: { caa: { source: { cacheStatus: 'hit' } }, tls: { source: { cacheStatus: 'hit' } } },
      meta: { cacheStatus: 'hit', traceId: 'trace-second' },
      state: 'ready',
    })
    expect(dns.queryRecordSet).toHaveBeenCalledTimes(calls)
    expect(tls.inspectCertificate).toHaveBeenCalledTimes(1)
  })

  it('coalesces an in-flight domain without leaking the first request trace ID', async () => {
    const dns = dnsProvider(({ domainAscii, recordType }) =>
      recordType === 'A'
        ? dnsSuccess('A', [
            { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
          ])
        : dnsSuccess(recordType),
    )
    let resolveTls: ((result: ProviderResult<TlsHandshakeReport>) => void) | undefined
    const inspectCertificate = vi.fn<TlsHandshakeProvider['inspectCertificate']>(
      async () =>
        new Promise<ProviderResult<TlsHandshakeReport>>((resolve) => {
          resolveTls = resolve
        }),
    )
    const tls: TlsHandshakeProvider = {
      health: async () => ({ data: { healthy: true }, observedAt, ok: true, requestId: 'health' }),
      inspectCertificate,
    }
    const cache = new TlsResultCache(resultCacheConfig.maxEntries, now)
    const sharedOptions = { ...options(dns, tls, 'trace-coalesce-first'), cache }
    const first = queryTlsCertificate({ query: 'coalesce.example.test' }, sharedOptions)
    await vi.waitFor(() => expect(resolveTls).toBeDefined())
    const second = queryTlsCertificate(
      { query: 'coalesce.example.test' },
      { ...sharedOptions, traceId: 'trace-coalesce-second' },
    )
    resolveTls?.(tlsSuccess())
    await expect(first).resolves.toMatchObject({ meta: { traceId: 'trace-coalesce-first' } })
    await expect(second).resolves.toMatchObject({ meta: { traceId: 'trace-coalesce-second' } })
    expect(inspectCertificate).toHaveBeenCalledTimes(1)
  })

  it('stops CAA inheritance on an unknown layer and returns TLS data as partial', async () => {
    const dns = dnsProvider(({ domainAscii, recordType }) => {
      if (recordType === 'A') {
        return dnsSuccess('A', [
          { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
        ])
      }
      if (recordType === 'CAA' && domainAscii === 'www.example.test') {
        return dnsFailure('DNS_TIMEOUT')
      }
      if (recordType === 'CAA' && domainAscii === 'example.test') {
        throw new Error('CAA traversal crossed an unknown layer')
      }
      return dnsSuccess(recordType)
    })
    const result = await queryTlsCertificate(
      { query: 'www.example.test' },
      options(dns, tlsProvider()),
    )
    expect(result).toMatchObject({
      data: { caa: { issue: { code: 'CAA_TIMEOUT' }, status: 'timeout' } },
      state: 'partial',
    })
    expect(
      dns.queryRecordSet.mock.calls.some(([input]) => input.domainAscii === 'example.test'),
    ).toBe(false)
  })

  it('limits CAA tree climbing to 16 levels', async () => {
    const dns = dnsProvider(({ domainAscii, recordType }) => {
      if (recordType === 'A') {
        return dnsSuccess('A', [
          { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
        ])
      }
      return dnsSuccess(recordType)
    })
    const domain = `${Array.from({ length: 17 }, (_, index) => `l${index}`).join('.')}.test`
    const result = await queryTlsCertificate({ query: domain }, options(dns, tlsProvider()))
    expect(result).toMatchObject({
      data: { caa: { issue: { code: 'CAA_LOOKUP_LIMIT_EXCEEDED' }, status: 'limit_exceeded' } },
      state: 'partial',
    })
    expect(
      dns.queryRecordSet.mock.calls.filter(([input]) => input.recordType === 'CAA'),
    ).toHaveLength(16)
  })

  it('maps certificate findings, address-family failure and hard handshake limits to distinct states', async () => {
    const baseDns = dnsProvider(({ domainAscii, recordType }) => {
      if (recordType === 'A') {
        return dnsSuccess('A', [
          { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
        ])
      }
      return dnsSuccess(recordType)
    })
    const expired = await queryTlsCertificate(
      { query: 'expired.example.test' },
      options(
        baseDns,
        tlsProvider(() =>
          tlsSuccess([{ code: 'TLS_CERT_EXPIRED', message: '证书已过期', severity: 'error' }]),
        ),
      ),
    )
    expect(expired).toMatchObject({
      data: { tls: { findings: [{ code: 'TLS_CERT_EXPIRED' }] } },
      problem: { code: 'TLS_CERT_EXPIRED' },
      state: 'degraded',
    })

    const familyFailureDns = dnsProvider(({ domainAscii, recordType }) => {
      if (recordType === 'A') {
        return dnsSuccess('A', [
          { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
        ])
      }
      if (recordType === 'AAAA') return dnsFailure('DNS_TIMEOUT')
      return dnsSuccess(recordType)
    })
    expect(
      await queryTlsCertificate(
        { query: 'family.example.test' },
        options(familyFailureDns, tlsProvider()),
      ),
    ).toMatchObject({ state: 'partial' })

    const oversized = await queryTlsCertificate(
      { query: 'large.example.test' },
      options(
        baseDns,
        tlsProvider(() => tlsFailure('TLS_HANDSHAKE_TOO_LARGE')),
      ),
    )
    expect(oversized).toMatchObject({
      problem: { code: 'TLS_HANDSHAKE_TOO_LARGE' },
      state: 'error',
    })
    expect(oversized).not.toHaveProperty('data')
  })

  it.each([
    ['TLS_TIMEOUT', 'timeout', 'TLS 连接或握手超时'],
    ['TLS_HANDSHAKE_FAILED', 'handshake_failed', '目标未能完成 TLS 握手'],
  ] as const)(
    'keeps CAA diagnostics visible when TLS returns %s',
    async (code, tlsStatus, message) => {
      const publicDns = dnsProvider(({ domainAscii, recordType }) =>
        recordType === 'A'
          ? dnsSuccess('A', [
              { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
            ])
          : dnsSuccess(recordType),
      )
      const result = await queryTlsCertificate(
        { query: `${tlsStatus.replaceAll('_', '-')}.example.test` },
        options(
          publicDns,
          tlsProvider(() => tlsFailure(code)),
        ),
      )

      expect(result).toMatchObject({
        data: {
          caa: { status: 'no_record' },
          tls: {
            issue: { code, message, retryable: true },
            status: tlsStatus,
          },
        },
        problem: {
          action: '请稍后重试',
          code,
          detail: `${message}；CAA 结果仍可查看`,
          retryable: true,
        },
        state: 'partial',
      })
      expect(JSON.stringify(result)).not.toMatch(/"available"|"purchase"/iu)
    },
  )

  it('returns empty, partial, error and rate-limited without manufacturing diagnostics', async () => {
    const noAddressDns = dnsProvider(({ recordType }) => dnsSuccess(recordType))
    expect(
      await queryTlsCertificate(
        { query: 'empty.example.test' },
        options(noAddressDns, tlsProvider()),
      ),
    ).toMatchObject({ data: { tls: { status: 'no_address' } }, state: 'empty' })

    const incompleteNoAddressDns = dnsProvider(({ recordType }) =>
      recordType === 'AAAA' ? dnsFailure('DNS_TIMEOUT') : dnsSuccess(recordType),
    )
    expect(
      await queryTlsCertificate(
        { query: 'partial-empty.example.test' },
        options(incompleteNoAddressDns, tlsProvider()),
      ),
    ).toMatchObject({ data: { tls: { status: 'no_address' } }, state: 'partial' })

    const publicDns = dnsProvider(({ domainAscii, recordType }) =>
      recordType === 'A'
        ? dnsSuccess('A', [
            { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
          ])
        : dnsSuccess(recordType),
    )
    expect(
      await queryTlsCertificate(
        { query: 'refused.example.test' },
        options(
          publicDns,
          tlsProvider(() => tlsFailure('TLS_CONNECTION_FAILED')),
        ),
      ),
    ).toMatchObject({ data: { caa: { status: 'no_record' } }, state: 'partial' })

    const caaAndTlsFailedDns = dnsProvider(({ domainAscii, recordType }) => {
      if (recordType === 'A') {
        return dnsSuccess('A', [
          { address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' },
        ])
      }
      if (recordType === 'CAA') return dnsFailure('DNS_TIMEOUT')
      return dnsSuccess(recordType)
    })
    const noDiagnostics = await queryTlsCertificate(
      { query: 'unavailable.example.test' },
      options(
        caaAndTlsFailedDns,
        tlsProvider(() => tlsFailure('TLS_CONNECTION_FAILED')),
      ),
    )
    expect(noDiagnostics).toMatchObject({
      problem: {
        action: '请稍后重试',
        code: 'SSL_CHECK_UNAVAILABLE',
        detail: 'TLS 与 CAA 均未能取得可用诊断数据',
      },
      state: 'error',
    })
    expect(noDiagnostics).not.toHaveProperty('data')

    const allDnsBusy = dnsProvider(() => dnsFailure('DNS_QUEUE_FULL'))
    expect(
      await queryTlsCertificate(
        { query: 'busy-dns.example.test' },
        options(allDnsBusy, tlsProvider()),
      ),
    ).toMatchObject({
      problem: {
        action: '请稍后重试',
        code: 'TLS_RATE_LIMITED',
        detail: 'DNS 查询队列繁忙，未能解析 TLS 目标',
        status: 429,
      },
      state: 'rate_limited',
    })

    const targetChanged = await queryTlsCertificate(
      { query: 'changed.example.test' },
      options(
        publicDns,
        tlsProvider(() => tlsFailure('TLS_TARGET_CHANGED')),
      ),
    )
    expect(targetChanged).toMatchObject({
      problem: { code: 'TLS_TARGET_CHANGED' },
      state: 'error',
    })
    expect(targetChanged).not.toHaveProperty('data')
  })
})
