import { describe, expect, it } from 'vitest'

import {
  FixtureWestDigitalBalanceTransport,
  WestDigitalBalanceAdapter,
} from '@/providers/westdigital-balance'

describe('D6-03 WestDigital balance adapter', () => {
  it('uses the documented checkbalance request and converts decimal yuan to integer fen', async () => {
    const transport = new FixtureWestDigitalBalanceTransport({
      availableMinor: 58_352,
      frozenMinor: 101,
    })
    const provider = new WestDigitalBalanceAdapter({
      now: () => new Date('2026-08-08T16:00:00.000Z'),
      requestIdFactory: () => 'balance-request-1',
      transport,
    })

    await expect(provider.queryBalance({ traceId: 'balance-trace' })).resolves.toEqual({
      data: { availableMinor: 58_352, frozenMinor: 101 },
      observedAt: '2026-08-08T16:00:00.000Z',
      ok: true,
      requestId: 'balance-request-1',
    })
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]).toMatchObject({
      body: { act: 'checkbalance' },
      path: '/v2/info/',
      traceId: 'balance-trace',
    })
  })

  it('fails closed on malformed precision instead of using floating point money', async () => {
    const provider = new WestDigitalBalanceAdapter({
      requestIdFactory: () => 'balance-request-invalid',
      transport: {
        execute: async () => ({
          body: { data: { balance: '1.001', freezemoney: '0.00' }, result: 200 },
          status: 200,
        }),
      },
    })
    await expect(provider.queryBalance({ traceId: 'invalid-balance' })).resolves.toMatchObject({
      error: { code: 'WESTDIGITAL_BALANCE_INVALID_OR_UNAVAILABLE' },
      ok: false,
    })
  })
})
