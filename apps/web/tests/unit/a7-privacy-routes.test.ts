import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticatedCustomerRequest: vi.fn(),
  completeLegacyCustomerProfile: vi.fn(),
  getPayload: vi.fn(),
  readPersonalInformation: vi.fn(),
  recordCustomerConsentDecision: vi.fn(),
  systemAdminRequest: vi.fn(),
}))

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  getPayload: mocks.getPayload,
}))

vi.mock('@/services/auth/otp', () => ({
  authenticatedCustomerRequest: mocks.authenticatedCustomerRequest,
}))

vi.mock('@/services/auth/admin-session', () => ({
  systemAdminRequest: mocks.systemAdminRequest,
}))

vi.mock('@/services/privacy/customer-consents', () => ({
  completeLegacyCustomerProfile: mocks.completeLegacyCustomerProfile,
  recordCustomerConsentDecision: mocks.recordCustomerConsentDecision,
}))

vi.mock('@/services/privacy/personal-information', () => ({
  readPersonalInformation: mocks.readPersonalInformation,
}))

import { POST as consentPost } from '@/app/api/v1/account/consents/route'
import { POST as legacyCompletionPost } from '@/app/api/v1/account/legacy-profile-completion/route'
import { GET as personalInformationGet } from '@/app/api/v1/account/personal-information/route'
import { GET as personalInformationExportGet } from '@/app/api/v1/account/personal-information/export/route'
import { GET as adminPersonalInformationGet } from '@/app/api/v1/admin/customers/[customerId]/personal-information/route'
import { AppError } from '@/lib/errors'

const customer = {
  collection: 'customers',
  id: 42,
  phone: '+8613900000042',
  phoneMasked: '139****0042',
}
const req = { headers: new Headers(), user: customer }

function personalInformation() {
  return {
    consents: [],
    domainAssets: [],
    generatedAt: '2026-08-16T12:00:00.000Z',
    identities: [],
    orders: [],
    profile: {
      accountType: 'registered',
      createdAt: '2026-08-16T10:00:00.000Z',
      defaultCustomerProfileType: 'individual',
      id: 42,
      legacyProfileCompletedAt: null,
      phone: customer.phone,
      phoneMasked: customer.phoneMasked,
      registrationSource: 'phone',
    },
    realnameDocuments: [],
    realnameTemplates: [],
    retention: {
      accountAndTransactionSchedule: 'pending_external_legal_review',
      consentHistory: 'append_only_evidence',
      exportPersistence: 'not_persisted',
      realnameDeletionDeadlineDays: 30,
    },
    rights: {
      accountDeletionPath: '/api/v1/auth/deletion-request',
      defaultProfileCorrectionPath: '/api/v1/account/default-profile-type',
      identityCorrectionPath: '/api/v1/account/identities/bind',
      realnameCorrectionPath: '/api/v1/realname/templates/:templateId',
    },
  }
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://wanmi.local${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': 'a7-route-test' },
    method: 'POST',
  })
}

function adminContext(customerId: string) {
  return { params: Promise.resolve({ customerId }) }
}

beforeEach(() => {
  mocks.getPayload.mockReset().mockResolvedValue({})
  mocks.authenticatedCustomerRequest.mockReset().mockResolvedValue({ req, user: customer })
  mocks.systemAdminRequest.mockReset().mockResolvedValue({
    req: {
      headers: new Headers(),
      user: { collection: 'admins', id: 7, roles: ['system_admin'], status: 'active' },
    },
    user: { id: 7 },
  })
  mocks.recordCustomerConsentDecision.mockReset().mockResolvedValue({
    active: true,
    changed: true,
    consentType: 'commercial_sms',
  })
  mocks.completeLegacyCustomerProfile.mockReset().mockResolvedValue({
    completedAt: '2026-08-16T12:00:00.000Z',
    profileCompletionRequired: false,
  })
  mocks.readPersonalInformation.mockReset().mockResolvedValue(personalInformation())
})

