import { describe, expect, it } from 'vitest'

import { customerSelfOrSystemFieldRead } from '@/access/roles'
import { customerRegistrationSchema } from '@/schemas/auth'
import {
  adminPersonalInformationQuerySchema,
  customerConsentDecisionSchema,
  legacyProfileCompletionSchema,
} from '@/schemas/privacy'
import { registrationConsentDocument } from '@/services/auth/registration-consents'

function registration(overrides: Record<string, unknown> = {}) {
  return {
    acceptedDeviceIdentifierNotice: true,
    acceptedPrivacyPolicy: true,
    acceptedServiceTerms: true,
    confirmsAdultOrAuthorizedRepresentative: true,
    defaultCustomerProfileType: 'individual',
    deviceId: 'a7-schema-device-0001',
    registrationToken: 'a'.repeat(43),
    ...overrides,
  }
}

describe('D9-A A7 privacy schemas', () => {
  it('fails closed with the missing legal document named in the error', () => {
    expect(() => registrationConsentDocument('service_terms', [])).toThrowError(
      'Registration legal document is missing: service_terms',
    )
    expect(() => registrationConsentDocument('privacy_policy', [])).toThrowError(
      'Registration legal document is missing: privacy_policy',
    )
  })

  it('reveals a customer phone only to that customer or a system administrator', () => {
    const access = (user: unknown, id?: number) =>
      customerSelfOrSystemFieldRead({ id, req: { user } } as never)
    expect(
      access({ collection: 'admins', id: 7, roles: ['system_admin'], status: 'active' }, 42),
    ).toBe(true)
    expect(access({ collection: 'customers', id: 42 }, 42)).toBe(true)
    expect(access({ collection: 'customers', id: 41 }, 42)).toBe(false)
    expect(access({ collection: 'admins', id: 42, roles: ['analyst'], status: 'active' }, 42)).toBe(
      false,
    )
    expect(access(undefined, 42)).toBe(false)
    expect(access({ collection: 'customers', id: 42 })).toBe(false)
  })

  it('defaults commercial SMS to false and accepts an explicit opt-in', () => {
    expect(customerRegistrationSchema.parse(registration()).commercialSmsOptIn).toBe(false)
    expect(
      customerRegistrationSchema.parse(registration({ commercialSmsOptIn: true }))
        .commercialSmsOptIn,
    ).toBe(true)
  })

  it('requires the device-identifier notice and rejects unexpected registration fields', () => {
    const withoutNotice = registration()
    Reflect.deleteProperty(withoutNotice, 'acceptedDeviceIdentifierNotice')
    expect(customerRegistrationSchema.safeParse(withoutNotice).success).toBe(false)
    expect(
      customerRegistrationSchema.safeParse(registration({ providerSecret: 'must-not-pass' }))
        .success,
    ).toBe(false)
  })

  it('requires invitation-attribution consent exactly when an invitation code is present', () => {
    expect(
      customerRegistrationSchema.safeParse(registration({ invitationCode: 'ABCDEF123456' }))
        .success,
    ).toBe(false)
    expect(
      customerRegistrationSchema.safeParse(registration({ acceptedInvitationAttribution: true }))
        .success,
    ).toBe(false)
    expect(
      customerRegistrationSchema.safeParse(
        registration({
          acceptedInvitationAttribution: true,
          invitationCode: 'ABCDEF123456',
        }),
      ).success,
    ).toBe(true)
  })

  it('limits privacy-center decisions to the five optional customer-managed types', () => {
    for (const consentType of [
      'commercial_sms',
      'device_identifier_notice',
      'invitation_attribution',
      'sensitive_personal_information',
      'wechat_profile',
    ]) {
      expect(
        customerConsentDecisionSchema.safeParse({ consentType, decision: 'accept' }).success,
      ).toBe(true)
    }
    for (const consentType of ['service_terms', 'privacy_policy', 'automatic_renewal']) {
      expect(
        customerConsentDecisionSchema.safeParse({ consentType, decision: 'revoke' }).success,
      ).toBe(false)
    }
    expect(
      customerConsentDecisionSchema.safeParse({
        consentType: 'commercial_sms',
        decision: 'accept',
        providerSecret: 'must-not-pass',
      }).success,
    ).toBe(false)
  })

  it('requires real terms, privacy, eligibility declarations, and a default type for legacy completion', () => {
    const complete = {
      acceptedPrivacyPolicy: true,
      acceptedServiceTerms: true,
      confirmsAdultOrAuthorizedRepresentative: true,
      defaultCustomerProfileType: 'organization',
    }
    expect(legacyProfileCompletionSchema.safeParse(complete).success).toBe(true)
    for (const field of [
      'acceptedPrivacyPolicy',
      'acceptedServiceTerms',
      'confirmsAdultOrAuthorizedRepresentative',
      'defaultCustomerProfileType',
    ]) {
      expect(
        legacyProfileCompletionSchema.safeParse(
          Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field)),
        ).success,
      ).toBe(false)
    }
  })

  it('requires a bounded, non-blank purpose for admin personal-information access', () => {
    expect(
      adminPersonalInformationQuerySchema.safeParse({ purpose: 'privacy request' }).success,
    ).toBe(true)
    expect(adminPersonalInformationQuerySchema.safeParse({ purpose: '   ' }).success).toBe(false)
    expect(
      adminPersonalInformationQuerySchema.safeParse({ purpose: 'x'.repeat(257) }).success,
    ).toBe(false)
  })
})
