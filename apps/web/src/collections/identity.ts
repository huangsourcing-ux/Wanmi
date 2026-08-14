import type { CollectionConfig } from 'payload'

import { ADMIN_ROLES } from '@/lib/domain'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import {
  adminSelfOrSystem,
  deny,
  hasRole,
  ownOrSystem,
  sensitiveFieldRead,
  systemAdminHidden,
  systemAdminOnly,
} from '@/access/roles'
import {
  auditAdminDelete,
  blockAdminDefaultAuthOperations,
  guardAdminAccountChange,
  guardAdminDelete,
  revokeSessionsAfterAdminChange,
  validateAdminPassword,
} from '@/services/auth/admin-account'
import { customerSessionStrategy } from '@/services/auth/customer-strategy'
import { verifyAdminTotpBeforeLogin } from '@/services/auth/totp'

export const Admins: CollectionConfig = {
  slug: 'admins',
  access: {
    admin: ({ req }) =>
      req.user?.collection === 'admins' && (req.user as { status?: string }).status === 'active',
    create: deny,
    delete: systemAdminOnly,
    read: adminSelfOrSystem,
    update: adminSelfOrSystem,
  },
  admin: { group: ADMIN_GROUPS.identity, hidden: systemAdminHidden, useAsTitle: 'email' },
  auth: {
    cookies: { sameSite: 'Lax', secure: true },
    lockTime: 10 * 60 * 1000,
    maxLoginAttempts: 5,
    removeTokenFromResponses: true,
    tokenExpiration: 43_200,
    useSessions: true,
  },
  fields: [
    {
      name: 'roles',
      type: 'select',
      hasMany: true,
      options: [...ADMIN_ROLES],
      required: true,
      saveToJWT: true,
      access: { update: ({ req }) => hasRole(req.user, ['system_admin']) },
    },
    {
      name: 'status',
      type: 'select',
      access: { update: ({ req }) => hasRole(req.user, ['system_admin']) },
      defaultValue: 'active',
      options: ['active', 'disabled'],
      required: true,
      saveToJWT: true,
    },
  ],
  hooks: {
    afterChange: [revokeSessionsAfterAdminChange],
    afterDelete: [auditAdminDelete],
    beforeChange: [guardAdminAccountChange],
    beforeDelete: [guardAdminDelete],
    beforeLogin: [verifyAdminTotpBeforeLogin],
    beforeOperation: [blockAdminDefaultAuthOperations],
    beforeValidate: [validateAdminPassword],
  },
}

export const AdminMfaCredentials: CollectionConfig = {
  slug: 'adminMfaCredentials',
  access: { create: deny, delete: deny, read: deny, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    {
      name: 'admin',
      type: 'relationship',
      relationTo: 'admins',
      index: true,
      required: true,
      unique: true,
    },
    { name: 'secretEncrypted', type: 'text', required: true },
    { name: 'recoveryCodeHashes', type: 'text', hasMany: true },
    { name: 'lastUsedStep', type: 'number' },
    { name: 'failedAttempts', type: 'number', defaultValue: 0, min: 0, required: true },
    { name: 'lockedUntil', type: 'date', index: true },
    { name: 'version', type: 'number', defaultValue: 0, min: 0, required: true },
    { name: 'configuredAt', type: 'date', required: true },
  ],
}

export const AdminInvitations: CollectionConfig = {
  slug: 'adminInvitations',
  access: { create: deny, delete: deny, read: deny, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    { name: 'purpose', type: 'select', options: ['new_admin', 'mfa_reset'], required: true },
    { name: 'email', type: 'email', index: true, required: true },
    { name: 'roles', type: 'select', hasMany: true, options: [...ADMIN_ROLES], required: true },
    {
      name: 'targetAdmin',
      type: 'relationship',
      relationTo: 'admins',
      index: true,
    },
    { name: 'tokenHash', type: 'text', index: true, required: true, unique: true },
    { name: 'totpSecretEncrypted', type: 'text', required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'consumedAt', type: 'date', index: true },
    { name: 'revokedAt', type: 'date', index: true },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'admins',
      required: true,
    },
  ],
}

