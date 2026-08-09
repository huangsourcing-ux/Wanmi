import { ValidationError, type Payload } from 'payload'

import type { Admin } from '@/payload-types'

export const ANCHOR_SYSTEM_ADMIN_EMAIL = 'integration-system-admin-anchor@example.test'
export const ANCHOR_SYSTEM_ADMIN_PASSWORD = 'Integration-anchor-password-2026'

export async function findOrCreateUniqueFixture<T>(options: {
  create: () => Promise<T>
  find: () => Promise<T | undefined>
  path: string
  tableName: string
}): Promise<{ created: boolean; value: T }> {
  const existing = await options.find()
  if (existing) return { created: false, value: existing }

  try {
    return { created: true, value: await options.create() }
  } catch (error) {
    const isExpectedUniqueConflict =
      error instanceof ValidationError &&
      error.data.errors.some(
        (fieldError) =>
          fieldError.path === options.path &&
          (fieldError.tableName === options.tableName ||
            (fieldError.tableName === undefined &&
              error.data.collection === options.tableName)),
      )
    if (!isExpectedUniqueConflict) throw error

    const raced = await options.find()
    if (raced) return { created: false, value: raced }
    throw error
  }
}

export async function ensureAnchorSystemAdmin(payload: Payload): Promise<Admin> {
  const result = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'admins',
        context: { adminAccountOperation: 'bootstrap' },
        data: {
          email: ANCHOR_SYSTEM_ADMIN_EMAIL,
          password: ANCHOR_SYSTEM_ADMIN_PASSWORD,
          roles: ['system_admin'],
          status: 'active',
        },
        overrideAccess: true,
      }),
    find: async () => {
      const existing = await payload.find({
        collection: 'admins',
        limit: 1,
        overrideAccess: true,
        where: { email: { equals: ANCHOR_SYSTEM_ADMIN_EMAIL } },
      })
      return existing.docs[0]
    },
    path: 'email',
    tableName: 'admins',
  })
  return result.value
}

export async function ignorePayloadNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    ) {
      return
    }
    throw error
  }
}
