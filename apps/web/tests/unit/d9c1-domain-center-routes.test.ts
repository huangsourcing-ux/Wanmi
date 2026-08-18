import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDomainLockHandler } from '@/app/api/v1/domains/[assetId]/lock/route'
import { createDomainTagsHandler } from '@/app/api/v1/domains/[assetId]/tags/route'
import { createDomainReminderPreferencesHandler } from '@/app/api/v1/domains/reminder-preferences/route'
import { resetEnvForTests } from '@/lib/env'
import { authorizeWestDigitalWrite } from '@/lib/provider-write-guardrails'
import { WestDigitalWriteAdapter } from '@/providers/westdigital-write'
import { FixtureWestDigitalWriteTransport } from '@/providers/westdigital-write-fixtures'
import {
  domainAssetListQuerySchema,
  domainAssetTagsRequestSchema,
  domainExpiryReminderPreferencesRequestSchema,
  domainLockRequestSchema,
} from '@/schemas/domains'
import { generateWestDigitalOperationKey } from '@/services/providers/westdigital-operations'

const customer = { collection: 'customers' as const, id: 42, status: 'active' }
const req = { user: customer } as never
const routeContext = { params: Promise.resolve({ assetId: '7' }) }

function context() {
  return Promise.resolve({ customer, req })
}

