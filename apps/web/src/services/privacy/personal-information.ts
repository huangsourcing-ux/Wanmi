import type { PayloadRequest } from 'payload'

import { isAdminUser, isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type PersonalInformationMode = 'export' | 'view'

function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null
}

export async function readPersonalInformation(
  req: PayloadRequest,
  input: { customerId: number | string; mode: PersonalInformationMode; purpose?: string },
) {
  if (!isCustomerUser(req.user) && !isAdminUser(req.user)) {
    throw new AppError('PERSONAL_INFORMATION_ACCESS_FORBIDDEN', '无权访问个人信息', 403)
  }
  const user = req.user
  const customer = await req.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: input.customerId,
    overrideAccess: false,
    req,
    user,
  })
  const where = { customer: { equals: input.customerId } } as const
  const [identities, consents, realnameTemplates, realnameDocuments, orders, domainAssets] =
    await Promise.all([
      req.payload.find({
        collection: 'customerIdentities',
        depth: 0,
        overrideAccess: false,
        pagination: false,
        req,
        sort: 'createdAt',
        user,
        where,
      }),
      req.payload.find({
        collection: 'consentRecords',
        depth: 0,
        overrideAccess: false,
        pagination: false,
        req,
        sort: 'createdAt',
        user,
        where,
      }),
      req.payload.find({
        collection: 'realnameTemplates',
        depth: 0,
        overrideAccess: false,
        pagination: false,
        req,
        sort: 'createdAt',
        user,
        where,
      }),
      req.payload.find({
        collection: 'realnameDocuments',
        depth: 0,
        overrideAccess: false,
        pagination: false,
        req,
        sort: 'createdAt',
        user,
        where,
      }),
      req.payload.find({
        collection: 'orders',
        depth: 0,
        overrideAccess: false,
        pagination: false,
        req,
        sort: 'createdAt',
        user,
        where,
      }),
      req.payload.find({
        collection: 'domainAssets',
        depth: 0,
        overrideAccess: false,
        pagination: false,
        req,
        sort: 'createdAt',
        user,
        where,
      }),
    ])

  await recordAuditEvent(req, {
    action:
      input.mode === 'export'
        ? 'customer.personal_information.exported'
        : 'customer.personal_information.viewed',
    metadata: {
      mode: input.mode,
      purpose: input.purpose ?? 'customer_self_service',
      recordCounts: {
        consents: consents.totalDocs,
        domainAssets: domainAssets.totalDocs,
        identities: identities.totalDocs,
        orders: orders.totalDocs,
        realnameDocuments: realnameDocuments.totalDocs,
        realnameTemplates: realnameTemplates.totalDocs,
      },
    },
    targetId: input.customerId,
  })

  return {
    consents: consents.docs.map((record) => ({
      acceptedAt: record.acceptedAt,
      consentType: record.consentType,
      createdAt: record.createdAt,
      documentHash: record.documentHash,
      documentVersion: record.documentVersion,
      id: record.id,
      ipMasked: record.ipMasked,
      revokedAt: nullable(record.revokedAt),
      source: record.source,
      userAgentSummary: record.userAgentSummary,
    })),
    domainAssets: domainAssets.docs.map((asset) => ({
      createdAt: asset.createdAt,
      domainAscii: asset.domainAscii,
      expiresAt: asset.expiresAt,
      id: asset.id,
      nameservers: asset.nameservers ?? [],
      registeredAt: asset.registeredAt,
      status: asset.status,
    })),
    generatedAt: new Date().toISOString(),
    identities: identities.docs.map((identity) => ({
      boundAt: identity.boundAt,
      id: identity.id,
      lastUsedAt: nullable(identity.lastUsedAt),
      provider: identity.provider,
      status: identity.status,
      unboundAt: nullable(identity.unboundAt),
      verifiedAt: identity.verifiedAt,
    })),
    orders: orders.docs.map((order) => ({
      amountMinor: order.amountMinor,
      createdAt: order.createdAt,
      currency: order.currency,
      domainAscii: order.domainAscii,
      id: order.id,
      operation: order.operation ?? 'registration',
      orderNumber: order.orderNumber,
      status: order.status,
    })),
    profile: {
      accountType: customer.accountType ?? 'legacy_unknown',
      createdAt: customer.createdAt,
      defaultCustomerProfileType: nullable(customer.defaultCustomerProfileType),
      id: customer.id,
      legacyProfileCompletedAt: nullable(customer.legacyProfileCompletedAt),
      phone: customer.phone,
      phoneMasked: customer.phoneMasked,
      registrationSource: customer.registrationSource ?? 'legacy_unknown',
    },
    realnameDocuments: realnameDocuments.docs.map((document) => ({
      contentType: document.contentType,
      createdAt: document.createdAt,
      deletedAt: nullable(document.deletedAt),
      fileKind: document.fileKind,
      id: document.id,
      sizeBytes: document.sizeBytes,
      storageState: document.storageState,
      submittedAt: nullable(document.submittedAt),
    })),
    realnameTemplates: realnameTemplates.docs.map((template) => ({
      addressChinese: template.addressChinese,
      addressEnglish: template.addressEnglish,
      cityChinese: template.cityChinese,
      cityEnglish: template.cityEnglish,
      contactFirstNameChinese: template.contactFirstNameChinese,
      contactFirstNameEnglish: template.contactFirstNameEnglish,
      contactLastNameChinese: template.contactLastNameChinese,
      contactLastNameEnglish: template.contactLastNameEnglish,
      countryCode: template.countryCode,
      createdAt: template.createdAt,
      displayName: template.displayName,
      districtChinese: template.districtChinese,
      email: template.email,
      fullNameChinese: template.fullNameChinese,
      id: template.id,
      identityDocumentNumber: template.identityDocumentNumber,
      identityDocumentType: template.identityDocumentType,
      organizationNameChinese: nullable(template.organizationNameChinese),
      organizationNameEnglish: nullable(template.organizationNameEnglish),
      phone: template.phone,
      phoneAreaCode: nullable(template.phoneAreaCode),
      phoneCountryCode: template.phoneCountryCode,
      phoneExtension: nullable(template.phoneExtension),
      postalCode: template.postalCode,
      provinceChinese: template.provinceChinese,
      provinceEnglish: template.provinceEnglish,
      status: template.status,
      type: template.type,
    })),
    retention: {
      accountAndTransactionSchedule: 'pending_external_legal_review' as const,
      consentHistory: 'append_only_evidence' as const,
      exportPersistence: 'not_persisted' as const,
      realnameDeletionDeadlineDays: 30 as const,
    },
    rights: {
      accountDeletionPath: '/api/v1/auth/deletion-request' as const,
      defaultProfileCorrectionPath: '/api/v1/account/default-profile-type' as const,
      identityCorrectionPath: '/api/v1/account/identities/bind' as const,
      realnameCorrectionPath: '/api/v1/realname/templates/:templateId' as const,
    },
  }
}
