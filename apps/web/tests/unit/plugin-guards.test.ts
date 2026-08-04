import { describe, expect, it } from 'vitest'

import { validateRedirect, validateSafeForm } from '@/plugins/guards'

describe('official plugin boundaries', () => {
  it('rejects open and direct-loop redirects', async () => {
    const req = { payload: { find: async () => ({ docs: [] }) } }
    await expect(
      validateRedirect({
        data: { from: '/a', to: { type: 'custom', url: 'https://bad.test' } },
        req,
      } as never),
    ).rejects.toThrow(/站内/)
    await expect(
      validateRedirect({ data: { from: '/a', to: { type: 'custom', url: '/a' } }, req } as never),
    ).rejects.toThrow(/起点和终点/)
  })

  it('rejects payment and upload form blocks', () => {
    expect(() =>
      validateSafeForm({ data: { fields: [{ blockType: 'payment' }] } } as never),
    ).toThrow(/不允许/)
    expect(() =>
      validateSafeForm({ data: { fields: [{ blockType: 'upload' }] } } as never),
    ).toThrow(/不允许/)
  })
})
