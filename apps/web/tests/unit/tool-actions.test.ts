import { describe, expect, it } from 'vitest'

import {
  buildShareUrl,
  buildToolHref,
  formatAvailabilityRecord,
  formatCaaRecord,
  formatCertificateRecord,
  formatDnsRecord,
  formatPricingRecord,
  formatSanRecord,
  formatTlsConnection,
  formatWhoisField,
  normalizeDomainForClipboard,
} from '@/lib/tool-actions'
import { PUBLIC_TOOL_DEFINITIONS } from '@/lib/site-config'
import type { DomainSearchItem } from '@/schemas/domain-search'
import type { PricingItem } from '@/schemas/pricing'
import type { TlsCertificate, TlsInspection } from '@/schemas/tls'

describe('D2-10 safe tool links and clipboard formats', () => {
  it('builds all six clean entries and only adds Punycode q to query tools', () => {
    const expectedCleanPaths = [
      '/tools/domain-search',
      '/tools/whois',
      '/tools/dns',
      '/tools/ssl-check',
      '/tools/idn',
      '/pricing',
    ]
    expect(PUBLIC_TOOL_DEFINITIONS.map((tool) => buildToolHref(tool.slug))).toEqual(
      expectedCleanPaths,
    )
    expect(PUBLIC_TOOL_DEFINITIONS.map((tool) => buildToolHref(tool.slug, '例子.中国'))).toEqual([
      '/tools/domain-search?q=xn--fsqu00a.xn--fiqs8s',
      '/tools/whois?q=xn--fsqu00a.xn--fiqs8s',
      '/tools/dns?q=xn--fsqu00a.xn--fiqs8s',
      '/tools/ssl-check?q=xn--fsqu00a.xn--fiqs8s',
      '/tools/idn?q=xn--fsqu00a.xn--fiqs8s',
      '/pricing',
    ])
    expect(buildToolHref('whois', 'keyword')).toBe('/tools/whois')
  })

  it('constructs share URLs from an allowlist and discards every current-path identifier', () => {
    const originWithNoise =
      'https://wanmi.net/current/result?traceId=trace-secret&requestId=req-secret&cacheKey=cache-secret'

    expect(buildShareUrl({ includeDomain: false, origin: originWithNoise, tool: 'whois' })).toBe(
      'https://wanmi.net/tools/whois',
    )
    expect(
      buildShareUrl({
        domain: '例子.中国',
        includeDomain: true,
        origin: originWithNoise,
        tool: 'whois',
      }),
    ).toBe('https://wanmi.net/tools/whois?q=xn--fsqu00a.xn--fiqs8s')
    expect(
      buildShareUrl({
        domain: '例子.中国',
        includeDomain: true,
        origin: originWithNoise,
        tool: 'pricing',
      }),
    ).toBe('https://wanmi.net/pricing')
    expect(() =>
      buildShareUrl({ includeDomain: false, origin: 'javascript:alert(1)', tool: 'dns' }),
    ).toThrow(/HTTP or HTTPS/u)
    expect(() =>
      buildShareUrl({
        domain: 'keyword',
        includeDomain: true,
        origin: 'https://wanmi.net',
        tool: 'dns',
      }),
    ).toThrow(/valid full domain/u)
  })

  it('normalizes domain-bearing clipboard values and formats availability and WHOIS records', () => {
    expect(normalizeDomainForClipboard('*.例子.中国.')).toBe('*.xn--fsqu00a.xn--fiqs8s')

    const availability = {
      cache: { status: 'miss' },
      dataSource: 'Wanmi fixture',
      domainAscii: 'xn--fsqu00a.xn--fiqs8s',
      domainUnicode: '例子.中国',
      observedAt: '2026-08-06T00:00:00.000Z',
      status: 'registered',
      tld: 'xn--fiqs8s',
    } satisfies DomainSearchItem
    expect(formatAvailabilityRecord(availability)).toBe('xn--fsqu00a.xn--fiqs8s\t已注册')
    expect(formatWhoisField('Name Server', '例子.中国.', true)).toBe(
      'Name Server\txn--fsqu00a.xn--fiqs8s',
    )
  })

  it('uses deterministic zone-style DNS and CAA records with Punycode names', () => {
    expect(
      formatDnsRecord({
        ownerName: '例子.测试',
        target: '别名.测试',
        ttl: 300,
        type: 'CNAME',
      }),
    ).toBe('xn--fsqu00a.xn--0zwm56d 300 IN CNAME xn--mcrt9b.xn--0zwm56d')
    expect(
      formatDnsRecord({
        ownerName: '例子.测试',
        ttl: 60,
        type: 'TXT',
        value: '说明文本',
      }),
    ).toBe('xn--fsqu00a.xn--0zwm56d 60 IN TXT "说明文本"')
    expect(
      formatCaaRecord({
        critical: false,
        explanation: '测试',
        flags: 0,
        ownerName: '例子.测试',
        tag: 'issue',
        ttl: 300,
        value: '颁发者.测试; validationmethods=dns-01',
      }),
    ).toBe(
      'xn--fsqu00a.xn--0zwm56d 300 IN CAA 0 issue "xn--oorq24hhmp.xn--0zwm56d; validationmethods=dns-01"',
    )
    expect(
      formatCaaRecord({
        critical: false,
        explanation: '测试',
        flags: 0,
        ownerName: '例子.测试',
        tag: 'iodef',
        ttl: 300,
        value: 'mailto:security@例子.测试',
      }),
    ).toBe('xn--fsqu00a.xn--0zwm56d 300 IN CAA 0 iodef "mailto:security@xn--fsqu00a.xn--0zwm56d"')
  })

  it('copies public price and TLS records without runtime identifiers', () => {
    const pricing = {
      cache: { expiresAt: '2026-08-06T01:00:00.000Z', status: 'miss' },
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      currency: 'CNY',
      dataSource: 'Wanmi fixture',
      markupConfigured: true,
      minimumRegistrationYears: 1,
      observedAt: '2026-08-06T00:00:00.000Z',
      oneYearTotalFen: 1_000,
      priceClass: 'standard',
      purchaseBlockCode: 'PURCHASE_NOT_IMPLEMENTED',
      purchaseEligible: false,
      registrationPriceFen: 1_000,
      renewalPriceFen: 1_200,
      snapshotRef: '97168f2d-b28e-4dd2-b0ce-f58d16e2fd0e',
      status: 'priced',
      threeYearTotalFen: 3_400,
      tld: 'com',
    } satisfies PricingItem
    const copiedPrice = formatPricingRecord(pricing)
    expect(copiedPrice).toContain('.com\t价格可追溯\t注册价 ¥10.00')
    expect(copiedPrice).not.toContain(pricing.snapshotRef)

    const certificate: TlsCertificate = {
      chain: {
        certificates: [
          {
            fingerprint256: 'AA:BB',
            issuer: { commonName: '签发者.测试', organization: null },
            subject: { commonName: '例子.测试', organization: null },
            validFrom: '2026-08-01T00:00:00.000Z',
            validTo: '2026-09-01T00:00:00.000Z',
          },
        ],
        depth: 1,
        status: 'trusted',
        truncated: false,
      },
      daysRemaining: 26,
      hostnameMatch: true,
      issuer: { commonName: '签发者.测试', organization: null },
      sanCount: 1,
      sanTruncated: false,
      subject: { commonName: '例子.测试', organization: null },
      subjectAlternativeNames: ['*.例子.测试'],
      validFrom: '2026-08-01T00:00:00.000Z',
      validityStatus: 'valid',
      validTo: '2026-09-01T00:00:00.000Z',
    }
    expect(formatCertificateRecord(certificate)).toContain('主题 xn--fsqu00a.xn--0zwm56d')
    expect(formatSanRecord('*.例子.测试')).toBe('SAN\t*.xn--fsqu00a.xn--0zwm56d')

    const tls = {
      certificate,
      cipherSuite: 'TLS_AES_256_GCM_SHA384',
      findings: [],
      port: 443,
      protocol: 'TLSv1.3',
      source: {
        cacheStatus: 'miss',
        dataSource: 'direct TLS',
        observedAt: '2026-08-06T00:00:00.000Z',
      },
      status: 'connected',
    } satisfies TlsInspection
    expect(formatTlsConnection(tls)).toBe('TLS 连接\tTLSv1.3\tTLS_AES_256_GCM_SHA384\t端口 443')
  })
})
