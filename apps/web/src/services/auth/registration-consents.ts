import { createHash } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import type { ConsentType } from '@/lib/domain'
import { LEGAL_DOCUMENTS, type LegalDocument } from '@/lib/legal-config'

import { maskedClientIp, userAgentSummary } from './client-facts'

type ConsentDocumentSnapshot = {
  documentHash: string
  documentVersion: string
}

export type ConsentRecordSource =
  | 'account_privacy_center'
  | 'legacy_profile_completion'
  | 'phone_registration'
  | 'wechat_oauth_registration'
  | 'wechat_qrcode_registration'

const versions: Record<ConsentType, string> = {
  automatic_renewal: 'consent-automatic-renewal-2026-08-16',
  commercial_sms: 'consent-commercial-sms-2026-08-16',
  device_identifier_notice: 'consent-device-identifier-2026-08-16',
  invitation_attribution: 'consent-invitation-attribution-2026-08-16',
  privacy_policy: 'legal-config-privacy-2026-08-12',
  sensitive_personal_information: 'consent-sensitive-personal-information-2026-08-16',
  service_terms: 'legal-config-terms-2026-08-12',
  wechat_profile: 'consent-wechat-profile-2026-08-16',
}

const consentDocuments = {
  automatic_renewal: {
    purpose: '记录自动续费授权文本快照；实际扣款仍必须依赖独立 renewalMandate。',
    scope: '授权域名、最大扣款金额、有效期和撤回方式',
  },
  commercial_sms: {
    purpose: '允许发送可退订的商业短信；交易与安全通知不受本选择影响。',
    scope: '商业活动与产品推广短信',
  },
  device_identifier_notice: {
    purpose: '说明第一方 deviceId 仅用于会话安全、限频和反滥用。',
    scope: '不采集 Canvas、字体或显卡等设备指纹',
  },
  invitation_attribution: {
    purpose: '说明邀请码会记录邀请人与被邀请人的归因关系。',
    scope: '邀请归因与反作弊',
  },
  sensitive_personal_information: {
    purpose: '单独同意处理域名实名所需的证件与身份信息。',
    scope: '实名模板、证件文件、上游实名审核与依法留存',
  },
  wechat_profile: {
    purpose: '允许保存微信头像和昵称；未同意时不得保存。',
    scope: '微信头像与昵称',
  },
} as const

function legalSlug(type: 'privacy_policy' | 'service_terms'): 'privacy' | 'terms' {
  return type === 'privacy_policy' ? 'privacy' : 'terms'
}

function consentDocumentContent(
  type: ConsentType,
  legalDocuments: readonly LegalDocument[],
): unknown {
  if (type === 'privacy_policy' || type === 'service_terms') {
    const document = legalDocuments.find((candidate) => candidate.slug === legalSlug(type))
    if (!document) throw new Error(`Registration legal document is missing: ${type}`)
    return document
  }
  return consentDocuments[type]
}

export function registrationConsentDocument(
  type: ConsentType,
  legalDocuments: readonly LegalDocument[] = LEGAL_DOCUMENTS,
): ConsentDocumentSnapshot {
  const document = consentDocumentContent(type, legalDocuments)
  return {
    documentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    documentVersion: versions[type],
  }
}

export async function appendConsentAcceptance(
  req: PayloadRequest,
  input: {
    acceptedAt: string
    consentType: ConsentType
    customerId: number
    headers: Headers
    source: ConsentRecordSource
  },
) {
  return req.payload.create({
    collection: 'consentRecords',
    data: {
      acceptedAt: input.acceptedAt,
      consentType: input.consentType,
      ...registrationConsentDocument(input.consentType),
      customer: input.customerId,
      ipMasked: maskedClientIp(input.headers),
      source: input.source,
      userAgentSummary: userAgentSummary(input.headers),
    },
    overrideAccess: true,
    req,
  })
}
