import { describe, expect, it, vi } from 'vitest'

import { findAsUser, systemFindForJob } from '@/access/local-api'

describe('Payload Local API guardrails', () => {
  it('always represents a user with overrideAccess false', async () => {
    const find = vi.fn().mockResolvedValue({ docs: [] })
    const payload = { find }
    const user = { collection: 'customers', id: 42 }
    await findAsUser(payload as never, { collection: 'orders', user: user as never })
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'orders', overrideAccess: false, user }),
    )
  })

  it('requires a reason and writes an audit row for system reads', async () => {
    const find = vi.fn().mockResolvedValue({ docs: [] })
    const create = vi.fn().mockResolvedValue({ id: 1 })
    const payload = { create, find }
    const req = { headers: new Headers({ 'x-request-id': 'test-trace-0001' }), payload }
    await expect(
      systemFindForJob(payload as never, { collection: 'orders', req: req as never }, ''),
    ).rejects.toThrow(/audit reason/)
    await systemFindForJob(
      payload as never,
      { collection: 'orders', req: req as never },
      'commerce recovery',
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'auditLogs',
        data: expect.objectContaining({
          actorType: 'system',
          targetId: 'orders',
          targetType: 'payload-collection',
          traceId: 'test-trace-0001',
        }),
        overrideAccess: true,
        req,
      }),
    )
  })
})
