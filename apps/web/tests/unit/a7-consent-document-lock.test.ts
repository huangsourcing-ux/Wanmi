import { describe, expect, it } from 'vitest'

import { CONSENT_TYPES, type ConsentType } from '@/lib/domain'
import { registrationConsentDocument } from '@/services/auth/registration-consents'

type LockedConsentDocument = {
  documentHash: string
  documentVersion: string
}

const CONSENT_DOCUMENT_LOCK = {
  automatic_renewal: {
    documentHash: 'bc8f1498187395c84db263aa86c2dca9f1e41cfc06dc89b5575997aa772721f7',
    documentVersion: 'consent-automatic-renewal-2026-08-16',
  },
  commercial_sms: {
    documentHash: '9660c2f1e55948f359fbc7c34b3b097ab56487ce02a4d606d182537f8862e4e6',
    documentVersion: 'consent-commercial-sms-2026-08-16',
  },
  device_identifier_notice: {
    documentHash: 'aa9ccfc0bdcf2824091460db88926eeccf7f82499495956feeff144f7a80a9ca',
    documentVersion: 'consent-device-identifier-2026-08-16',
  },
  invitation_attribution: {
    documentHash: '1128b53764c1584cc45bf1f7dc6c733ab600e01aa579110f8fc2b8cff1680220',
    documentVersion: 'consent-invitation-attribution-2026-08-16',
  },
  privacy_policy: {
    documentHash: 'ff11acf8a873e93ef92d34c95a4af90e28e1f1833b0983132a4d9286a0c77250',
    documentVersion: 'legal-config-privacy-2026-08-12',
  },
  sensitive_personal_information: {
    documentHash: '8ff7d108121b4e878672cac164b117a435019be3d9783d303a47dea8559929c0',
    documentVersion: 'consent-sensitive-personal-information-2026-08-16',
  },
  service_terms: {
    documentHash: '1f841f96e70e5bd4da8cf09867b25171c9a1e0624057ffd4e6da65a149a26940',
    documentVersion: 'legal-config-terms-2026-08-12',
  },
  wechat_profile: {
    documentHash: 'e6855f445d8e65ea8359f9036b3fb9f15436c03a879485141aeaaa0bbac4cc0e',
    documentVersion: 'consent-wechat-profile-2026-08-16',
  },
} as const satisfies Record<ConsentType, LockedConsentDocument>

describe('D9-A A7 consent document evidence lock', () => {
  it('binds every consent document version to its exact content hash', () => {
    expect(Object.keys(CONSENT_DOCUMENT_LOCK).sort()).toEqual([...CONSENT_TYPES].sort())

    for (const consentType of CONSENT_TYPES) {
      expect(registrationConsentDocument(consentType), consentType).toEqual(
        CONSENT_DOCUMENT_LOCK[consentType],
      )
    }
  })
})
