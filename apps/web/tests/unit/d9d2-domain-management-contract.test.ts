import { afterEach, describe, expect, it, vi } from 'vitest'

import { DomainAssetSyncEvents, DomainManagementEvents } from '@/collections/domain-management'
import { domainAssetSynchronization } from '@/jobs/config'
import { resetEnvForTests } from '@/lib/env'
import { authorizeWestDigitalWrite } from '@/lib/provider-write-guardrails'
import type { WestDigitalRealnameProfile } from '@/providers/types'
import {
  WestDigitalWriteAdapter,
  type WestDigitalWriteTransportRequest,
} from '@/providers/westdigital-write'
import { FixtureWestDigitalWriteTransport } from '@/providers/westdigital-write-fixtures'
import { mapWestDigitalRealnameCreateFields } from '@/providers/westdigital-realname'
import {
  domainContactUpdateRequestSchema,
  domainManagementPasswordModifyRequestSchema,
  domainManagementPasswordRevealRequestSchema,
  domainTemplateTransferRequestSchema,
} from '@/schemas/domain-management'
import {
  assertDomainCapability,
  domainCapabilityDeclaration,
  WESTDIGITAL_DOMAIN_CAPABILITIES,
} from '@/services/domains/capabilities'
import { runDomainAssetSynchronization } from '@/services/domains/domain-assets'
import { generateWestDigitalOperationKey } from '@/services/providers/westdigital-operations'

import { realnameTemplateFixture } from '../fixtures/realname'

const traceId = 'd9d2-domain-contract'
const domainAscii = 'example.com'

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
})

function provider() {
  const transport = new FixtureWestDigitalWriteTransport((input) => {
    const clientid = `fixture-${input.requestId}`
    if (input.operation === 'domain_management_password_get') {
      return {
        body: { clientid, data: { domainpwd: 'DocumentedPassword12' }, result: 200 },
        status: 200,
      }
    }
    if (input.operation === 'domain_information_query') {
      return {
        body: { clientid, data: { c_sysid: 1664777, domain: domainAscii }, result: 200 },
        status: 200,
      }
    }
    if (input.operation === 'domain_certificate_get') {
      return { body: { clientid, data: { certurl: 'Y2VydGlmaWNhdGU=' }, result: 200 }, status: 200 }
    }
    return { body: { clientid, data: {}, result: 200 }, status: 200 }
  })
  return { adapter: new WestDigitalWriteAdapter({ transport }), transport }
}

function requestsByOperation(requests: Array<Omit<WestDigitalWriteTransportRequest, 'signal'>>) {
  return Object.fromEntries(requests.map((request) => [request.operation, request]))
}

