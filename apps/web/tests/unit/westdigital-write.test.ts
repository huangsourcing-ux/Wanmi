import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetEnvForTests } from '@/lib/env'
import {
  createConfiguredWestDigitalWriteAdapter,
  FixtureWestDigitalWriteTransport,
} from '@/providers/westdigital-write-fixtures'
import { WestDigitalWriteAdapter } from '@/providers/westdigital-write'

import { realnameTemplateFixture } from '../fixtures/realname'

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
})

describe('WestDigital write adapter fixtures', () => {
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

    expect(transport.requests.map(({ body, operation, path }) => ({ act: body.act, operation, path }))).toEqual([
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

  it('never constructs a live runtime transport', () => {
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'false')
    resetEnvForTests()
    expect(createConfiguredWestDigitalWriteAdapter()).toBeInstanceOf(WestDigitalWriteAdapter)

    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    resetEnvForTests()
    expect(() => createConfiguredWestDigitalWriteAdapter()).toThrow(/真实西部数码写 transport 未提供/u)
  })
})
