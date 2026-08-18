import { describe, expect, it, vi } from 'vitest'

import { createNameserverChangeHandler } from '@/app/api/v1/domains/[assetId]/nameservers/route'
import { createDomainDetailHandler } from '@/app/api/v1/domains/[assetId]/route'
import { createDomainListHandler } from '@/app/api/v1/domains/route'
import { AppError } from '@/lib/errors'

const customer = { collection: 'customers' as const, id: 42, status: 'active' }
const req = { user: customer } as never
const asset = {
  domainAscii: 'owner.example',
  domainLockStatus: 'locked' as const,
  expiresAt: '2027-08-08T00:00:00.000Z',
  expiryReminderChannels: ['in_app', 'sms'] as const,
  expiryReminderDays: [30, 7, 1],
  id: '7',
  lastSyncedAt: '2026-08-08T00:00:00.000Z',
  nameservers: ['ns1.example.net', 'ns2.example.net'],
  registeredAt: '2026-08-08T00:00:00.000Z',
  registrar: 'west',
  status: 'active' as const,
  tags: ['production'],
}

function context() {
  return Promise.resolve({ customer, req })
}

describe('D6-04 domain asset routes', () => {
  it('returns only the safe six-state list contract with no-store', async () => {
    const list = vi.fn().mockResolvedValue({
      data: { items: [asset], page: 2, pageSize: 25, total: 1, totalPages: 1 },
      state: 'ready',
    })
    const response = await createDomainListHandler({ list, resolveContext: context })(
      new Request(
        'http://wanmi.local/api/v1/domains?query=owner&status=active&lockStatus=locked&tag=production&expiresWithinDays=30&page=2&pageSize=25&sort=-domainAscii',
      ),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: { items: [asset], page: 2, pageSize: 25, total: 1, totalPages: 1 },
      state: 'ready',
    })
    expect(list).toHaveBeenCalledWith(req, customer, {
      expiresWithinDays: 30,
      lockStatus: 'locked',
      page: 2,
      pageSize: 25,
      query: 'owner',
      sort: '-domainAscii',
      status: 'active',
      tag: 'production',
    })
  })

  it('keeps detail failures no-store without exposing internal data', async () => {
    const detail = vi
      .fn()
      .mockRejectedValue(new AppError('DOMAIN_ASSET_NOT_FOUND', '未找到域名资产', 404))
    const response = await createDomainDetailHandler({ detail, resolveContext: context })(
      new Request('http://wanmi.local/api/v1/domains/8'),
      { params: Promise.resolve({ assetId: '8' }) },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(JSON.stringify(await response.json())).not.toContain('providerRequest')
  })

  it('strictly validates Name Server writes and queues valid owner requests', async () => {
    const requestChange = vi.fn().mockResolvedValue({
      data: {
        id: '9',
        previousNameservers: asset.nameservers,
        requestedAt: '2026-08-08T01:00:00.000Z',
        requestedNameservers: ['ns1.new.example', 'ns2.new.example'],
        status: 'pending',
      },
      state: 'ready',
    })
    const handler = createNameserverChangeHandler({ requestChange, resolveContext: context })
    const valid = await handler(
      new Request('http://wanmi.local/api/v1/domains/7/nameservers', {
        body: JSON.stringify({
          confirmed: true,
          deviceId: 'domain-route-device-0001',
          nameservers: ['ns1.new.example', 'ns2.new.example'],
          stepUpToken: 'a'.repeat(43),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { params: Promise.resolve({ assetId: '7' }) },
    )
    const invalid = await handler(
      new Request('http://wanmi.local/api/v1/domains/7/nameservers', {
        body: JSON.stringify({ nameservers: asset.nameservers, providerSecret: 'forbidden' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { params: Promise.resolve({ assetId: '7' }) },
    )

    expect(valid.status).toBe(202)
    expect(valid.headers.get('cache-control')).toBe('no-store')
    expect(invalid.status).toBe(400)
    expect(requestChange).toHaveBeenCalledTimes(1)
    expect(requestChange).toHaveBeenCalledWith(
      req,
      7,
      {
        confirmed: true,
        deviceId: 'domain-route-device-0001',
        nameservers: ['ns1.new.example', 'ns2.new.example'],
        stepUpToken: 'a'.repeat(43),
      },
      expect.objectContaining({ customer }),
    )
  })

  it.each([
    [
      'explicit confirmation',
      {
        confirmed: false,
        deviceId: 'domain-route-device-0002',
        nameservers: ['ns1.new.example', 'ns2.new.example'],
        stepUpToken: 'a'.repeat(43),
      },
    ],
    [
      'device id',
      {
        confirmed: true,
        nameservers: ['ns1.new.example', 'ns2.new.example'],
        stepUpToken: 'a'.repeat(43),
      },
    ],
    [
      'step-up token',
      {
        confirmed: true,
        deviceId: 'domain-route-device-0002',
        nameservers: ['ns1.new.example', 'ns2.new.example'],
      },
    ],
  ])('rejects a Name Server request without valid %s', async (_case, body) => {
    const requestChange = vi.fn()
    const response = await createNameserverChangeHandler({
      requestChange,
      resolveContext: context,
    })(
      new Request('http://wanmi.local/api/v1/domains/7/nameservers', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { params: Promise.resolve({ assetId: '7' }) },
    )
    expect(response.status).toBe(400)
    expect(requestChange).not.toHaveBeenCalled()
  })
})