function jsonRequest(path: string, body: unknown, method: 'PATCH' | 'PUT' = 'PUT') {
  return new Request(`http://wanmi.local${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
})

describe('D9-C-1 domain-center route and provider contracts', () => {
  it('enforces every public list, tag, reminder and lock input boundary', () => {
    const uuid = '00000000-0000-4000-8000-000000000300'
    expect(
      domainAssetListQuerySchema.safeParse({
        expiresWithinDays: 3650,
        lockStatus: 'locked',
        page: 1,
        pageSize: 100,
        query: 'example.com',
        sort: '-domainAscii',
        status: 'active',
        tag: 'production',
      }).success,
    ).toBe(true)
    for (const input of [
      { expiresWithinDays: -1 },
      { expiresWithinDays: 3651 },
      { lockStatus: 'invalid' },
      { page: 0 },
      { pageSize: 0 },
      { pageSize: 101 },
      { query: 'a'.repeat(254) },
      { sort: 'createdAt' },
      { status: 'deleted' },
      { tag: 'a'.repeat(33) },
    ]) {
      expect(domainAssetListQuerySchema.safeParse(input).success).toBe(false)
    }

    expect(
      domainAssetTagsRequestSchema.safeParse({ idempotencyKey: uuid, tags: ['重要', 'prod'] })
        .success,
    ).toBe(true)
    for (const tags of [
      [''],
      ['   '],
      ['duplicate', 'duplicate'],
      ['a'.repeat(33)],
      ['bad\u0000tag'],
      Array.from({ length: 21 }, (_, index) => `tag-${index}`),
    ]) {
      expect(domainAssetTagsRequestSchema.safeParse({ idempotencyKey: uuid, tags }).success).toBe(
        false,
      )
    }
    expect(
      domainExpiryReminderPreferencesRequestSchema.safeParse({
        assetIds: [1, 2],
        batchKey: uuid,
        channels: ['in_app', 'sms'],
        thresholdDays: [30, 7, 1],
      }).success,
    ).toBe(true)
    for (const input of [
      { assetIds: [], channels: ['in_app'], thresholdDays: [1] },
      { assetIds: [1, 1], channels: ['in_app'], thresholdDays: [1] },
      { assetIds: [0], channels: ['in_app'], thresholdDays: [1] },
      {
        assetIds: Array.from({ length: 201 }, (_, index) => index + 1),
        channels: ['in_app'],
        thresholdDays: [1],
      },
      { assetIds: [1], channels: [], thresholdDays: [1] },
      { assetIds: [1], channels: ['sms', 'sms'], thresholdDays: [1] },
      { assetIds: [1], channels: ['in_app'], thresholdDays: [] },
      { assetIds: [1], channels: ['in_app'], thresholdDays: [1, 1] },
      { assetIds: [1], channels: ['in_app'], thresholdDays: [-1] },
      { assetIds: [1], channels: ['in_app'], thresholdDays: [1.5] },
      { assetIds: [1], channels: ['in_app'], thresholdDays: [366] },
      {
        assetIds: [1],
        channels: ['in_app'],
        thresholdDays: Array.from({ length: 13 }, (_, index) => index),
      },
    ]) {
      expect(
        domainExpiryReminderPreferencesRequestSchema.safeParse({
          batchKey: uuid,
          ...input,
        }).success,
      ).toBe(false)
    }
    expect(domainLockRequestSchema.safeParse({ idempotencyKey: uuid, locked: true }).success).toBe(
      true,
    )
    expect(domainLockRequestSchema.safeParse({ idempotencyKey: uuid, locked: false }).success).toBe(
      false,
    )
    expect(
      domainLockRequestSchema.safeParse({
        idempotencyKey: uuid,
        locked: false,
        stepUpToken: 'a'.repeat(43),
      }).success,
    ).toBe(false)
    expect(
      domainLockRequestSchema.safeParse({
        deviceId: 'domain-device-00000001',
        idempotencyKey: uuid,
        locked: false,
      }).success,
    ).toBe(false)
    expect(
      domainLockRequestSchema.safeParse({
        deviceId: 'domain-device-00000001',
        idempotencyKey: uuid,
        locked: false,
        stepUpToken: 'a'.repeat(43),
      }).success,
    ).toBe(true)
  })

  it('passes strict tag and batch reminder inputs to the authenticated customer services', async () => {
    const updateTags = vi.fn().mockResolvedValue({
      data: { assetIds: ['7'], updated: 1 },
      state: 'ready',
    })
    const updatePreferences = vi.fn().mockResolvedValue({
      data: { assetIds: ['7', '8'], updated: 2 },
      state: 'ready',
    })
    const tagsResponse = await createDomainTagsHandler({
      resolveContext: context,
      update: updateTags,
    })(
      jsonRequest('/api/v1/domains/7/tags', {
        idempotencyKey: '00000000-0000-4000-8000-000000000301',
        tags: ['production', '重要'],
      }),
      routeContext,
    )
    const preferencesResponse = await createDomainReminderPreferencesHandler({
      resolveContext: context,
      update: updatePreferences,
    })(
      jsonRequest(
        '/api/v1/domains/reminder-preferences',
        {
          assetIds: [7, 8],
          batchKey: '00000000-0000-4000-8000-000000000302',
          channels: ['in_app'],
          thresholdDays: [7, 1],
        },
        'PATCH',
      ),
    )

    expect(tagsResponse.status).toBe(200)
    expect(updateTags).toHaveBeenCalledWith(
      req,
      7,
      {
        idempotencyKey: '00000000-0000-4000-8000-000000000301',
        tags: ['production', '重要'],
      },
      expect.objectContaining({ customer }),
    )
    expect(preferencesResponse.status).toBe(200)
    expect(updatePreferences).toHaveBeenCalledWith(
      req,
      {
        assetIds: [7, 8],
        batchKey: '00000000-0000-4000-8000-000000000302',
        channels: ['in_app'],
        thresholdDays: [7, 1],
      },
      expect.objectContaining({ customer }),
    )
  })

  it('rejects malformed preference input before calling either write service', async () => {
    const updateTags = vi.fn()
    const updatePreferences = vi.fn()
    const tagsResponse = await createDomainTagsHandler({
      resolveContext: context,
      update: updateTags,
    })(
      jsonRequest('/api/v1/domains/7/tags', {
        idempotencyKey: '00000000-0000-4000-8000-000000000303',
        tags: ['duplicate', 'duplicate'],
      }),
      routeContext,
    )
    const preferencesResponse = await createDomainReminderPreferencesHandler({
      resolveContext: context,
      update: updatePreferences,
    })(
      jsonRequest(
        '/api/v1/domains/reminder-preferences',
        {
          assetIds: [7, 7],
          batchKey: '00000000-0000-4000-8000-000000000304',
          channels: [],
          thresholdDays: [],
        },
        'PATCH',
      ),
    )

    expect(tagsResponse.status).toBe(400)
    expect(preferencesResponse.status).toBe(400)
    expect(updateTags).not.toHaveBeenCalled()
    expect(updatePreferences).not.toHaveBeenCalled()
  })

  it('requires step-up fields only when lowering protection by disabling the lock', async () => {
    const setLock = vi.fn().mockResolvedValue({
      data: {
        idempotentReplay: false,
        locked: true,
        operationId: '17',
        operationKey: 'domain-lock-fixture',
        status: 'succeeded',
      },
      state: 'ready',
    })
    const handler = createDomainLockHandler({
      provider: {} as never,
      resolveContext: context,
      setLock,
    })
    const enableResponse = await handler(
      jsonRequest('/api/v1/domains/7/lock', {
        idempotencyKey: '00000000-0000-4000-8000-000000000305',
        locked: true,
      }),
      routeContext,
    )
    const missingStepUp = await handler(
      jsonRequest('/api/v1/domains/7/lock', {
        idempotencyKey: '00000000-0000-4000-8000-000000000306',
        locked: false,
      }),
      routeContext,
    )
    setLock.mockResolvedValueOnce({
      data: {
        idempotentReplay: false,
        locked: false,
        operationId: '18',
        operationKey: 'domain-unlock-fixture',
        status: 'succeeded',
      },
      state: 'ready',
    })
    const disableResponse = await handler(
      jsonRequest('/api/v1/domains/7/lock', {
        deviceId: 'domain-device-00000001',
        idempotencyKey: '00000000-0000-4000-8000-000000000307',
        locked: false,
        stepUpToken: 'a'.repeat(43),
      }),
      routeContext,
    )

    expect(enableResponse.status).toBe(200)
    expect(missingStepUp.status).toBe(400)
    expect(disableResponse.status).toBe(200)
    expect(setLock).toHaveBeenCalledTimes(2)
    expect(setLock.mock.calls[0]?.[2]).toEqual({
      idempotencyKey: '00000000-0000-4000-8000-000000000305',
      locked: true,
    })
    expect(setLock.mock.calls[1]?.[2]).toEqual({
      deviceId: 'domain-device-00000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000307',
      locked: false,
      stepUpToken: 'a'.repeat(43),
    })
  })

  it('uses only the documented setlock contract and maps lock direction to val', async () => {
    const transport = new FixtureWestDigitalWriteTransport((input) => ({
      body: { clientid: `fixture-${input.requestId}`, data: {}, result: 200 },
      status: 200,
    }))
    const adapter = new WestDigitalWriteAdapter({ transport })
    const locked = await adapter.setDomainLock({
      domainAscii: 'example.com',
      locked: true,
      traceId: 'd9c1-lock-contract',
    })
    const unlocked = await adapter.setDomainLock({
      domainAscii: 'example.com',
      locked: false,
      traceId: 'd9c1-unlock-contract',
    })

    expect(locked).toMatchObject({ ok: true, data: { state: 'succeeded' } })
    expect(unlocked).toMatchObject({ ok: true, data: { state: 'succeeded' } })
    expect(transport.requests).toEqual([
      expect.objectContaining({
        body: { act: 'setlock', domain: 'example.com', status: 'update', val: '1' },
        operation: 'domain_lock',
        path: '/v2/domain/',
      }),
      expect.objectContaining({
        body: { act: 'setlock', domain: 'example.com', status: 'update', val: '0' },
        operation: 'domain_lock',
        path: '/v2/domain/',
      }),
    ])
    const unavailable = new WestDigitalWriteAdapter({
      transport: {
        execute: async () => {
          throw new Error('fixture connection lost after possible submission')
        },
      },
    })
    const uncertain = await unavailable.setDomainLock({
      domainAscii: 'example.com',
      locked: false,
      traceId: 'd9c1-lock-unknown-contract',
    })
    expect(uncertain).toMatchObject({
      error: { code: 'WESTDIGITAL_WRITE_STATUS_UNKNOWN', statusKnown: false },
      ok: false,
    })
  })

  it('keeps real lock writes under the existing disabled-by-default domain-management gate', () => {
    vi.stubEnv('CI', 'false')
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL', 'true')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES', 'false')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES', 'true')
    vi.stubEnv('WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST', 'example.com')
    resetEnvForTests()
    expect(() =>
      authorizeWestDigitalWrite(
        { domainAscii: 'example.com', operation: 'domain_lock' },
        'd9c1-lock-guard',
      ),
    ).toThrow(expect.objectContaining({ code: 'WESTDIGITAL_DOMAIN_LOCK_WRITE_DISABLED' }))
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES', 'false')
    resetEnvForTests()
    expect(() =>
      authorizeWestDigitalWrite(
        { domainAscii: 'example.com', operation: 'domain_lock' },
        'd9c1-lock-guard-enabled',
      ),
    ).not.toThrow()
  })

  it('binds lock idempotency to the requested direction without exposing mutable input', () => {
    const base = {
      actor: { id: 42, type: 'customer' as const },
      businessKey: '00000000-0000-4000-8000-000000000308',
      domainAscii: 'example.com',
      operation: 'domain_lock' as const,
      targetId: 7,
      traceId: 'd9c1-lock-operation-key',
    }
    const locked = generateWestDigitalOperationKey({
      ...base,
      businessKey: `${base.businessKey}:locked`,
      locked: true,
    })
    const unlocked = generateWestDigitalOperationKey({
      ...base,
      businessKey: `${base.businessKey}:unlocked`,
      locked: false,
    })
    const lockedWithChangedMutableField = generateWestDigitalOperationKey({
      ...base,
      businessKey: `${base.businessKey}:locked`,
      locked: false,
    })
    expect(locked).not.toBe(unlocked)
    expect(lockedWithChangedMutableField).toBe(locked)
    expect(locked).not.toContain('true')
    expect(unlocked).not.toContain('false')
  })
})
