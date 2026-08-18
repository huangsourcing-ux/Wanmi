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

  it('maps documented V2 offline DNS deletion submission and task queries without treating acceptance as success', async () => {
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      const clientid = `fixture-${input.requestId}`
      if (input.operation === 'offline_dns_record_delete_submit') {
        return {
          body: { clientid, code: 200, data: { task_sku: 'TASK-DNS-DELETE-1' }, msg: '成功' },
          status: 200,
        }
      }
      if (input.operation === 'offline_task_list') {
        return {
          body: {
            clientid,
            code: 200,
            data: {
              data: [
                {
                  task_act: 'dodelreall',
                  task_sku: 'TASK-DNS-DELETE-1',
                  task_state: 1,
                  task_type: 'dns_record',
                },
              ],
            },
            msg: '成功',
          },
          status: 200,
        }
      }
      return {
        body: {
          clientid,
          code: 200,
          data: {
            data: [
              {
                act: 'dodelreall',
                record_ident: 'wanmi-test.com',
                record_result: '队列中',
                record_state: 6,
              },
            ],
          },
          msg: '成功',
        },
        status: 200,
      }
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    const submitted = await provider.submitOfflineDnsRecordDelete({
      domainAscii: 'wanmi-test.com',
      record: {
        host: 'www',
        lineCode: 'LTEL',
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.10',
      },
      traceId: 'trace-offline-submit',
    })
    expect(submitted).toMatchObject({
      data: { providerTaskKey: 'TASK-DNS-DELETE-1', state: 'accepted' },
      ok: true,
    })
    await expect(
      provider.queryOfflineDnsRecordDelete({
        domainAscii: 'wanmi-test.com',
        providerTaskKey: 'TASK-DNS-DELETE-1',
        traceId: 'trace-offline-query',
      }),
    ).resolves.toMatchObject({
      data: { providerTaskKey: 'TASK-DNS-DELETE-1', recordState: 6, state: 'pending' },
      ok: true,
    })
    expect(
      transport.requests.map(({ body, operation, path }) => ({ body, operation, path })),
    ).toEqual([
      {
        body: { act: 'dodelreall', data: 'wanmi-test.com|www|A|192.0.2.10|电信' },
        operation: 'offline_dns_record_delete_submit',
        path: '/v2/offline-task/add-dns-record-task',
      },
      {
        body: { page: '1', pageSize: '10', task_sku: 'TASK-DNS-DELETE-1' },
        operation: 'offline_task_list',
        path: '/v2/offline-task/task-list',
      },
      {
        body: {
          ident: 'wanmi-test.com',
          page: '1',
          pageSize: '10',
          task_sku: 'TASK-DNS-DELETE-1',
        },
        operation: 'offline_task_record_list',
        path: '/v2/offline-task/task-record-list',
      },
    ])
  })

  it('keeps a successful task-creation envelope without task_sku status-unknown', async () => {
    const transport = new FixtureWestDigitalWriteTransport((input) => ({
      body: { clientid: `fixture-${input.requestId}`, code: 200, data: true, msg: '成功' },
      status: 200,
    }))
    const provider = new WestDigitalWriteAdapter({ transport })
    await expect(
      provider.submitOfflineDnsRecordDelete({
        domainAscii: 'wanmi-test.com',
        record: {
          host: 'www',
          lineCode: '',
          priority: 10,
          ttl: 600,
          type: 'A',
          value: '192.0.2.20',
        },
        traceId: 'trace-offline-missing-task-key',
      }),
    ).resolves.toMatchObject({
      error: { code: 'WESTDIGITAL_WRITE_STATUS_UNKNOWN', statusKnown: false },
      ok: false,
    })
    expect(transport.writeCount).toBe(1)
  })

  it.each([
    { expected: 'succeeded', recordState: 3, taskState: 1 },
    { expected: 'failed', recordState: 4, taskState: 1 },
    { expected: 'failed', recordState: 6, taskState: 3 },
    { expected: 'failed', recordState: 5, taskState: 1 },
    { expected: 'pending', recordState: 0, taskState: 0 },
    { expected: 'pending', recordState: 1, taskState: 1 },
    { expected: 'pending', recordState: 2, taskState: 2 },
    { expected: 'pending', recordState: 6, taskState: 1 },
  ] as const)(
    'maps documented offline task_state=$taskState and record_state=$recordState to $expected',
    async ({ expected, recordState, taskState }) => {
      const transport = new FixtureWestDigitalWriteTransport((input) => {
        const clientid = `fixture-${input.requestId}`
        if (input.operation === 'offline_task_list') {
          return {
            body: {
              clientid,
              code: 200,
              data: {
                data: [
                  {
                    task_act: 'dodelreall',
                    task_sku: 'TASK-STATE',
                    task_state: taskState,
                    task_type: 'dns_record',
                  },
                ],
              },
            },
            status: 200,
          }
        }
        return {
          body: {
            clientid,
            code: 200,
            data: {
              data: [
                {
                  act: 'dodelreall',
                  record_ident: 'wanmi-test.com',
                  record_result: 'fixture-state',
                  record_state: recordState,
                },
              ],
            },
          },
          status: 200,
        }
      })
      const provider = new WestDigitalWriteAdapter({ transport })
      await expect(
        provider.queryOfflineDnsRecordDelete({
          domainAscii: 'wanmi-test.com',
          providerTaskKey: 'TASK-STATE',
          traceId: `trace-offline-state-${taskState}-${recordState}`,
        }),
      ).resolves.toMatchObject({ data: { state: expected }, ok: true })
    },
  )

  it.each([
    {
      mutation: 'task-act',
      recordIdent: 'wanmi-test.com',
      taskAct: 'setnsmodi',
      taskType: 'dns_record',
    },
    {
      mutation: 'task-type',
      recordIdent: 'wanmi-test.com',
      taskAct: 'dodelreall',
      taskType: 'domain',
    },
    {
      mutation: 'record-domain',
      recordIdent: 'other.example',
      taskAct: 'dodelreall',
      taskType: 'dns_record',
    },
  ])(
    'rejects mismatched offline task identity: $mutation',
    async ({ recordIdent, taskAct, taskType }) => {
      const transport = new FixtureWestDigitalWriteTransport((input) => {
        const clientid = `fixture-${input.requestId}`
        if (input.operation === 'offline_task_list') {
          return {
            body: {
              clientid,
              code: 200,
              data: {
                data: [
                  {
                    task_act: taskAct,
                    task_sku: 'TASK-MISMATCH',
                    task_state: 1,
                    task_type: taskType,
                  },
                ],
              },
            },
            status: 200,
          }
        }
        return {
          body: {
            clientid,
            code: 200,
            data: {
              data: [
                {
                  act: 'dodelreall',
                  record_ident: recordIdent,
                  record_result: 'fixture',
                  record_state: 3,
                },
              ],
            },
          },
          status: 200,
        }
      })
      const provider = new WestDigitalWriteAdapter({ transport })
      await expect(
        provider.queryOfflineDnsRecordDelete({
          domainAscii: 'wanmi-test.com',
          providerTaskKey: 'TASK-MISMATCH',
          traceId: 'trace-offline-mismatch',
        }),
      ).resolves.toMatchObject({
        error: { code: 'WESTDIGITAL_INVALID_RESPONSE', statusKnown: true },
        ok: false,
      })
    },
  )

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
