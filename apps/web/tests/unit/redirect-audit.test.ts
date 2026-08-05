import { describe, expect, it, vi } from 'vitest'

import { auditRedirectChange, auditRedirectDelete } from '@/plugins/guards'

describe('redirect audit hooks', () => {
  it('writes create and delete audits through the mutation request', async () => {
    const create = vi.fn().mockResolvedValue({ id: 99 })
    const req = {
      headers: new Headers({ 'x-request-id': 'redirect-audit-trace' }),
      payload: { create },
      user: { collection: 'admins', id: 7, roles: ['system_admin'] },
    }
    const doc = {
      from: '/old',
      id: 42,
      to: { type: 'custom', url: '/new' },
      type: '301',
    }

    await auditRedirectChange({ doc, operation: 'create', req } as never)
    await auditRedirectDelete({ doc, req } as never)

    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        collection: 'auditLogs',
        data: expect.objectContaining({
          action: 'redirect.create',
          actorId: '7',
          actorType: 'admin',
          targetId: '42',
          traceId: 'redirect-audit-trace',
        }),
        overrideAccess: true,
        req,
      }),
    )
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ action: 'redirect.delete' }),
        req,
      }),
    )
  })
})
