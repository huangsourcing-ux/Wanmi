import { describe, expect, it, vi } from 'vitest'

import { createNameserverChangeHandler } from '@/app/api/v1/domains/[assetId]/nameservers/route'
import { createDomainDetailHandler } from '@/app/api/v1/domains/[assetId]/route'
import { createDomainListHandler } from '@/app/api/v1/domains/route'
import { AppError } from '@/lib/errors'

const customer = { collection: 'customers' as const, id: 42, status: 'active' }
const req = { user: customer } as never
const asset = {
  domainAscii: 'owner.example',
  expiresAt: '2027-08-08T00:00:00.000Z',
  id: '7',
  lastSyncedAt: '2026-08-08T00:00:00.000Z',
  nameservers: ['ns1.example.net', 'ns2.example.net'],
  registeredAt: '2026-08-08T00:00:00.000Z',
  registrar: 'west',
  status: 'active' as const,
}

function context() {
  return Promise.resolve({ customer, req })
}

describe('D6-04 domain asset routes', () => {
  it('returns only the safe six-state list contract with no-store', async () => {
    const list = vi.fn().mockResolvedValue({ data: { items: [asset], total: 1 }, state: 'ready' })
    const response = await createDomainListHandler({ list, resolveContext: context })(
      new Request('http://wanmi.local/api/v1/domains'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ data: { items: [asset], total: 1 }, state: 'ready' })
    expect(list).toHaveBeenCalledWith(req, customer)
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
})
