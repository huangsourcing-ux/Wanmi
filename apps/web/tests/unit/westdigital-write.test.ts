import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetEnvForTests } from '@/lib/env'
import {
  createConfiguredWestDigitalWriteAdapter,
  FixtureWestDigitalWriteTransport,
} from '@/providers/westdigital-write-fixtures'
import { encodeWestDigitalForm } from '@/providers/westdigital-http'
import { WestDigitalWriteAdapter } from '@/providers/westdigital-write'

import { realnameTemplateFixture } from '../fixtures/realname'

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
})

describe('WestDigital write adapter fixtures', () => {
  it('encodes documented real-name form fields as GB2312-compatible bytes', () => {
    expect(encodeWestDigitalForm({ act: 'auditsub', fullname: '李小明' }).toString('ascii')).toBe(
      'act=auditsub&fullname=%C0%EE%D0%A1%C3%F7',
    )
  })

  it('maps documented real-name, registration, renewal, asset and name-server contracts', async () => {
    const transport = new FixtureWestDigitalWriteTransport()
    const provider = new WestDigitalWriteAdapter({
      requestIdFactory: (() => {
        let value = 0
        return () => `west-write-${++value}`
      })(),
      transport,
    })

    const created = await provider.createRealname({
      profile: realnameTemplateFixture(),
      traceId: 'trace-west-write-realname',
    })
    expect(created).toMatchObject({
      data: { providerTemplateId: '1664777', state: 'accepted' },
      ok: true,
    })
    const template = await provider.queryRealname({
      providerTemplateId: '1664777',
      traceId: 'trace-west-query-realname',
    })
    expect(template).toMatchObject({ data: { reviewState: 'pending' }, ok: true })

    await expect(
      provider.register({
        clientPriceFen: 2_999,
        domainAscii: 'wanmi-test.com',
        nameservers: ['ns1.example.com', 'ns2.example.com'],
        premium: false,
        providerTemplateId: '1664777',
        traceId: 'trace-west-register',
        years: 1,
      }),
    ).resolves.toMatchObject({ data: { state: 'accepted' }, ok: true })
    await expect(
      provider.renew({
        clientPriceFen: 3_500,
        currentExpiresOn: '2026-08-08',
        domainAscii: 'wanmi-test.com',
        premium: false,
        traceId: 'trace-west-renew',
        years: 1,
      }),
    ).resolves.toMatchObject({ data: { state: 'accepted' }, ok: true })
    await expect(
      provider.changeNameservers({
        domainAscii: 'wanmi-test.com',
        nameservers: ['ns1.example.com', 'ns2.example.com'],
        traceId: 'trace-west-nameserver',
      }),
    ).resolves.toMatchObject({ data: { state: 'accepted' }, ok: true })
    await expect(
      provider.queryAsset({ domainAscii: 'wanmi-test.com', traceId: 'trace-west-asset' }),
    ).resolves.toMatchObject({
      data: {
        domainAscii: 'wanmi-test.com',
        nameservers: ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'],
        providerAssetId: '44169980',
      },
      ok: true,
    })

    expect(
      transport.requests.map(({ body, operation, path }) => ({ act: body.act, operation, path })),
    ).toEqual([
      { act: 'auditsub', operation: 'realname_create', path: '/v2/audit/' },
      { act: 'auditinfo', operation: 'realname_query', path: '/v2/audit/' },
      { act: 'regdomain', operation: 'register', path: '/v2/audit/' },
      { act: 'renew', operation: 'renew', path: '/v2/domain/' },
      { act: 'moddns', operation: 'nameserver', path: '/v2/domain/' },
      { act: 'view', operation: 'asset_query', path: '/v2/domain/' },
    ])
    expect(transport.requests[2]?.body).toMatchObject({
      client_price: '29.99',
      c_sysid: '1664777',
      dns_host1: 'ns1.example.com',
      dns_host2: 'ns2.example.com',
    })
    expect(transport.requests[3]?.body).toMatchObject({
      client_price: '35.00',
      expiredate: '2026-08-08',
    })
  })

  it('maps the registrar field observed in the real domain-detail response', async () => {
    const transport = {
      execute: vi.fn().mockResolvedValue({
        body: {
          clientid: 'fixture-client',
          data: {
            bizcnorder: 'observed-registrar',
            dns1: 'ns1.example.com',
            dns2: 'ns2.example.com',
            dns3: '',
            dns4: '',
            dns5: '',
            dns6: '',
            domain: 'wanmi-test.com',
            expdate: '2027-08-08 12:00:00',
            id: '44169980',
            proid: 'fixture-product',
            regdate: '2026-08-08 12:00:00',
          },
          result: 200,
        },
        status: 200,
      }),
    }
    const provider = new WestDigitalWriteAdapter({ transport })

    await expect(
      provider.queryAsset({ domainAscii: 'wanmi-test.com', traceId: 'trace-real-semantics' }),
    ).resolves.toMatchObject({
      data: { registrarCode: 'observed-registrar' },
      ok: true,
    })
  })

  it('maps the documented DNS record query and write contracts, including pause 1 and resume 0', async () => {
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      const clientid = `fixture-${input.requestId}`
      if (input.operation === 'dns_record_add') {
        return { body: { clientid, data: { id: 701 }, result: 200 }, status: 200 }
      }
      if (input.operation === 'dns_record_query') {
        return {
          body: {
            clientid,
            data: {
              items: [
                {
                  id: 701,
                  item: 'www',
                  level: 10,
                  line: 'LTEL',
                  pause: 1,
                  ttl: 600,
                  type: 'A',
                  value: '192.0.2.10',
                },
              ],
              limit: 20,
              pagecount: 1,
              pageno: 1,
              total: 1,
            },
            result: 200,
          },
          status: 200,
        }
      }
      return { body: { clientid, result: 200 }, status: 200 }
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    const record = {
      host: 'www',
      lineCode: 'LTEL' as const,
      priority: 10,
      ttl: 600,
      type: 'A' as const,
      value: '192.0.2.10',
    }

    await expect(
      provider.addDnsRecord({
        domainAscii: 'wanmi-test.com',
        record,
        traceId: 'trace-dns-add',
      }),
    ).resolves.toMatchObject({ data: { providerRecordId: '701', state: 'accepted' }, ok: true })
    await expect(
      provider.modifyDnsRecord({
        domainAscii: 'wanmi-test.com',
        providerRecordId: '701',
        record: { ...record, value: '192.0.2.11' },
        traceId: 'trace-dns-modify',
      }),
    ).resolves.toMatchObject({ data: { state: 'accepted' }, ok: true })
    await expect(
      provider.deleteDnsRecord({
        domainAscii: 'wanmi-test.com',
        providerRecordId: '701',
        record,
        traceId: 'trace-dns-delete',
      }),
    ).resolves.toMatchObject({ data: { state: 'accepted' }, ok: true })
    await expect(
      provider.setDnsRecordPaused({
        domainAscii: 'wanmi-test.com',
        paused: true,
        providerRecordId: '701',
        traceId: 'trace-dns-pause',
      }),
    ).resolves.toMatchObject({ data: { state: 'accepted' }, ok: true })
    await expect(
      provider.setDnsRecordPaused({
        domainAscii: 'wanmi-test.com',
        paused: false,
        providerRecordId: '701',
        traceId: 'trace-dns-resume',
      }),
    ).resolves.toMatchObject({ data: { state: 'accepted' }, ok: true })
    await expect(
      provider.queryDnsRecords({
        domainAscii: 'wanmi-test.com',
        host: 'www',
        limit: 20,
        page: 1,
        traceId: 'trace-dns-query',
        type: 'A',
        value: '192.0.2.10',
      }),
    ).resolves.toMatchObject({
      data: {
        items: [
          {
            host: 'www',
            id: '701',
            lineCode: 'LTEL',
            paused: true,
            priority: 10,
            ttl: 600,
            type: 'A',
            value: '192.0.2.10',
          },
        ],
      },
      ok: true,
    })

    expect(transport.requests.map(({ body }) => body)).toEqual([
      {
        act: 'adddnsrecord',
        domain: 'wanmi-test.com',
        host: 'www',
        level: '10',
        line: 'LTEL',
        ttl: '600',
        type: 'A',
        value: '192.0.2.10',
      },
      {
        act: 'moddnsrecord',
        domain: 'wanmi-test.com',
        host: 'www',
        id: '701',
        level: '10',
        line: 'LTEL',
        ttl: '600',
        type: 'A',
        value: '192.0.2.11',
      },
      {
        act: 'deldnsrecord',
        domain: 'wanmi-test.com',
        host: 'www',
        id: '701',
        line: 'LTEL',
        type: 'A',
        value: '192.0.2.10',
      },
      { act: 'pause', domain: 'wanmi-test.com', id: '701', val: '1' },
      { act: 'pause', domain: 'wanmi-test.com', id: '701', val: '0' },
      {
        act: 'getdnsrecord',
        domain: 'wanmi-test.com',
        host: 'www',
        limit: '20',
        pageno: '1',
        type: 'A',
        value: '192.0.2.10',
      },
    ])
    expect(transport.writeCount).toBe(5)
  })

  it('never constructs a live runtime transport', () => {
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'false')
    vi.stubEnv('WESTDIGITAL_MODE', 'fixture')
    resetEnvForTests()
    expect(createConfiguredWestDigitalWriteAdapter()).toBeInstanceOf(WestDigitalWriteAdapter)

    const liveTransportFactory = vi.fn()
    vi.stubEnv('CI', 'false')
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL', 'true')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL_READS', 'true')
    vi.stubEnv('WESTDIGITAL_MODE', 'live')
    resetEnvForTests()
    expect(() => createConfiguredWestDigitalWriteAdapter({ liveTransportFactory })).toThrow(
      /tests must never construct a live westdigital runtime transport/iu,
    )
    expect(liveTransportFactory).not.toHaveBeenCalled()
  })
})
