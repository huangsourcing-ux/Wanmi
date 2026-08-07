import { describe, expect, it, vi } from 'vitest'

import {
  probeExternalAdTarget,
  runAdvertisingMaintenance,
} from '@/services/advertising/maintenance'

describe('D3 advertising target safety maintenance', () => {
  it('pins a public address, falls back from HEAD when required and rejects HTTP failures', async () => {
    const requestStatus = vi.fn().mockResolvedValueOnce(405).mockResolvedValueOnce(204)
    await expect(
      probeExternalAdTarget('https://ads.example.test/landing', {
        requestStatus,
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
    ).resolves.toEqual({ failure: 'none', status: 'reachable' })
    expect(requestStatus.mock.calls.map((call) => call[2])).toEqual(['HEAD', 'GET'])

    await expect(
      probeExternalAdTarget('https://ads.example.test/missing', {
        requestStatus: async () => 404,
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
    ).resolves.toEqual({ failure: 'http_error', status: 'unreachable' })
  })

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1'])(
    'blocks restricted resolved address %s before making an HTTPS request',
    async (address) => {
      const requestStatus = vi.fn()
      await expect(
        probeExternalAdTarget('https://ads.example.test/landing', {
          requestStatus,
          resolveAddresses: async () => [
            { address, family: address.includes(':') ? 6 : 4 } as {
              address: string
              family: 4 | 6
            },
          ],
        }),
      ).resolves.toEqual({ failure: 'restricted_address', status: 'unsafe' })
      expect(requestStatus).not.toHaveBeenCalled()
    },
  )

  it('expires schedules once and writes only enumerated target health plus system audit metadata', async () => {
    const updates: Array<Record<string, unknown>> = []
    const audits: Array<Record<string, unknown>> = []
    let expired = false
    let checked = false
    const payload = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data)
        return { id: audits.length }
      }),
      find: vi.fn(async ({ collection }: { collection: string }) => {
        if (collection === 'adSchedules') {
          return {
            docs: expired
              ? []
              : [
                  {
                    endsAt: '2026-08-07T11:00:00.000Z',
                    id: 40,
                    status: 'active',
                    updatedAt: '2026-08-07T10:00:00.000Z',
                  },
                ],
          }
        }
        return {
          docs: checked
            ? []
            : [
                {
                  advertiser: 10,
                  id: 20,
                  status: 'approved',
                  targetCheckFailure: 'none',
                  targetCheckStatus: 'pending',
                  targetType: 'external',
                  targetUrl: 'https://ads.example.test/landing',
                  updatedAt: '2026-08-07T10:00:00.000Z',
                },
              ],
        }
      }),
      findByID: vi.fn(async () => ({ allowedHosts: [{ host: 'ads.example.test' }] })),
      update: vi.fn(async (input: Record<string, unknown>) => {
        updates.push(input)
        if (input.collection === 'adSchedules') expired = true
        if (input.collection === 'adCreatives') checked = true
        return { id: input.id }
      }),
    }
    const req = { headers: new Headers({ 'x-request-id': 'maintenance-unit' }), payload } as never
    const result = await runAdvertisingMaintenance(req, {
      now: new Date('2026-08-07T12:00:00.000Z'),
      probe: async () => ({ failure: 'none', status: 'reachable' }),
    })
    expect(result).toEqual({ checked: 1, expired: 1 })
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'adSchedules',
          data: { status: 'ended' },
          overrideAccess: true,
        }),
        expect.objectContaining({
          collection: 'adCreatives',
          data: {
            targetCheckFailure: 'none',
            targetCheckedAt: '2026-08-07T12:00:00.000Z',
            targetCheckStatus: 'reachable',
          },
          overrideAccess: true,
        }),
      ]),
    )
    expect(JSON.stringify(audits)).not.toContain('ads.example.test')

    await expect(
      runAdvertisingMaintenance(req, {
        now: new Date('2026-08-07T12:00:01.000Z'),
        probe: async () => ({ failure: 'none', status: 'reachable' }),
      }),
    ).resolves.toEqual({ checked: 0, expired: 0 })
  })
})
