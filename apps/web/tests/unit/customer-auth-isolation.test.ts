import { describe, expect, it } from 'vitest'

import { Admins, Customers } from '@/collections/identity'
import { getEnv } from '@/lib/env'

describe('customer and administrator authentication isolation', () => {
  it('uses separate collections, strategies, and cookies', () => {
    const customerAuth = typeof Customers.auth === 'object' ? Customers.auth : undefined
    expect(Admins.slug).toBe('admins')
    expect(Customers.slug).toBe('customers')
    expect(customerAuth).toMatchObject({
      disableLocalStrategy: true,
      useSessions: false,
    })
    expect(customerAuth?.strategies).toEqual([
      expect.objectContaining({ name: 'wanmi-customer-session' }),
    ])
    expect(Admins.auth).not.toMatchObject({ disableLocalStrategy: true })
    expect(getEnv().CUSTOMER_SESSION_COOKIE).toBe('wanmi_customer_session')
    expect(getEnv().CUSTOMER_SESSION_COOKIE).not.toBe('wanmi_admin-token')
  })

  it('keeps customer phone login unique and password-free', () => {
    const phoneField = Customers.fields.find((field) => 'name' in field && field.name === 'phone')
    expect(phoneField).toMatchObject({ required: true, type: 'text', unique: true })
    expect(Customers.fields.some((field) => 'name' in field && field.name === 'password')).toBe(
      false,
    )
  })
})
