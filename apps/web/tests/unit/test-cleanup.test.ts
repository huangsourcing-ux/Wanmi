import { ValidationError, type Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import type { Admin } from '@/payload-types'

import {
  ANCHOR_SYSTEM_ADMIN_EMAIL,
  ensureAnchorSystemAdmin,
  findOrCreateUniqueFixture,
} from '../test-cleanup'

const anchor = {
  createdAt: '2026-08-08T00:00:00.000Z',
  email: ANCHOR_SYSTEM_ADMIN_EMAIL,
  id: 1,
  roles: ['system_admin'],
  status: 'active',
  updatedAt: '2026-08-08T00:00:00.000Z',
} as Admin

function uniqueError(path: string, tableName: string) {
  return new ValidationError({
    collection: 'admins',
    errors: [{ message: 'Value must be unique', path, tableName }],
  })
}

describe('shared test fixture helpers', () => {
  it('returns the raced anchor only after the expected admin email unique conflict', async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [anchor] })
    const create = vi.fn().mockRejectedValue(uniqueError('email', 'admins'))
    const payload = { create, find } as unknown as Payload

    await expect(ensureAnchorSystemAdmin(payload)).resolves.toBe(anchor)
    expect(find).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rethrows non-unique create failures without running a raced lookup', async () => {
    const failure = new Error('database unavailable')
    const find = vi.fn().mockResolvedValue({ docs: [] })
    const payload = {
      create: vi.fn().mockRejectedValue(failure),
      find,
    } as unknown as Payload

    await expect(ensureAnchorSystemAdmin(payload)).rejects.toBe(failure)
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('rethrows unique conflicts for any field other than the declared fixture key', async () => {
    const failure = uniqueError('username', 'admins')
    const find = vi.fn().mockResolvedValue(undefined)

    await expect(
      findOrCreateUniqueFixture({
        create: vi.fn().mockRejectedValue(failure),
        find,
        path: 'email',
        tableName: 'admins',
      }),
    ).rejects.toBe(failure)
    expect(find).toHaveBeenCalledTimes(1)
  })
})
