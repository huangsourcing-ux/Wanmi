import { describe, expect, it, vi } from 'vitest'

import type { ProviderResult } from '@/lib/domain'
import type { DnsProviderAnswer, DnsReadProvider } from '@/providers/types'
import { DNS_RECORD_TYPES, type DnsRecord, type DnsRecordType } from '@/schemas/dns'
import {
  DnsResultCache,
  isPublicDnsAddress,
  queryDnsRecords,
} from '@/services/dns/query-dns-records'

const observedAt = '2026-08-05T12:00:00.000Z'
const traceId = 'trace-dns-service'
const cacheConfig = {
  maxEntries: 4_096,
  maxNegativeTtlMs: 30_000,
  maxPositiveTtlMs: 60_000,
  maxTargets: 16,
}

function record(type: DnsRecordType, target = 'target.example.test'): DnsRecord {
  const base = { ownerName: 'example.test', ttl: 60, type }
  if (type === 'A') return { ...base, address: '93.184.216.34', type }
  if (type === 'AAAA') return { ...base, address: '2606:2800:220:1:248:1893:25c8:1946', type }
  if (type === 'CNAME') return { ...base, target, type }
  if (type === 'MX') return { ...base, exchange: target, priority: 10, type }
  if (type === 'TXT') return { ...base, type, value: 'v=spf1 ~all' }
  if (type === 'NS') return { ...base, host: target, type }
  if (type === 'SOA') {
    return {
      ...base,
      expire: 604_800,
      minimum: 300,
      primaryNameServer: target,
      refresh: 3_600,
      responsibleMailbox: 'hostmaster.example.test',
      retry: 600,
      serial: 2_026_080_501,
      type,
    }
  }
  return { ...base, flags: 0, tag: 'issue', type, value: 'letsencrypt.org' }
}

function success(
  type: DnsRecordType,
  options: {
    fallbackUsed?: boolean
    records?: DnsRecord[]
    status?: DnsProviderAnswer['status']
  } = {},
): ProviderResult<DnsProviderAnswer> {
  const status = options.status ?? 'records'
  return {
    cache: { status: 'miss' },
    data: {
      fallbackUsed: options.fallbackUsed ?? false,
      ...(status === 'no_record' || status === 'nxdomain' ? { negativeTtlSeconds: 30 } : {}),
      records: options.records ?? (status === 'records' ? [record(type)] : []),
      resolverNode: options.fallbackUsed ? 'alidns_secondary' : 'alidns_primary',
      status,
    },
    observedAt,
    ok: true,
    requestId: `dns-${type}`,
  }
}

function failed(code: string): ProviderResult<DnsProviderAnswer> {
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message: code === 'DNS_TIMEOUT' ? 'DNS 查询超时' : 'DNS 查询失败',
      retryable: true,
      statusKnown: false,
    },
    observedAt,
    ok: false,
    requestId: 'dns-failed',
  }
}

