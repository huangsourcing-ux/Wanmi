import type { AuthStrategy } from 'payload'

import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { assertCustomerAccountCapabilityFromSnapshot } from '@/services/auth/account-state'

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return null
}

export const customerSessionStrategy: AuthStrategy = {
  name: 'wanmi-customer-session',
  authenticate: async ({ headers, payload }) => {
    const env = getEnv()
    const rawToken = cookieValue(headers.get('cookie'), env.CUSTOMER_SESSION_COOKIE)
    if (!rawToken) return { user: null }

    const sessions = await payload.find({
      collection: 'customerSessions',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { tokenHash: { equals: hmac(rawToken, env.SESSION_PEPPER) } },
          { expiresAt: { greater_than: new Date().toISOString() } },
          { revokedAt: { exists: false } },
        ],
      },
    })
    const session = sessions.docs[0]
    if (!session) return { user: null }

    const customerId = typeof session.customer === 'object' ? session.customer.id : session.customer
    const customer = await payload.findByID({
      collection: 'customers',
      id: customerId,
      overrideAccess: true,
    })
    try {
      assertCustomerAccountCapabilityFromSnapshot(customer, 'login')
    } catch {
      return { user: null }
    }
    return { user: { ...customer, collection: 'customers' as const } }
  },
}
