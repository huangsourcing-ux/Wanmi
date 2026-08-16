import { describe, expect, it, vi } from 'vitest'

import {
  assertCustomerConsentActive,
  assertLegacyRegistrationPurchaseAllowed,
} from '@/services/privacy/customer-consents'

describe('D9-A A7 consent Local API boundary', () => {
  it('uses owner access, stable newest-first ordering, and a customer-scoped where clause', async () => {
    const user = { collection: 'customers', id: 42 }
    const find = vi.fn(async (options: Record<string, unknown>) => {
      void options
      return { docs: [] }
    })
    const req = { headers: new Headers(), payload: { find }, user }
    await expect(
      assertCustomerConsentActive(req as never, 42, 'sensitive_personal_information'),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'consentRecords',
        overrideAccess: false,
        req,
        sort: '-id',
        user,
        where: { customer: { equals: 42 } },
      }),
    )
  })

  it('uses an explicit audited-system bypass only when no user is present', async () => {
    const find = vi.fn(async (options: Record<string, unknown>) => {
      void options
      return { docs: [] }
    })
    const req = { headers: new Headers(), payload: { find }, user: undefined }
    await expect(
      assertCustomerConsentActive(req as never, 42, 'sensitive_personal_information'),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ overrideAccess: true, req, where: { customer: { equals: 42 } } }),
    )
    expect(find.mock.calls[0]?.[0]).not.toHaveProperty('user')
  })

  it('passes user, req, and overrideAccess false when loading a legacy purchase customer', async () => {
    const user = { collection: 'customers', id: 42 }
    const findByID = vi.fn(async (options: Record<string, unknown>) => {
      void options
      return {
        accountType: 'registered',
        id: 42,
      }
    })
    const req = { headers: new Headers(), payload: { findByID }, user }
    await expect(assertLegacyRegistrationPurchaseAllowed(req as never, 42)).resolves.toBeUndefined()
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'customers',
        id: 42,
        overrideAccess: false,
        req,
        user,
      }),
    )
  })
})