function provider(
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

function options(dns: DnsReadProvider, now = () => Date.parse(observedAt)) {
  return {
    cache: new DnsResultCache(cacheConfig.maxEntries, now),
    cacheConfig,
    now,
    provider: dns,
    traceId,
  }
}

describe('DNS orchestration and SSRF controls', () => {
  it('returns all eight typed record sets after public target validation', async () => {
    const dns = provider(({ domainAscii, recordType }) => {
      if (domainAscii !== 'example.test') {
        return recordType === 'A'
          ? success('A', { records: [{ ...record('A'), ownerName: domainAscii }] })
          : success('AAAA', { status: 'no_record' })
      }
      return success(recordType)
    })
    const result = await queryDnsRecords({ query: ' EXAMPLE.TEST. ' }, options(dns))
    expect(result).toMatchObject({
      data: {
        normalizedQueryAscii: 'example.test',
        recordSets: DNS_RECORD_TYPES.map((type) => ({ status: 'records', type })),
      },
      meta: { cacheStatus: 'miss', dataSource: '阿里公共 DNS（受控 DoH）' },
      state: 'ready',
    })
    expect(dns.queryRecordSet).toHaveBeenCalledWith({
      domainAscii: 'target.example.test',
      recordType: 'A',
      traceId,
    })
  })

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.100.100.200',
    '168.63.129.16',
    '192.0.2.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:93.184.216.34',
  ])('blocks direct restricted address %s without exposing it', async (address) => {
    const type: DnsRecordType = address.includes(':') ? 'AAAA' : 'A'
    const dns = provider(({ recordType }) => {
      if (recordType === type) {
        const restrictedRecord: DnsRecord =
          type === 'AAAA'
            ? { address, ownerName: 'example.test', ttl: 60, type: 'AAAA' }
            : { address, ownerName: 'example.test', ttl: 60, type: 'A' }
        return success(type, { records: [restrictedRecord] })
      }
      return success(recordType, { status: 'no_record' })
    })
    const result = await queryDnsRecords({ query: 'example.test' }, options(dns))
    expect(result.state).toBe('partial')
    if (!('data' in result)) throw new Error('expected partial data')
    expect(result.data.recordSets.find((set) => set.type === type)).toMatchObject({
      issue: { code: 'DNS_TARGET_BLOCKED' },
      records: [],
      status: 'blocked',
    })
    expect(JSON.stringify(result)).not.toContain(address)
  })

  it.each(
    (['CNAME', 'MX', 'NS', 'SOA'] as const).flatMap((targetType) =>
      [
        '127.0.0.1',
        '10.10.10.10',
        '169.254.169.254',
        '100.100.100.200',
        '168.63.129.16',
        '::1',
        'fc00::1',
        'fe80::1',
        '::ffff:127.0.0.1',
        '::ffff:93.184.216.34',
      ].map((address) => [targetType, address] as const),
    ),
  )(
    'fails closed when a %s target resolves to restricted address %s',
    async (targetType, address) => {
      const addressType = address.includes(':') ? 'AAAA' : 'A'
      const dns = provider(({ domainAscii, recordType }) => {
        if (domainAscii === 'restricted-target.example.test' && recordType === addressType) {
          return success(addressType, {
            records: [
              addressType === 'AAAA'
                ? { address, ownerName: domainAscii, ttl: 60, type: 'AAAA' }
                : { address, ownerName: domainAscii, ttl: 60, type: 'A' },
            ],
          })
        }
        if (domainAscii !== 'example.test') return success(recordType, { status: 'no_record' })
        if (recordType === targetType) {
          return success(recordType, {
            records: [record(recordType, 'restricted-target.example.test')],
          })
        }
        return success(recordType, { status: 'no_record' })
      })
      const result = await queryDnsRecords({ query: 'example.test' }, options(dns))
      expect(result.state).toBe('partial')
      if (!('data' in result)) throw new Error('expected partial data')
      expect(result.data.recordSets.find((set) => set.type === targetType)).toMatchObject({
        issue: { code: 'DNS_TARGET_VALIDATION_FAILED' },
        records: [],
        status: 'blocked',
      })
      expect(JSON.stringify(result)).not.toContain(address)
    },
  )

  it('distinguishes NXDOMAIN, no record, SERVFAIL, timeout and queue saturation states', async () => {
    const nxdomainProvider = provider(({ recordType }) =>
      success(recordType, { status: 'nxdomain' }),
    )
    const nxdomain = await queryDnsRecords(
      { query: 'missing.example.test' },
      options(nxdomainProvider),
    )
    expect(nxdomain.state).toBe('empty')
    expect(JSON.stringify(nxdomain)).not.toMatch(/available|register|purchase/i)

    const noRecordProvider = provider(({ recordType }) =>
      success(recordType, { status: 'no_record' }),
    )
    expect(
      (await queryDnsRecords({ query: 'empty.example.test' }, options(noRecordProvider))).state,
    ).toBe('empty')

    const servfailProvider = provider(({ recordType }) =>
      success(recordType, { status: 'servfail' }),
    )
    const servfail = await queryDnsRecords(
      { query: 'servfail.example.test' },
      options(servfailProvider),
    )
    expect(servfail).toMatchObject({ problem: { code: 'DNS_SERVFAIL' }, state: 'error' })

    const partialTimeoutProvider = provider(({ recordType }) => {
      if (recordType === 'A') return success('A')
      if (recordType === 'AAAA') return failed('DNS_TIMEOUT')
      return success(recordType, { status: 'no_record' })
    })
    const partialTimeout = await queryDnsRecords(
      { query: 'partial-timeout.example.test' },
      options(partialTimeoutProvider),
    )
    expect(partialTimeout).toMatchObject({
      data: {
        recordSets: expect.arrayContaining([
          expect.objectContaining({ records: expect.any(Array), status: 'records', type: 'A' }),
          expect.objectContaining({
            issue: { code: 'DNS_TIMEOUT', message: 'DNS 查询超时', retryable: true },
            records: [],
            status: 'timeout',
            type: 'AAAA',
          }),
        ]),
      },
      problem: {
        action: '请稍后重试',
        detail: '部分 DNS 记录类型未能完成查询，其余结果仍可查看',
      },
      state: 'partial',
    })

    const timeoutProvider = provider(() => failed('DNS_TIMEOUT'))
    const timeout = await queryDnsRecords(
      { query: 'timeout.example.test' },
      options(timeoutProvider),
    )
    expect(timeout).toMatchObject({
      problem: {
        action: '请稍后重试',
        code: 'DNS_TIMEOUT',
        detail: 'DNS 查询超时',
        retryable: true,
      },
      state: 'error',
    })
    expect(timeout).not.toHaveProperty('data')
    expect(JSON.stringify(timeout)).not.toMatch(/available|purchase/iu)

    const saturatedProvider = provider(() => failed('DNS_QUEUE_FULL'))
    const saturated = await queryDnsRecords(
      { query: 'busy.example.test' },
      options(saturatedProvider),
    )
    expect(saturated).toMatchObject({
      problem: {
        action: '请稍后重试',
        code: 'DNS_RATE_LIMITED',
        detail: '当前 DNS 查询请求较多，请稍后重试',
        status: 429,
      },
      state: 'rate_limited',
    })
    expect(saturated).not.toHaveProperty('data')
  })

  it('returns degraded for secondary-node data and bounded cache hits on repeat lookup', async () => {
    const dns = provider(({ recordType }) =>
      recordType === 'A'
        ? success('A', { fallbackUsed: true })
        : success(recordType, { fallbackUsed: true, status: 'no_record' }),
    )
    const cache = new DnsResultCache(cacheConfig.maxEntries, () => Date.parse(observedAt))
    const queryOptions = { ...options(dns), cache }
    const first = await queryDnsRecords({ query: 'example.test' }, queryOptions)
    const callsAfterFirst = dns.queryRecordSet.mock.calls.length
    const second = await queryDnsRecords({ query: 'example.test' }, queryOptions)
    expect(first).toMatchObject({ problem: { code: 'DNS_FALLBACK_USED' }, state: 'degraded' })
    expect(second).toMatchObject({ meta: { cacheStatus: 'hit' }, state: 'degraded' })
    expect(dns.queryRecordSet).toHaveBeenCalledTimes(callsAfterFirst)
  })

  it('blocks target validation above 16 unique hosts before resolving any target', async () => {
    const dns = provider(({ domainAscii, recordType }) => {
      if (domainAscii !== 'example.test') return success(recordType, { status: 'no_record' })
      if (recordType !== 'MX') return success(recordType, { status: 'no_record' })
      return success('MX', {
        records: Array.from({ length: 17 }, (_, index) => ({
          exchange: `mail-${index}.example.test`,
          ownerName: 'example.test',
          priority: index,
          ttl: 60,
          type: 'MX' as const,
        })),
      })
    })
    const result = await queryDnsRecords({ query: 'example.test' }, options(dns))
    expect(result.state).toBe('partial')
    if (!('data' in result)) throw new Error('expected partial data')
    expect(result.data.recordSets.find((set) => set.type === 'MX')).toMatchObject({
      issue: { code: 'DNS_TARGET_LIMIT_EXCEEDED' },
      records: [],
      status: 'blocked',
    })
    expect(
      dns.queryRecordSet.mock.calls.filter(([input]) => input.domainAscii !== 'example.test'),
    ).toHaveLength(0)
  })

  it('returns an error without data when the combined record limit exceeds 128', async () => {
    const dns = provider(({ domainAscii, recordType }) => {
      if (domainAscii === 'target.example.test') {
        return recordType === 'A' ? success('A') : success(recordType, { status: 'no_record' })
      }
      if (
        recordType === 'A' ||
        recordType === 'AAAA' ||
        recordType === 'TXT' ||
        recordType === 'CAA'
      ) {
        return success(recordType, {
          records: Array.from({ length: 32 }, () => record(recordType)),
        })
      }
      if (recordType === 'CNAME') return success('CNAME')
      return success(recordType, { status: 'no_record' })
    })
    const result = await queryDnsRecords({ query: 'example.test' }, options(dns))
    expect(result).toMatchObject({
      problem: { code: 'DNS_RECORD_LIMIT_EXCEEDED' },
      state: 'error',
    })
    expect(result).not.toHaveProperty('data')
  })

  it('rejects IP, local, metadata, URL and single-label input before provider access', async () => {
    const dns = provider(({ recordType }) => success(recordType))
    for (const query of [
      '127.0.0.1',
      'metadata.google.internal',
      'service.localhost',
      'https://example.test',
      'example.test:53',
      'localhost',
    ]) {
      await expect(queryDnsRecords({ query }, options(dns))).rejects.toBeDefined()
    }
    expect(dns.queryRecordSet).not.toHaveBeenCalled()
  })

  it('classifies only globally routable unicast addresses as public', () => {
    expect(isPublicDnsAddress('93.184.216.34')).toBe(true)
    expect(isPublicDnsAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
    expect(isPublicDnsAddress('100.100.100.200')).toBe(false)
    expect(isPublicDnsAddress('168.63.129.16')).toBe(false)
    expect(isPublicDnsAddress('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicDnsAddress('::ffff:93.184.216.34')).toBe(false)
  })
})