describe('D9-A A7 privacy routes', () => {
  it('validates and routes an authenticated optional-consent decision', async () => {
    const response = await consentPost(
      jsonRequest('/api/v1/account/consents', {
        consentType: 'commercial_sms',
        decision: 'accept',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.recordCustomerConsentDecision).toHaveBeenCalledWith(req, customer, {
      consentType: 'commercial_sms',
      decision: 'accept',
    })
  })

  it('fails closed at the customer-session gate for every self-service A7 route', async () => {
    mocks.authenticatedCustomerRequest.mockRejectedValue(
      new AppError('CUSTOMER_AUTH_REQUIRED', 'customer auth required', 401),
    )
    const responses = await Promise.all([
      consentPost(
        jsonRequest('/api/v1/account/consents', {
          consentType: 'commercial_sms',
          decision: 'accept',
        }),
      ),
      legacyCompletionPost(
        jsonRequest('/api/v1/account/legacy-profile-completion', {
          acceptedPrivacyPolicy: true,
          acceptedServiceTerms: true,
          confirmsAdultOrAuthorizedRepresentative: true,
          defaultCustomerProfileType: 'individual',
        }),
      ),
      personalInformationGet(new Request('http://wanmi.local/api/v1/account/personal-information')),
      personalInformationExportGet(
        new Request('http://wanmi.local/api/v1/account/personal-information/export'),
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401])
    expect(mocks.recordCustomerConsentDecision).not.toHaveBeenCalled()
    expect(mocks.completeLegacyCustomerProfile).not.toHaveBeenCalled()
    expect(mocks.readPersonalInformation).not.toHaveBeenCalled()
  })

  it('rejects mandatory-consent changes at the route schema before authentication', async () => {
    const response = await consentPost(
      jsonRequest('/api/v1/account/consents', {
        consentType: 'service_terms',
        decision: 'revoke',
      }),
    )
    expect(response.status).toBe(400)
    expect(mocks.authenticatedCustomerRequest).not.toHaveBeenCalled()
    expect(mocks.recordCustomerConsentDecision).not.toHaveBeenCalled()
  })

  it('requires every declaration before routing legacy profile completion', async () => {
    const incomplete = await legacyCompletionPost(
      jsonRequest('/api/v1/account/legacy-profile-completion', {
        acceptedPrivacyPolicy: true,
        acceptedServiceTerms: true,
        defaultCustomerProfileType: 'individual',
      }),
    )
    expect(incomplete.status).toBe(400)
    expect(mocks.completeLegacyCustomerProfile).not.toHaveBeenCalled()

    const complete = await legacyCompletionPost(
      jsonRequest('/api/v1/account/legacy-profile-completion', {
        acceptedPrivacyPolicy: true,
        acceptedServiceTerms: true,
        confirmsAdultOrAuthorizedRepresentative: true,
        defaultCustomerProfileType: 'individual',
      }),
    )
    expect(complete.status).toBe(200)
    expect(mocks.completeLegacyCustomerProfile).toHaveBeenCalledWith(req, customer, {
      acceptedPrivacyPolicy: true,
      acceptedServiceTerms: true,
      confirmsAdultOrAuthorizedRepresentative: true,
      defaultCustomerProfileType: 'individual',
    })
  })

  it('binds self-service view and export to the authenticated customer with private-cache headers', async () => {
    const view = await personalInformationGet(
      new Request('http://wanmi.local/api/v1/account/personal-information'),
    )
    expect(view.status).toBe(200)
    expect(view.headers.get('cache-control')).toBe('no-store')
    expect(mocks.readPersonalInformation).toHaveBeenNthCalledWith(1, req, {
      customerId: 42,
      mode: 'view',
    })

    const exported = await personalInformationExportGet(
      new Request('http://wanmi.local/api/v1/account/personal-information/export'),
    )
    expect(exported.status).toBe(200)
    expect(exported.headers.get('cache-control')).toBe('no-store')
    expect(exported.headers.get('content-disposition')).toContain('attachment')
    expect(mocks.readPersonalInformation).toHaveBeenNthCalledWith(2, req, {
      customerId: 42,
      mode: 'export',
    })
  })

  it.each(['NaN', '1.5', '0', '-1'])(
    'rejects invalid admin customer id %s before auth',
    async (id) => {
      const response = await adminPersonalInformationGet(
        new Request(
          'http://wanmi.local/api/v1/admin/customers/bad/personal-information?purpose=audit',
        ),
        adminContext(id),
      )
      expect(response.status).toBe(400)
      expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
      expect(mocks.readPersonalInformation).not.toHaveBeenCalled()
    },
  )

  it('requires an explicit admin access purpose before authentication', async () => {
    const response = await adminPersonalInformationGet(
      new Request('http://wanmi.local/api/v1/admin/customers/42/personal-information'),
      adminContext('42'),
    )
    expect(response.status).toBe(400)
    expect(mocks.systemAdminRequest).not.toHaveBeenCalled()
  })

  it('fails closed at the system-admin gate and never reads personal information', async () => {
    mocks.systemAdminRequest.mockRejectedValueOnce(
      new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', 'system admin required', 403),
    )
    const response = await adminPersonalInformationGet(
      new Request(
        'http://wanmi.local/api/v1/admin/customers/42/personal-information?purpose=privacy%20request',
      ),
      adminContext('42'),
    )
    expect(response.status).toBe(403)
    expect(mocks.readPersonalInformation).not.toHaveBeenCalled()
  })

  it('passes the bounded purpose and numeric customer id through the system-admin route', async () => {
    const response = await adminPersonalInformationGet(
      new Request(
        'http://wanmi.local/api/v1/admin/customers/42/personal-information?purpose=privacy%20request',
      ),
      adminContext('42'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.readPersonalInformation).toHaveBeenCalledWith(expect.anything(), {
      customerId: 42,
      mode: 'view',
      purpose: 'privacy request',
    })
  })
})
