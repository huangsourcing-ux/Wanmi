import { describe, expect, it } from 'vitest'

import { DnsRecordChanges } from '@/collections/dns-management'
import { westDigitalDnsLineCode, westDigitalDnsLineLabel } from '@/providers/westdigital-dns'
import {
  dnsRecordAddRequestSchema,
  dnsRecordBatchDeleteRequestSchema,
  dnsRecordDeleteRequestSchema,
  dnsRecordModifyRequestSchema,
  dnsRecordStatusRequestSchema,
  managedDnsRecordTypeSchema,
  westDigitalDnsLineCodeSchema,
  westDigitalDnsLineLabelSchema,
} from '@/schemas/dns-management'
import { generateWestDigitalDnsBusinessOperationKey } from '@/services/providers/westdigital-operations'

describe('D9-D-1 DNS management contract', () => {
  it('uses exactly the record types documented for the single-record West Digital API', () => {
    expect(managedDnsRecordTypeSchema.options).toEqual(['A', 'CNAME', 'MX', 'TXT', 'AAAA', 'SRV'])
    for (const excluded of ['NS', 'DS', 'DNSSEC', 'DDNS', 'MAIL']) {
      expect(managedDnsRecordTypeSchema.safeParse(excluded).success, excluded).toBe(false)
    }
  })

  it('maps every documented Chinese line and alias to the exact internal code', () => {
    expect(westDigitalDnsLineLabelSchema.options).toEqual([
      '默认',
      '电信',
      '联通',
      '移动',
      '教育',
      '教育网',
      'SEO',
      '搜索引擎',
      '境外',
    ])
    expect(
      Object.fromEntries(
        westDigitalDnsLineLabelSchema.options.map((label) => [
          label,
          westDigitalDnsLineCode(label),
        ]),
      ),
    ).toEqual({
      SEO: 'LSEO',
      境外: 'LFOR',
      搜索引擎: 'LSEO',
      教育: 'LEDU',
      教育网: 'LEDU',
      默认: '',
      电信: 'LTEL',
      移动: 'LMOB',
      联通: 'LCNC',
    })
    expect(
      Object.fromEntries(
        westDigitalDnsLineCodeSchema.options.map((code) => [code, westDigitalDnsLineLabel(code)]),
      ),
    ).toEqual({
      '': '默认',
      LCNC: '联通',
      LEDU: '教育网',
      LFOR: '境外',
      LMOB: '移动',
      LSEO: '搜索引擎',
      LTEL: '电信',
    })
  })

  it('keeps provider bounds, defaults, root normalization, and strict request fields', () => {
    expect(
      dnsRecordAddRequestSchema.parse({
        host: '',
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        type: 'A',
        value: '203.0.113.7',
      }),
    ).toMatchObject({ host: '@', line: '默认', priority: 10, ttl: 900 })
    expect(
      dnsRecordAddRequestSchema.safeParse({
        host: 'www',
        idempotencyKey: '00000000-0000-4000-8000-000000000002',
        ttl: 59,
        type: 'A',
        value: '203.0.113.7',
      }).success,
    ).toBe(false)
    expect(
      dnsRecordAddRequestSchema.safeParse({
        host: 'www',
        idempotencyKey: '00000000-0000-4000-8000-000000000003',
        type: 'A',
        unexpected: true,
        value: '203.0.113.7',
      }).success,
    ).toBe(false)
  })

  it('requires a bound preview token and at least two ids for batch deletion', () => {
    expect(
      dnsRecordBatchDeleteRequestSchema.safeParse({
        previewToken: 'x'.repeat(80),
        recordIds: ['1'],
      }).success,
    ).toBe(false)
    expect(
      dnsRecordBatchDeleteRequestSchema.safeParse({
        previewToken: 'x'.repeat(80),
        recordIds: ['1', '2'],
      }).success,
    ).toBe(true)
  })

  it('requires a UUID business key independently on every single-record write schema', () => {
    const valid = '00000000-0000-4000-8000-000000000004'
    const cases = [
      [dnsRecordAddRequestSchema, { host: 'www', type: 'A', value: '192.0.2.1' }],
      [dnsRecordModifyRequestSchema, { priority: 10, ttl: 600, value: '192.0.2.2' }],
      [dnsRecordDeleteRequestSchema, {}],
      [dnsRecordStatusRequestSchema, { paused: true }],
    ] as const
    for (const [schema, value] of cases) {
      expect(schema.safeParse({ ...value, idempotencyKey: valid }).success).toBe(true)
      expect(schema.safeParse(value).success).toBe(false)
      expect(schema.safeParse({ ...value, idempotencyKey: 'not-a-uuid' }).success).toBe(false)
    }
  })

  it('binds DNS provider-operation keys to business key, operation, and domain asset', () => {
    const base = {
      businessKey: '00000000-0000-4000-8000-000000000005',
      operation: 'dns_record_add' as const,
      targetId: 7,
    }
    const keys = [
      generateWestDigitalDnsBusinessOperationKey(base),
      generateWestDigitalDnsBusinessOperationKey({
        ...base,
        businessKey: '00000000-0000-4000-8000-000000000006',
      }),
      generateWestDigitalDnsBusinessOperationKey({ ...base, operation: 'dns_record_delete' }),
      generateWestDigitalDnsBusinessOperationKey({ ...base, targetId: 8 }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps DNS change records append-only even for system override calls', () => {
    const beforeChange = DnsRecordChanges.hooks?.beforeChange?.[0]
    const beforeDelete = DnsRecordChanges.hooks?.beforeDelete?.[0]
    expect(beforeChange).toBeTypeOf('function')
    expect(beforeDelete).toBeTypeOf('function')
    expect(() => beforeChange?.({ operation: 'update' } as never)).toThrow(
      'DNS 解析变更记录只允许追加',
    )
    expect(() => beforeDelete?.({} as never)).toThrow('DNS 解析变更记录只允许追加')
    expect(beforeChange?.({ operation: 'create' } as never)).toBeUndefined()
  })
})
