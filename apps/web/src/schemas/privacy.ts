import { z } from 'zod'

import { CONSENT_TYPES, CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES } from '@/lib/domain'

export const consentTypeSchema = z.enum(CONSENT_TYPES)
export const customerManagedConsentTypeSchema = z.enum(CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES)

export const customerConsentDecisionSchema = z
  .object({
    consentType: customerManagedConsentTypeSchema,
    decision: z.enum(['accept', 'revoke']),
  })
  .strict()

export const legacyProfileCompletionSchema = z
  .object({
    acceptedPrivacyPolicy: z.literal(true),
    acceptedServiceTerms: z.literal(true),
    confirmsAdultOrAuthorizedRepresentative: z.literal(true),
    defaultCustomerProfileType: z.enum(['individual', 'organization']),
  })
  .strict()

export const consentDecisionResponseSchema = z.object({
  active: z.boolean(),
  changed: z.boolean(),
  consentType: customerManagedConsentTypeSchema,
})

export const legacyProfileCompletionResponseSchema = z.object({
  completedAt: z.iso.datetime(),
  profileCompletionRequired: z.literal(false),
})

const consentRecordSchema = z.object({
  acceptedAt: z.iso.datetime(),
  consentType: consentTypeSchema,
  createdAt: z.iso.datetime(),
  documentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  documentVersion: z.string().min(1),
  id: z.union([z.number(), z.string()]),
  ipMasked: z.string(),
  revokedAt: z.iso.datetime().nullable(),
  source: z.enum([
    'phone_registration',
    'wechat_oauth_registration',
    'wechat_qrcode_registration',
    'legacy_profile_completion',
    'account_privacy_center',
  ]),
  userAgentSummary: z.string(),
})

const realnameTemplateExportSchema = z.object({
  addressChinese: z.string(),
  addressEnglish: z.string(),
  cityChinese: z.string(),
  cityEnglish: z.string(),
  contactFirstNameChinese: z.string(),
  contactFirstNameEnglish: z.string(),
  contactLastNameChinese: z.string(),
  contactLastNameEnglish: z.string(),
  countryCode: z.string(),
  createdAt: z.iso.datetime(),
  displayName: z.string(),
  districtChinese: z.string(),
  email: z.email(),
  fullNameChinese: z.string(),
  id: z.union([z.number(), z.string()]),
  identityDocumentNumber: z.string(),
  identityDocumentType: z.string(),
  organizationNameChinese: z.string().nullable(),
  organizationNameEnglish: z.string().nullable(),
  phone: z.string(),
  phoneAreaCode: z.string().nullable(),
  phoneCountryCode: z.string(),
  phoneExtension: z.string().nullable(),
  postalCode: z.string(),
  provinceChinese: z.string(),
  provinceEnglish: z.string(),
  status: z.string(),
  type: z.enum(['individual', 'organization']),
})

export const personalInformationResponseSchema = z.object({
  consents: z.array(consentRecordSchema),
  domainAssets: z.array(
    z.object({
      createdAt: z.iso.datetime(),
      domainAscii: z.string(),
      expiresAt: z.iso.datetime(),
      id: z.union([z.number(), z.string()]),
      nameservers: z.array(z.string()),
      registeredAt: z.iso.datetime(),
      status: z.enum(['active', 'expired', 'pending', 'unknown']),
    }),
  ),
  generatedAt: z.iso.datetime(),
  identities: z.array(
    z.object({
      boundAt: z.iso.datetime(),
      id: z.union([z.number(), z.string()]),
      lastUsedAt: z.iso.datetime().nullable(),
      provider: z.enum(['phone', 'wechat']),
      status: z.enum(['active', 'unbound']),
      unboundAt: z.iso.datetime().nullable(),
      verifiedAt: z.iso.datetime(),
    }),
  ),
  orders: z.array(
    z.object({
      amountMinor: z.number().int(),
      createdAt: z.iso.datetime(),
      currency: z.literal('CNY'),
      domainAscii: z.string(),
      id: z.union([z.number(), z.string()]),
      operation: z.enum(['registration', 'renewal']),
      orderNumber: z.string(),
      status: z.string(),
    }),
  ),
  profile: z.object({
    accountType: z.enum(['registered', 'legacy_unknown']),
    createdAt: z.iso.datetime(),
    defaultCustomerProfileType: z.enum(['individual', 'organization']).nullable(),
    id: z.union([z.number(), z.string()]),
    legacyProfileCompletedAt: z.iso.datetime().nullable(),
    phone: z.string(),
    phoneMasked: z.string(),
    registrationSource: z.enum(['phone', 'wechat_oauth', 'wechat_qrcode', 'legacy_unknown']),
  }),
  realnameDocuments: z.array(
    z.object({
      contentType: z.string(),
      createdAt: z.iso.datetime(),
      deletedAt: z.iso.datetime().nullable(),
      fileKind: z.enum(['jpeg', 'png', 'pdf']),
      id: z.union([z.number(), z.string()]),
      sizeBytes: z.number().int().positive(),
      storageState: z.enum(['uploading', 'active', 'upload_failed', 'deleting', 'deleted']),
      submittedAt: z.iso.datetime().nullable(),
    }),
  ),
  realnameTemplates: z.array(realnameTemplateExportSchema),
  retention: z.object({
    accountAndTransactionSchedule: z.literal('pending_external_legal_review'),
    consentHistory: z.literal('append_only_evidence'),
    exportPersistence: z.literal('not_persisted'),
    realnameDeletionDeadlineDays: z.literal(30),
  }),
  rights: z.object({
    accountDeletionPath: z.literal('/api/v1/auth/deletion-request'),
    defaultProfileCorrectionPath: z.literal('/api/v1/account/default-profile-type'),
    identityCorrectionPath: z.literal('/api/v1/account/identities/bind'),
    realnameCorrectionPath: z.literal('/api/v1/realname/templates/:templateId'),
  }),
})

export const adminPersonalInformationQuerySchema = z.object({
  purpose: z.string().trim().min(3).max(256),
})

export type CustomerConsentDecisionInput = z.infer<typeof customerConsentDecisionSchema>
export type LegacyProfileCompletionInput = z.infer<typeof legacyProfileCompletionSchema>