describe('D9-D-2 domain management contract', () => {
  it('uses strict risk inputs without accepting a client-asserted bound-channel outcome', () => {
    const grant = { deviceId: 'domain-device-00000001', stepUpToken: 'A'.repeat(43) }
    const passwordModify = {
      ...grant,
      idempotencyKey: '00000000-0000-4000-8000-000000000201',
      managementPassword: 'Password12',
    }
    const contactUpdate = {
      ...grant,
      confirmed: true as const,
      contactType: 'dom_id' as const,
      idempotencyKey: '00000000-0000-4000-8000-000000000202',
      templateId: 1,
    }
    const templateTransfer = {
      ...grant,
      confirmed: true as const,
      idempotencyKey: '00000000-0000-4000-8000-000000000203',
      templateId: 1,
    }
    expect(domainManagementPasswordRevealRequestSchema.safeParse(grant).success).toBe(true)
    expect(
      domainManagementPasswordRevealRequestSchema.safeParse({
        ...grant,
        boundChannelConfirmed: true,
      }).success,
    ).toBe(false)
    expect(domainManagementPasswordModifyRequestSchema.safeParse(passwordModify).success).toBe(true)
    expect(
      domainManagementPasswordModifyRequestSchema.safeParse({
        ...passwordModify,
        managementPassword: 'short7',
      }).success,
    ).toBe(false)
    expect(domainContactUpdateRequestSchema.safeParse(contactUpdate).success).toBe(true)
    expect(domainTemplateTransferRequestSchema.safeParse(templateTransfer).success).toBe(true)
    expect(
      domainTemplateTransferRequestSchema.safeParse({
        ...grant,
        confirmed: false,
        idempotencyKey: '00000000-0000-4000-8000-000000000203',
        templateId: 1,
      }).success,
    ).toBe(false)
    for (const [schema, value] of [
      [domainManagementPasswordRevealRequestSchema, grant],
      [domainManagementPasswordModifyRequestSchema, passwordModify],
      [domainContactUpdateRequestSchema, contactUpdate],
      [domainTemplateTransferRequestSchema, templateTransfer],
    ] as const) {
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false)
    }
  })

  it('declares every slice capability explicitly and returns a dedicated code for each unsupported item', () => {
    expect(domainCapabilityDeclaration(WESTDIGITAL_DOMAIN_CAPABILITIES)).toEqual([
      { name: 'asset_sync', supported: true },
      { name: 'certificate_download', supported: true },
      { name: 'contact_information_update', supported: true },
      { name: 'management_password_read', supported: true },
      { name: 'management_password_write', supported: true },
      {
        name: 'realtime_transfer',
        supported: false,
        unsupportedCode: 'DOMAIN_CAPABILITY_REALTIME_TRANSFER_UNSUPPORTED',
      },
      { name: 'template_transfer', supported: true },
    ])
    for (const [name, expectedCode] of [
      ['asset_sync', 'DOMAIN_CAPABILITY_ASSET_SYNC_UNSUPPORTED'],
      ['certificate_download', 'DOMAIN_CAPABILITY_CERTIFICATE_DOWNLOAD_UNSUPPORTED'],
      ['contact_information_update', 'DOMAIN_CAPABILITY_CONTACT_INFORMATION_UPDATE_UNSUPPORTED'],
      ['management_password_read', 'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_READ_UNSUPPORTED'],
      ['management_password_write', 'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_WRITE_UNSUPPORTED'],
      ['realtime_transfer', 'DOMAIN_CAPABILITY_REALTIME_TRANSFER_UNSUPPORTED'],
      ['template_transfer', 'DOMAIN_CAPABILITY_TEMPLATE_TRANSFER_UNSUPPORTED'],
    ] as const) {
      expect(() =>
        assertDomainCapability(name, {
          ...WESTDIGITAL_DOMAIN_CAPABILITIES,
          [name]: { ...WESTDIGITAL_DOMAIN_CAPABILITIES[name], supported: false },
        }),
      ).toThrow(expect.objectContaining({ code: expectedCode }))
    }
  })

  it('sends only the exact documented West Digital acts, paths, and field names', async () => {
    const managed = provider()
    const profile = realnameTemplateFixture() as unknown as WestDigitalRealnameProfile
    const password = await managed.adapter.getDomainManagementPassword({ domainAscii, traceId })
    await managed.adapter.modifyDomainManagementPassword({
      domainAscii,
      managementPassword: 'ModifiedPassword12',
      traceId,
    })
    await managed.adapter.updateDomainContact({
      contactType: 'tech_id',
      domainAscii,
      profile,
      traceId,
    })
    await managed.adapter.transferDomainToTemplate({
      domainAscii,
      providerTemplateId: '1664777',
      traceId,
    })
    const information = await managed.adapter.queryDomainInformation({ domainAscii, traceId })
    const certificate = await managed.adapter.getDomainCertificate({ domainAscii, traceId })
    expect(password).toMatchObject({
      ok: true,
      data: { managementPassword: 'DocumentedPassword12' },
    })
    expect(information).toMatchObject({
      ok: true,
      data: { domainAscii, providerTemplateId: '1664777' },
    })
    expect(certificate).toMatchObject({
      ok: true,
      data: { certificateBase64: 'Y2VydGlmaWNhdGU=' },
    })
    const requests = requestsByOperation(managed.transport.requests)
    expect(requests.domain_management_password_get).toEqual(
      expect.objectContaining({
        body: { act: 'getpwd', domain: domainAscii },
        path: '/v2/domain/',
      }),
    )
    expect(requests.domain_management_password_modify).toEqual(
      expect.objectContaining({
        body: { act: 'modpwd', domain: domainAscii, domainpwd: 'ModifiedPassword12' },
        path: '/v2/domain/',
      }),
    )
    const fields = mapWestDigitalRealnameCreateFields(profile)
    expect(requests.domain_contact_update).toEqual(
      expect.objectContaining({
        body: {
          act: 'domainmodisub',
          c_adr: fields.c_adr,
          c_adr_m: fields.c_adr_m,
          c_co: fields.c_co,
          c_ct: fields.c_ct,
          c_ct_m: fields.c_ct_m,
          c_dt_m: fields.c_dt_m,
          c_em: fields.c_em,
          c_fn: fields.c_fn,
          c_fn_m: fields.c_fn_m,
          c_ln: fields.c_ln,
          c_ln_m: fields.c_ln_m,
          c_pc: fields.c_pc,
          c_ph: fields.c_ph,
          c_ph_code: fields.c_ph_code,
          c_ph_fj: fields.c_ph_fj,
          c_ph_num: fields.c_ph_num,
          c_ph_type: fields.c_ph_type,
          c_st: fields.c_st,
          c_st_m: fields.c_st_m,
          cocode: fields.cocode,
          domain: domainAscii,
          eppidtype: 'tech_id',
          fullname: fields.fullname,
        },
        path: '/v2/audit/',
      }),
    )
    expect(requests.domain_template_transfer).toEqual(
      expect.objectContaining({
        body: {
          act: 'auditghsub',
          c_sysid: '1664777',
          domain: domainAscii,
          eppidtype: 'dom_id,admin_id,tech_id,bill_id',
        },
        path: '/v2/audit/',
      }),
    )
    expect(requests.domain_information_query).toEqual(
      expect.objectContaining({
        body: { act: 'domaininfo', domain: domainAscii },
        path: '/v2/audit/',
      }),
    )
    expect(requests.domain_certificate_get).toEqual(
      expect.objectContaining({
        body: { act: 'cert', domain: domainAscii, img: '1' },
        path: '/v2/domain/',
      }),
    )
  })

  it('does not bind a password operation key to the plaintext, its length, or a hash', () => {
    const base = {
      actor: { id: 1, type: 'customer' as const },
      businessKey: '00000000-0000-4000-8000-000000000204',
      domainAscii,
      operation: 'domain_management_password' as const,
      targetId: 7,
      traceId,
    }
    const short = generateWestDigitalOperationKey({ ...base, managementPassword: 'Password12' })
    const long = generateWestDigitalOperationKey({
      ...base,
      managementPassword: 'CompletelyDifferentPassword123456',
    })
    expect(short).toBe(long)
    expect(short).not.toContain('Password12')
    expect(short).not.toContain('10')
  })

  it('keeps all real domain-management writes behind their dedicated disabled-by-default gate', () => {
    vi.stubEnv('CI', 'false')
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL', 'true')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES', 'false')
    vi.stubEnv('WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST', domainAscii)
    resetEnvForTests()
    for (const [operation, expectedCode] of [
      ['domain_contact_update', 'WESTDIGITAL_DOMAIN_CONTACT_UPDATE_WRITE_DISABLED'],
      ['domain_management_password', 'WESTDIGITAL_DOMAIN_MANAGEMENT_PASSWORD_WRITE_DISABLED'],
      ['domain_template_transfer', 'WESTDIGITAL_DOMAIN_TEMPLATE_TRANSFER_WRITE_DISABLED'],
    ] as const) {
      expect(() =>
        authorizeWestDigitalWrite({ domainAscii, operation }, `d9d2-guard-${operation}`),
      ).toThrow(expect.objectContaining({ code: expectedCode }))
    }
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES', 'true')
    resetEnvForTests()
    for (const operation of [
      'domain_contact_update',
      'domain_management_password',
      'domain_template_transfer',
    ] as const) {
      expect(() =>
        authorizeWestDigitalWrite({ domainAscii, operation }, `d9d2-guard-${operation}`),
      ).not.toThrow()
    }
  })

  it('keeps management and synchronization evidence append-only under system override', () => {
    for (const [collection, message] of [
      [DomainManagementEvents, '域名管理操作记录只允许追加'],
      [DomainAssetSyncEvents, '域名资产同步记录只允许追加'],
    ] as const) {
      const beforeChange = collection.hooks?.beforeChange?.[0]
      const beforeDelete = collection.hooks?.beforeDelete?.[0]
      expect(beforeChange).toBeTypeOf('function')
      expect(beforeDelete).toBeTypeOf('function')
      expect(() => beforeChange?.({ operation: 'update' } as never)).toThrow(message)
      expect(() => beforeDelete?.({} as never)).toThrow(message)
      expect(beforeChange?.({ operation: 'create' } as never)).toBeUndefined()
    }
  })

  it('runs upstream asset synchronization as one exclusive background schedule with no retries', () => {
    expect(domainAssetSynchronization).toMatchObject({
      concurrency: {
        exclusive: true,
        supersedes: true,
      },
      queue: 'background',
      retries: 0,
      schedule: [{ cron: '0 15 1 * * *', queue: 'background' }],
      slug: 'domainAssetSynchronization',
    })
    expect(
      typeof domainAssetSynchronization.concurrency === 'object' &&
        domainAssetSynchronization.concurrency !== null
        ? domainAssetSynchronization.concurrency.key({} as never)
        : undefined,
    ).toBe('domain:asset-synchronization')
  })

  it('keeps the synchronization runner system-only and capability-gated before database access', async () => {
    const managed = provider()
    await expect(
      runDomainAssetSynchronization(
        { user: { collection: 'customers', id: 1 } } as never,
        managed.adapter,
        traceId,
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_SYNC_JOB_ONLY', status: 403 })
    await expect(
      runDomainAssetSynchronization({ user: null } as never, managed.adapter, traceId, {
        ...WESTDIGITAL_DOMAIN_CAPABILITIES,
        asset_sync: {
          ...WESTDIGITAL_DOMAIN_CAPABILITIES.asset_sync,
          supported: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_CAPABILITY_ASSET_SYNC_UNSUPPORTED', status: 409 })
    expect(managed.transport.requests).toHaveLength(0)
  })
})