export const Customers: CollectionConfig = {
  slug: 'customers',
  access: {
    admin: () => false,
    create: deny,
    delete: deny,
    read: ownOrSystem('id'),
    update: deny,
  },
  admin: { group: ADMIN_GROUPS.identity, hidden: systemAdminHidden },
  auth: {
    disableLocalStrategy: true,
    loginWithUsername: { allowEmailLogin: false, requireEmail: false },
    strategies: [customerSessionStrategy],
    useSessions: false,
  },
  fields: [
    {
      name: 'phone',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
      unique: true,
    },
    { name: 'phoneMasked', type: 'text', required: true },
    {
      name: 'accountType',
      type: 'select',
      defaultValue: 'legacy_unknown',
      index: true,
      options: ['registered', 'legacy_unknown'],
    },
    {
      name: 'registrationSource',
      type: 'select',
      defaultValue: 'legacy_unknown',
      index: true,
      options: ['phone', 'wechat_oauth', 'wechat_qrcode', 'legacy_unknown'],
    },
    {
      name: 'defaultCustomerProfileType',
      type: 'select',
      index: true,
      options: ['individual', 'organization'],
    },
    { name: 'inviteCode', type: 'text', index: true, unique: true },
    {
      name: 'invitedByCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
    { name: 'identityRiskCooldownStartedAt', type: 'date', index: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      options: ['active', 'disabled', 'deletion_requested'],
      required: true,
    },
    { name: 'deletionRequestedAt', type: 'date', index: true },
  ],
}

export const CustomerIdentities: CollectionConfig = {
  slug: 'customerIdentities',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: systemAdminHidden },
  indexes: [
    {
      fields: ['provider', 'providerInstanceId', 'identifierHash'],
      unique: true,
    },
  ],
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'provider',
      type: 'select',
      index: true,
      options: ['phone', 'wechat'],
      required: true,
    },
    { name: 'providerInstanceId', type: 'text', index: true, required: true },
    {
      name: 'identifierHash',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
    },
    {
      name: 'identifierEncrypted',
      type: 'text',
      access: { read: sensitiveFieldRead },
      required: true,
    },
    {
      name: 'unionid',
      type: 'text',
      access: { read: sensitiveFieldRead },
      admin: { description: '预留字段；D9-A-1 不读取、不写入、不用于账号合并。' },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      index: true,
      options: ['active', 'unbound'],
      required: true,
    },
    { name: 'verifiedAt', type: 'date', index: true, required: true },
    { name: 'boundAt', type: 'date', index: true, required: true },
    { name: 'unboundAt', type: 'date', index: true },
    { name: 'lastUsedAt', type: 'date', index: true },
  ],
}

export const ConsentRecords: CollectionConfig = {
  slug: 'consentRecords',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: systemAdminHidden },
  indexes: [{ fields: ['customer', 'consentType', 'acceptedAt'] }],
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'consentType',
      type: 'select',
      index: true,
      options: [
        'service_terms',
        'privacy_policy',
        'sensitive_personal_information',
        'wechat_profile',
        'commercial_sms',
        'automatic_renewal',
        'invitation_attribution',
        'device_identifier_notice',
      ],
      required: true,
    },
    { name: 'documentVersion', type: 'text', required: true },
    { name: 'documentHash', type: 'text', required: true },
    { name: 'acceptedAt', type: 'date', index: true, required: true },
    { name: 'revokedAt', type: 'date', index: true },
    {
      name: 'source',
      type: 'select',
      options: ['phone_registration', 'wechat_oauth_registration', 'wechat_qrcode_registration'],
      required: true,
    },
    { name: 'ipMasked', type: 'text', required: true },
    { name: 'userAgentSummary', type: 'text', maxLength: 160, required: true },
  ],
}

