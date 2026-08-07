import { z } from 'zod'

import type { ProviderResult } from '@/lib/domain'

import { mockFailure, mockSuccess } from './mock'
import type {
  WestDigitalRealnameProfile,
  WestDigitalRealnameProvider,
  WestDigitalRealnameReviewState,
} from './types'

export type WestDigitalRealnameCreateFields = {
  act: 'auditsub'
  c_adr: string
  c_adr_m: string
  c_co: string
  c_ct: string
  c_ct_m: string
  c_dt_m: string
  c_em: string
  c_fn: string
  c_fn_m: string
  c_idnum_gswl: string
  c_idtype_gswl: string
  c_ln: string
  c_ln_m: string
  c_org: string
  c_org_m: string
  c_pc: string
  c_ph: string
  c_ph_code: string
  c_ph_fj: string
  c_ph_num: string
  c_ph_type: '0' | '1'
  c_regtype: 'E' | 'I'
  c_st: string
  c_st_m: string
  cocode: string
  fullname: string
  reg_contact_type: string
}

const profileSchema = z
  .object({
    addressChinese: z.string().trim().min(4).max(64),
    addressEnglish: z.string().trim().min(9).max(150),
    applicableScopes: z
      .array(z.enum(['cg', 'gswl', 'hk']))
      .min(1)
      .max(3),
    cityChinese: z.string().trim().min(1).max(20),
    cityEnglish: z.string().trim().min(2).max(50),
    contactFirstNameChinese: z.string().trim().min(1).max(16),
    contactFirstNameEnglish: z.string().trim().min(1).max(50),
    contactLastNameChinese: z.string().trim().min(1).max(16),
    contactLastNameEnglish: z.string().trim().min(1).max(50),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/u),
    districtChinese: z.string().trim().min(1).max(20),
    email: z.email().max(254),
    fullNameChinese: z.string().trim().min(2).max(50),
    identityDocumentNumber: z.string().trim().min(3).max(64),
    identityDocumentType: z.string().trim().min(2).max(16),
    organizationNameChinese: z.string().trim().min(2).max(32).optional(),
    organizationNameEnglish: z.string().trim().min(4).max(150).optional(),
    phone: z.string().trim().min(3).max(32),
    phoneAreaCode: z.string().trim().min(2).max(8).optional(),
    phoneCountryCode: z
      .string()
      .trim()
      .regex(/^\+\d{1,4}$/u),
    phoneExtension: z.string().trim().max(8).optional(),
    phoneType: z.enum(['landline', 'mobile']),
    postalCode: z.string().trim().min(5).max(8),
    provinceChinese: z.string().trim().min(2).max(10),
    provinceEnglish: z.string().trim().min(2).max(50),
    type: z.enum(['individual', 'organization']),
  })
  .superRefine((profile, context) => {
    if (
      profile.type === 'organization' &&
      (!profile.organizationNameChinese || !profile.organizationNameEnglish)
    ) {
      context.addIssue({ code: 'custom', message: 'organization names are required' })
    }
    if (profile.phoneType === 'landline' && !profile.phoneAreaCode) {
      context.addIssue({ code: 'custom', message: 'landline area code is required' })
    }
  })

export function mapWestDigitalRealnameCreateFields(
  input: WestDigitalRealnameProfile,
): WestDigitalRealnameCreateFields {
  const profile = profileSchema.parse(input)
  const landline = profile.phoneType === 'landline'
  return {
    act: 'auditsub',
    c_adr: profile.addressEnglish,
    c_adr_m: profile.addressChinese,
    c_co: profile.countryCode,
    c_ct: profile.cityEnglish,
    c_ct_m: profile.cityChinese,
    c_dt_m: profile.districtChinese,
    c_em: profile.email,
    c_fn: profile.contactFirstNameEnglish,
    c_fn_m: profile.contactFirstNameChinese,
    c_idnum_gswl: profile.identityDocumentNumber,
    c_idtype_gswl: profile.identityDocumentType,
    c_ln: profile.contactLastNameEnglish,
    c_ln_m: profile.contactLastNameChinese,
    c_org: profile.organizationNameEnglish ?? '',
    c_org_m: profile.organizationNameChinese ?? '',
    c_pc: profile.postalCode,
    c_ph: landline ? '' : profile.phone,
    c_ph_code: landline ? (profile.phoneAreaCode ?? '') : '',
    c_ph_fj: landline ? (profile.phoneExtension ?? '') : '',
    c_ph_num: landline ? profile.phone : '',
    c_ph_type: landline ? '1' : '0',
    c_regtype: profile.type === 'organization' ? 'E' : 'I',
    c_st: profile.provinceEnglish,
    c_st_m: profile.provinceChinese,
    cocode: profile.phoneCountryCode,
    fullname: profile.fullNameChinese,
    reg_contact_type: [...new Set(profile.applicableScopes)].join(','),
  }
}

type MockReviewFixture =
  | {
      reviewState: WestDigitalRealnameReviewState
      safeFailureReason?: 'identity_mismatch' | 'material_invalid' | 'other'
    }
  | 'unavailable'

export class MockWestDigitalRealnameAdapter implements WestDigitalRealnameProvider {
  readonly createRequests: Array<{
    fields: WestDigitalRealnameCreateFields
    traceId: string
  }> = []
  readonly queryRequests: Array<{ providerTemplateId: string; traceId: string }> = []
  private sequence = 0

  constructor(
    private readonly fixtures: Readonly<Record<string, MockReviewFixture>> = {},
    private readonly createUnavailable = false,
  ) {}

  async health(): Promise<ProviderResult<{ healthy: boolean }>> {
    return mockSuccess({ healthy: !this.createUnavailable }, 'mock-westdigital-realname-health')
  }

  async createTemplate(input: {
    profile: WestDigitalRealnameProfile
    traceId: string
  }): Promise<ProviderResult<{ providerTemplateId: string; reviewState: 'pending' }>> {
    const fields = mapWestDigitalRealnameCreateFields(input.profile)
    this.createRequests.push({ fields, traceId: input.traceId })
    if (this.createUnavailable) {
      return mockFailure('WESTDIGITAL_REALNAME_UNAVAILABLE', {
        retryable: true,
        statusKnown: false,
      })
    }
    this.sequence += 1
    return mockSuccess(
      { providerTemplateId: `mock-realname-${this.sequence}`, reviewState: 'pending' },
      `mock-westdigital-realname-create-${this.sequence}`,
    )
  }

  async queryTemplate(input: { providerTemplateId: string; traceId: string }): Promise<
    ProviderResult<{
      reviewState: WestDigitalRealnameReviewState
      safeFailureReason?: 'identity_mismatch' | 'material_invalid' | 'other'
    }>
  > {
    this.queryRequests.push(input)
    const fixture = this.fixtures[input.providerTemplateId] ?? { reviewState: 'pending' as const }
    if (fixture === 'unavailable') {
      return mockFailure('WESTDIGITAL_REALNAME_UNAVAILABLE', {
        retryable: true,
        statusKnown: false,
      })
    }
    return mockSuccess(fixture, `mock-westdigital-realname-query-${input.providerTemplateId}`)
  }
}
