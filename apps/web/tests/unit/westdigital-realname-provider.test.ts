import { describe, expect, it, vi } from 'vitest'

import { RealnameTemplates } from '@/collections/realname'
import {
  mapWestDigitalRealnameCreateFields,
  MockWestDigitalRealnameAdapter,
} from '@/providers/westdigital-realname'
import { assertRealnameStatusTransition } from '@/services/realname/templates'

import { realnameTemplateFixture } from '../fixtures/realname'

describe('D4 West Digital real-name mock adapter', () => {
  it('accepts only the real-name lifecycle and evidenced review transitions', () => {
    for (const [from, to] of [
      ['draft', 'pending_review'],
      ['draft', 'disabled'],
      ['pending_review', 'approved'],
      ['pending_review', 'rejected'],
      ['pending_review', 'manual_review'],
      ['pending_review', 'disabled'],
      ['approved', 'disabled'],
      ['rejected', 'draft'],
      ['rejected', 'disabled'],
      ['manual_review', 'approved'],
      ['manual_review', 'pending_review'],
      ['manual_review', 'rejected'],
      ['manual_review', 'disabled'],
    ] as const) {
      expect(() => assertRealnameStatusTransition(from, to)).not.toThrow()
    }
    for (const [from, to] of [
      ['draft', 'approved'],
      ['approved', 'rejected'],
      ['rejected', 'pending_review'],
      ['manual_review', 'draft'],
      ['disabled', 'draft'],
    ] as const) {
      expect(() => assertRealnameStatusTransition(from, to)).toThrow(/实名模板状态不能从/u)
    }
  })

  it('keeps sensitive identity fields out of the Payload Admin list surface', () => {
    const columns = RealnameTemplates.admin?.defaultColumns ?? []
    expect(columns).toEqual(['displayName', 'type', 'status', 'safeFailureReason', 'updatedAt'])
    expect(columns).not.toEqual(
      expect.arrayContaining(['email', 'identityDocumentNumber', 'phone', 'providerTemplateId']),
    )
  })

  it('maps the local v2 auditsub contract without network access or logging identity values', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const provider = new MockWestDigitalRealnameAdapter()
    const profile = realnameTemplateFixture()
    const result = await provider.createTemplate({
      profile,
      traceId: 'trace-realname-create',
    })

    expect(result).toMatchObject({
      data: { providerTemplateId: 'mock-realname-1', reviewState: 'pending' },
      ok: true,
    })
    expect(provider.createRequests[0]?.fields).toEqual({
      act: 'auditsub',
      c_adr: profile.addressEnglish,
      c_adr_m: profile.addressChinese,
      c_co: 'CN',
      c_ct: profile.cityEnglish,
      c_ct_m: profile.cityChinese,
      c_dt_m: profile.districtChinese,
      c_em: profile.email,
      c_fn: profile.contactFirstNameEnglish,
      c_fn_m: profile.contactFirstNameChinese,
      c_idnum_gswl: profile.identityDocumentNumber,
      c_idtype_gswl: 'SFZ',
      c_ln: profile.contactLastNameEnglish,
      c_ln_m: profile.contactLastNameChinese,
      c_org: '',
      c_org_m: '',
      c_pc: profile.postalCode,
      c_ph: profile.phone,
      c_ph_code: '',
      c_ph_fj: '',
      c_ph_num: '',
      c_ph_type: '0',
      c_regtype: 'I',
      c_st: profile.provinceEnglish,
      c_st_m: profile.provinceChinese,
      cocode: '+86',
      fullname: profile.fullNameChinese,
      reg_contact_type: 'cg',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requires organization names, maps landlines, and never treats unavailable as approved', async () => {
    expect(() =>
      mapWestDigitalRealnameCreateFields({
        ...realnameTemplateFixture(),
        type: 'organization',
      }),
    ).toThrow()

    const fields = mapWestDigitalRealnameCreateFields({
      ...realnameTemplateFixture(),
      identityDocumentType: 'YYZZ',
      organizationNameChinese: '成都万米科技有限公司',
      organizationNameEnglish: 'Chengdu Wanmi Technology Co Ltd',
      phone: '62778877',
      phoneAreaCode: '028',
      phoneExtension: '123',
      phoneType: 'landline',
      type: 'organization',
    })
    expect(fields).toMatchObject({
      c_org: 'Chengdu Wanmi Technology Co Ltd',
      c_org_m: '成都万米科技有限公司',
      c_ph: '',
      c_ph_code: '028',
      c_ph_fj: '123',
      c_ph_num: '62778877',
      c_ph_type: '1',
      c_regtype: 'E',
    })

    const unavailable = new MockWestDigitalRealnameAdapter({}, true)
    const result = await unavailable.createTemplate({
      profile: realnameTemplateFixture(),
      traceId: 'trace-realname-unavailable',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'WESTDIGITAL_REALNAME_UNAVAILABLE',
        statusKnown: false,
      })
    }
  })
})