export const CustomerRegistrationIntents: CollectionConfig = {
  slug: 'customerRegistrationIntents',
  access: { create: deny, delete: deny, read: deny, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  indexes: [{ fields: ['provider', 'providerInstanceId', 'identifierHash'] }],
  fields: [
    { name: 'tokenHash', type: 'text', index: true, required: true, unique: true },
    { name: 'provider', type: 'select', options: ['phone', 'wechat'], required: true },
    { name: 'providerInstanceId', type: 'text', required: true },
    { name: 'identifierHash', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    {
      name: 'identifierEncrypted',
      type: 'text',
      access: { read: sensitiveFieldRead },
      required: true,
    },
    { name: 'phoneMasked', type: 'text' },
    {
      name: 'source',
      type: 'select',
      options: ['phone', 'wechat_oauth', 'wechat_qrcode'],
      required: true,
    },
    { name: 'deviceHash', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'ipHash', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'consumedAt', type: 'date', index: true },
    {
      name: 'claimedCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
  ],
}

export const WechatOAuthStates: CollectionConfig = {
  slug: 'wechatOAuthStates',
  access: { create: deny, delete: deny, read: deny, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    { name: 'stateHash', type: 'text', index: true, required: true, unique: true },
    { name: 'browserSessionHash', type: 'text', required: true },
    { name: 'providerInstanceId', type: 'text', required: true },
    { name: 'purpose', type: 'select', options: ['login', 'bind'], required: true },
    {
      name: 'bindingCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'consumedAt', type: 'date', index: true },
  ],
}

export const WechatAuthorizationCodes: CollectionConfig = {
  slug: 'wechatAuthorizationCodes',
  access: { create: deny, delete: deny, read: deny, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    { name: 'codeHash', type: 'text', index: true, required: true, unique: true },
    { name: 'processedAt', type: 'date', index: true, required: true },
  ],
}

export const WechatLoginScenes: CollectionConfig = {
  slug: 'wechatLoginScenes',
  access: { create: deny, delete: deny, read: deny, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    { name: 'sceneHash', type: 'text', index: true, required: true, unique: true },
    { name: 'browserSessionHash', type: 'text', required: true },
    { name: 'providerInstanceId', type: 'text', required: true },
    { name: 'purpose', type: 'select', options: ['login', 'bind'], required: true },
    {
      name: 'bindingCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'created',
      index: true,
      options: ['created', 'scanned', 'confirmed', 'consumed', 'rejected', 'expired'],
      required: true,
    },
    { name: 'deviceSummary', type: 'text', maxLength: 160, required: true },
    { name: 'identifierHash', type: 'text', access: { read: sensitiveFieldRead } },
    { name: 'identifierEncrypted', type: 'text', access: { read: sensitiveFieldRead } },
    { name: 'confirmationTokenHash', type: 'text', index: true, unique: true },
    { name: 'providerTicketHash', type: 'text', access: { read: sensitiveFieldRead } },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'scannedAt', type: 'date', index: true },
    { name: 'confirmedAt', type: 'date', index: true },
    { name: 'consumedAt', type: 'date', index: true },
    { name: 'rejectedAt', type: 'date', index: true },
    { name: 'lastPolledAt', type: 'date' },
    { name: 'pollCount', type: 'number', defaultValue: 0, min: 0, required: true },
  ],
}

export const SmsChallenges: CollectionConfig = {
  slug: 'smsChallenges',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    { name: 'challengeId', type: 'text', index: true, required: true, unique: true },
    { name: 'phone', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'phoneHash', type: 'text', index: true, required: true },
    { name: 'codeHash', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'ipHash', type: 'text', index: true, required: true },
    { name: 'deviceHash', type: 'text', index: true, required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'attempts', type: 'number', defaultValue: 0, min: 0, required: true },
    { name: 'consumedAt', type: 'date', index: true },
    {
      name: 'deliveryStatus',
      type: 'select',
      defaultValue: 'not_requested',
      index: true,
      options: ['not_requested', 'accepted', 'pending', 'delivered', 'failed', 'unknown'],
      required: true,
    },
    {
      name: 'deliveryFailureCategory',
      type: 'select',
      options: [
        'balance_insufficient',
        'template_unapproved',
        'invalid_number',
        'rate_limited',
        'unknown',
      ],
    },
    { name: 'deliveryProviderCode', type: 'text' },
    { name: 'providerMessageId', type: 'text', index: true },
    { name: 'providerRequestId', type: 'text', index: true },
    { name: 'receiptRequestId', type: 'text', index: true },
    { name: 'sentAt', type: 'date', index: true },
    { name: 'receiptCheckedAt', type: 'date', index: true },
  ],
}

export const SmsRateLimits: CollectionConfig = {
  slug: 'smsRateLimits',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    { name: 'bucketKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'dimension',
      type: 'select',
      index: true,
      options: ['phone', 'ip', 'device', 'global'],
      required: true,
    },
    {
      name: 'identityHash',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
    },
    { name: 'windowStartedAt', type: 'date', index: true, required: true },
    { name: 'count', type: 'number', min: 0, required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
  ],
}

export const CustomerSessions: CollectionConfig = {
  slug: 'customerSessions',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.identity, hidden: true },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'tokenHash',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
      unique: true,
    },
    { name: 'deviceHash', type: 'text', index: true, required: true },
    { name: 'ipHash', type: 'text', index: true, required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'revokedAt', type: 'date', index: true },
    { name: 'lastSeenAt', type: 'date', required: true },
  ],
}
