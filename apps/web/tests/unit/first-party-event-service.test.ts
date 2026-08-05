import { afterEach, describe, expect, it, vi } from 'vitest'

import { getEnv, resetEnvForTests } from '@/lib/env'
import { recordFirstPartyEvent } from '@/services/analytics/record-first-party-event'

const originalLimit = process.env.FIRST_PARTY_EVENT_LIMIT_PER_MINUTE

afterEach(() => {
  if (originalLimit === undefined) delete process.env.FIRST_PARTY_EVENT_LIMIT_PER_MINUTE
  else process.env.FIRST_PARTY_EVENT_LIMIT_PER_MINUTE = originalLimit
  resetEnvForTests()
})

describe('first-party event write service', () => {
  it('writes only parsed aggregate fields with a server-generated trace ID', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 })
    const count = vi.fn().mockResolvedValue({ totalDocs: 0 })
    const result = await recordFirstPartyEvent({ count, create } as never, {
      event: 'tool_submitted',
      fromLocalHistory: false,
      inputType: 'full_domain',
      schemaVersion: 1,
      tld: 'net',
      tool: 'domain-search',
    })

    expect(result.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(count).toHaveBeenCalledWith({
      collection: 'firstPartyEvents',
      overrideAccess: true,
      where: { createdAt: { greater_than: expect.any(String) } },
    })
    expect(create).toHaveBeenCalledWith({
      collection: 'firstPartyEvents',
      data: {
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        schemaVersion: 1,
        tld: 'net',
        tool: 'domain-search',
        traceId: result.traceId,
      },
      overrideAccess: true,
    })
    expect(JSON.stringify(create.mock.calls)).not.toContain('wanmi.net')
  })

  it('rejects complete domains and sensitive extra fields before touching Payload', async () => {
    const create = vi.fn()
    const count = vi.fn()
    for (const candidate of [
      {
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        schemaVersion: 1,
        tld: 'wanmi.net',
        tool: 'domain-search',
      },
      {
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        phone: '13812345678',
        schemaVersion: 1,
        tld: 'net',
        tool: 'domain-search',
      },
    ]) {
      await expect(recordFirstPartyEvent({ count, create } as never, candidate)).rejects.toThrow()
    }
    expect(count).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('applies the configurable global admission limit without creating an identifier', async () => {
    process.env.FIRST_PARTY_EVENT_LIMIT_PER_MINUTE = '1'
    resetEnvForTests()
    expect(getEnv().FIRST_PARTY_EVENT_LIMIT_PER_MINUTE).toBe(1)
    const create = vi.fn()
    const count = vi.fn().mockResolvedValue({ totalDocs: 1 })

    await expect(
      recordFirstPartyEvent({ count, create } as never, {
        deviceCategory: 'desktop',
        event: 'page_viewed',
        pageType: 'home',
        schemaVersion: 1,
        source: 'direct',
      }),
    ).rejects.toMatchObject({ code: 'EVENT_RATE_LIMITED', status: 429 })
    expect(create).not.toHaveBeenCalled()
  })

  it('stores failed tools with an explicit unsuccessful aggregate dimension', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 })
    const count = vi.fn().mockResolvedValue({ totalDocs: 0 })
    await recordFirstPartyEvent({ count, create } as never, {
      dataSource: 'whodat',
      durationBucket: '300_999ms',
      errorCode: 'PROVIDER_UNAVAILABLE',
      event: 'tool_failed',
      schemaVersion: 1,
      tld: 'net',
      tool: 'whois',
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ succeeded: false }) }),
    )
  })
})
