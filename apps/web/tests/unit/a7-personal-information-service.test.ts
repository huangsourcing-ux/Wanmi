import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ recordAuditEvent: vi.fn() }))

vi.mock('@/services/audit/record-audit-event', () => ({
  recordAuditEvent: mocks.recordAuditEvent,
}))

import { readPersonalInformation } from '@/services/privacy/personal-information'

const customer = {
  accountType: 'registered',
  collection: 'customers',
  createdAt: '2026-08-16T10:00:00.000Z',
  defaultCustomerProfileType: 'individual',
  id: 42,
  legacyProfileCompletedAt: null,
  phone: '+8613900000042',
  phoneMasked: '139****0042',
  registrationSource: 'phone',
}

function payloadRequest() {
  const find = vi.fn(async (options: Record<string, unknown>) => {
    void options
    return { docs: [], totalDocs: 0 }
  })
  const findByID = vi.fn(async (options: Record<string, unknown>) => {
    void options
    return customer
  })
  const req = {
    headers: new Headers({ 'x-request-id': 'a7-personal-service' }),
    payload: { find, findByID },
    user: customer,
  }
  return { find, findByID, req }
}

beforeEach(() => {
  mocks.recordAuditEvent.mockReset().mockResolvedValue(undefined)
})

describe('D9-A A7 personal-information Local API boundary', () => {
  it('passes user, req, overrideAccess false, and an owner where clause to every personal-data read', async () => {
    const { find, findByID, req } = payloadRequest()
    await readPersonalInformation(req as never, { customerId: 42, mode: 'view' })

    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'customers',
        id: 42,
        overrideAccess: false,
        req,
        user: customer,
      }),
    )
    expect(find).toHaveBeenCalledTimes(6)
    expect(find.mock.calls.map(([options]) => options.collection)).toEqual([
      'customerIdentities',
      'consentRecords',
      'realnameTemplates',
      'realnameDocuments',
      'orders',
      'domainAssets',
    ])
    for (const [options] of find.mock.calls) {
      expect(options).toMatchObject({
        overrideAccess: false,
        req,
        user: customer,
        where: { customer: { equals: 42 } },
      })
    }
  })

  it('records the selected view/export action, explicit/default purpose, and bounded result counts', async () => {
    const first = payloadRequest()
    await readPersonalInformation(first.req as never, {
      customerId: 42,
      mode: 'export',
      purpose: 'verified privacy request',
    })
    expect(mocks.recordAuditEvent).toHaveBeenNthCalledWith(
      1,
      first.req,
      expect.objectContaining({
        action: 'customer.personal_information.exported',
        metadata: expect.objectContaining({
          mode: 'export',
          purpose: 'verified privacy request',
          recordCounts: {
            consents: 0,
            domainAssets: 0,
            identities: 0,
            orders: 0,
            realnameDocuments: 0,
            realnameTemplates: 0,
          },
        }),
        targetId: 42,
      }),
    )

    const second = payloadRequest()
    await readPersonalInformation(second.req as never, { customerId: 42, mode: 'view' })
    expect(mocks.recordAuditEvent).toHaveBeenNthCalledWith(
      2,
      second.req,
      expect.objectContaining({
        action: 'customer.personal_information.viewed',
        metadata: expect.objectContaining({ mode: 'view', purpose: 'customer_self_service' }),
      }),
    )
  })
})
