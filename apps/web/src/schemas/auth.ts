import { z } from 'zod'

import {
  ACCOUNT_CLOSURE_BLOCKERS,
  ADMIN_ROLES,
  CUSTOMER_ACCOUNT_STATUSES,
  CUSTOMER_CAPABILITY_RESTRICTIONS,
  STEP_UP_PURPOSES,
} from '@/lib/domain'

export const adminPasswordSchema = z
  .string()
  .min(14, '密码至少需要 14 个字符')
  .max(128, '密码最多允许 128 个字符')

export const adminRoleSchema = z.enum(ADMIN_ROLES)

export const adminLoginSchema = z
  .object({
    email: z.email().trim().toLowerCase(),
    password: z.string().min(1).max(128),
    recoveryCode: z.string().trim().min(8).max(128).optional(),
    totp: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .superRefine((value, context) => {
    if (Boolean(value.totp) === Boolean(value.recoveryCode)) {
      context.addIssue({
        code: 'custom',
        message: '必须且只能提供 TOTP 验证码或恢复码之一',
        path: ['totp'],
      })
    }
  })

const newAdminInvitationSchema = z.object({
  email: z.email().trim().toLowerCase(),
  purpose: z.literal('new_admin'),
  roles: z
    .array(adminRoleSchema)
    .min(1)
    .transform((roles) => [...new Set(roles)]),
})

const mfaResetInvitationSchema = z.object({
  purpose: z.literal('mfa_reset'),
  targetAdminId: z.coerce.number().int().positive(),
})

export const adminInvitationCreateSchema = z.discriminatedUnion('purpose', [
  newAdminInvitationSchema,
  mfaResetInvitationSchema,
])

export const adminInvitationAcceptSchema = z.object({
  password: adminPasswordSchema,
  totp: z.string().regex(/^\d{6}$/),
})

export const adminInvitationBearerSchema = z
  .string()
  .regex(/^Bearer [A-Za-z0-9_-]{43}$/)
  .transform((header) => header.slice('Bearer '.length))

export const adminSessionScopeSchema = z.object({
  scope: z.enum(['all']).default('all'),
})

export const adminSummarySchema = z.object({
  email: z.email(),
  id: z.union([z.number(), z.string()]),
  roles: z.array(adminRoleSchema),
  status: z.enum(['active', 'disabled']),
})

export const adminInvitationSummarySchema = z.object({
  consumedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  email: z.email(),
  expiresAt: z.iso.datetime(),
  id: z.union([z.number(), z.string()]),
  pending: z.boolean(),
  purpose: z.enum(['new_admin', 'mfa_reset']),
  revokedAt: z.iso.datetime().nullable(),
  roles: z.array(adminRoleSchema),
  targetAdminId: z.union([z.number(), z.string()]).nullable(),
})

export const adminInvitationIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const adminSessionAdminParamsSchema = z.object({
  adminId: z.coerce.number().int().positive(),
})

export const adminSessionIdParamsSchema = adminSessionAdminParamsSchema.extend({
  sessionId: z.uuid(),
})

export const safeAdminSessionSchema = z.object({
  createdAt: z.iso.datetime().nullable(),
  current: z.boolean(),
  expiresAt: z.iso.datetime(),
  id: z.uuid(),
})

export const adminLoginResponseSchema = z.object({ admin: adminSummarySchema })

export const adminInvitationListResponseSchema = z.object({
  invitations: z.array(adminInvitationSummarySchema),
})

export const adminInvitationCreateResponseSchema = z.object({
  invitation: adminInvitationSummarySchema,
  invitationUrl: z.url(),
})

export const adminInvitationResolveResponseSchema = z.object({
  invitation: adminInvitationSummarySchema,
  provisioningUri: z.string().regex(/^otpauth:\/\/totp\//),
})

export const adminInvitationAcceptResponseSchema = z.object({
  admin: adminSummarySchema,
  recoveryCodes: z.array(z.string().min(12)).length(8),
})

export const adminInvitationRevokeResponseSchema = z.object({
  invitation: adminInvitationSummarySchema,
})

export const adminSessionListResponseSchema = z.object({
  adminId: z.union([z.number(), z.string()]),
  sessions: z.array(safeAdminSessionSchema),
})

export const adminSessionRevokeResponseSchema = adminSessionListResponseSchema.extend({
  revoked: z.literal(true),
})

export const adminLogoutResponseSchema = z.object({
  loggedOut: z.literal(true),
  scope: z.enum(['current', 'all']),
})

export type AdminInvitationCreateInput = z.infer<typeof adminInvitationCreateSchema>
export type AdminLoginInput = z.infer<typeof adminLoginSchema>

export const smsRequestSchema = z.object({
  captchaVerifyParam: z.string().min(1).max(8_192),
  deviceId: z.string().min(16).max(128),
  phone: z.string().trim().min(11).max(16),
})

export const smsVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  deviceId: z.string().min(16).max(128),
})

export const stepUpPurposeSchema = z.enum(STEP_UP_PURPOSES)

export const stepUpRequestSchema = z
  .object({
    captchaVerifyParam: z.string().min(1).max(8_192),
    deviceId: z.string().min(16).max(128),
    purpose: stepUpPurposeSchema,
  })
  .strict()

export const stepUpVerifySchema = z
  .object({
    challengeId: z.uuid(),
    code: z.string().regex(/^\d{6}$/),
    deviceId: z.string().min(16).max(128),
    purpose: stepUpPurposeSchema,
  })
  .strict()

export const stepUpGrantResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  oneTime: z.boolean(),
  purpose: stepUpPurposeSchema,
  stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
})

export const logoutSchema = z.object({
  scope: z.enum(['current', 'all']).default('current'),
})

export const customerRegistrationSchema = z
  .object({
    acceptedDeviceIdentifierNotice: z.literal(true),
    acceptedInvitationAttribution: z.literal(true).optional(),
    acceptedPrivacyPolicy: z.literal(true),
    acceptedServiceTerms: z.literal(true),
    commercialSmsOptIn: z.boolean().default(false),
    confirmsAdultOrAuthorizedRepresentative: z.literal(true),
    defaultCustomerProfileType: z.enum(['individual', 'organization']),
    deviceId: z.string().min(16).max(128),
    invitationCode: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{12}$/u)
      .optional(),
    phoneRegistrationToken: z.string().min(32).max(128).optional(),
    registrationToken: z.string().min(32).max(128),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.invitationCode && input.acceptedInvitationAttribution !== true) {
      context.addIssue({
        code: 'custom',
        message: '使用邀请码前必须确认邀请归因说明',
        path: ['acceptedInvitationAttribution'],
      })
    }
    if (!input.invitationCode && input.acceptedInvitationAttribution !== undefined) {
      context.addIssue({
        code: 'custom',
        message: '未使用邀请码时不得提交邀请归因同意',
        path: ['acceptedInvitationAttribution'],
      })
    }
  })

export const defaultCustomerProfileTypeSchema = z
  .object({ defaultCustomerProfileType: z.enum(['individual', 'organization']) })
  .strict()

export const identityBindSchema = z
  .object({ registrationToken: z.string().min(32).max(128) })
  .strict()

export const identityIdParamsSchema = z.object({ identityId: z.coerce.number().int().positive() })

export const wechatOAuthStartSchema = z
  .object({ purpose: z.enum(['login', 'bind']).default('login') })
  .strict()

export const wechatOAuthCallbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(32).max(128),
})

export const wechatQrCreateSchema = z
  .object({
    captchaVerifyParam: z.string().min(1).max(8_192),
    deviceId: z.string().min(16).max(128),
    purpose: z.enum(['login', 'bind']).default('login'),
  })
  .strict()

export const wechatQrPollSchema = z.object({ scene: z.string().min(32).max(128) }).strict()

export const wechatQrConfirmSchema = z
  .object({ confirmationToken: z.string().min(32).max(128) })
  .strict()

export const wechatQrConsumeSchema = z
  .object({ deviceId: z.string().min(16).max(128), scene: z.string().min(32).max(128) })
  .strict()

export const customerDeletionRequestSchema = z
  .object({
    confirmation: z.literal('DELETE_MY_ACCOUNT'),
    deviceId: z.string().min(16).max(128),
    reason: z.string().trim().min(3).max(1_000),
    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict()

export const accountClosureBlockerSchema = z.enum(ACCOUNT_CLOSURE_BLOCKERS)

export const customerDeletionResponseSchema = z.object({
  blockers: z.array(accountClosureBlockerSchema),
  cooldownEndsAt: z.iso.datetime(),
  deletionRequestedAt: z.iso.datetime(),
  requestId: z.uuid(),
  status: z.literal('pending'),
})

export const accountClosureRequestIdSchema = z
  .uuid()
  .refine((value) => value !== '00000000-0000-0000-0000-000000000000')

export const accountClosureRevokeSchema = z
  .object({
    confirmation: z.literal('KEEP_MY_ACCOUNT'),
    reason: z.string().trim().min(3).max(1_000),
  })
  .strict()

export const accountClosureRevokeResponseSchema = z.object({
  requestId: z.uuid(),
  revokedAt: z.iso.datetime(),
  status: z.literal('revoked'),
})

export const accountClosureExecuteSchema = z
  .object({
    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),
    note: z.string().trim().min(3).max(2_000),
  })
  .strict()

export const accountClosureExecuteResponseSchema = z.discriminatedUnion('status', [
  z.object({
    blockers: z.array(accountClosureBlockerSchema).min(1),
    requestId: z.uuid(),
    status: z.literal('blocked'),
  }),
  z.object({
    executedAt: z.iso.datetime(),
    identityRebindAllowedAt: z.iso.datetime(),
    requestId: z.uuid(),
    status: z.literal('closed'),
  }),
])

export const customerAccountStatusSchema = z.enum(CUSTOMER_ACCOUNT_STATUSES)
export const customerCapabilityRestrictionSchema = z.enum(CUSTOMER_CAPABILITY_RESTRICTIONS)
const customerCapabilityRestrictionsSchema = z
  .array(customerCapabilityRestrictionSchema)
  .max(CUSTOMER_CAPABILITY_RESTRICTIONS.length)
  .refine((value) => new Set(value).size === value.length, '账户能力限制不得重复')

export const customerAccountEvidenceSchema = z
  .object({
    observedAt: z.iso.datetime(),
    reference: z.string().trim().min(3).max(256),
    source: z.enum([
      'customer_request',
      'manual_review',
      'registration',
      'security_event',
      'written_confirmation',
    ]),
  })
  .strict()

export const adminCustomerAccountActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('change_state'),
      evidence: customerAccountEvidenceSchema,
      expectedRestrictions: customerCapabilityRestrictionsSchema,
      expectedStatus: customerAccountStatusSchema,
      reason: z.string().trim().min(3).max(1_000),
      restrictions: customerCapabilityRestrictionsSchema,
      status: customerAccountStatusSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('revoke_sessions'),
      evidence: customerAccountEvidenceSchema,
      reason: z.string().trim().min(3).max(1_000),
    })
    .strict(),
])

export const customerAccountStateResponseSchema = z.object({
  capabilityRestrictions: customerCapabilityRestrictionsSchema,
  changedAt: z.iso.datetime(),
  customerId: z.union([z.number(), z.string()]),
  deletionRequestedAt: z.iso.datetime().optional(),
  status: customerAccountStatusSchema,
})

export const customerSessionSecurityResponseSchema = z.object({
  revokedCount: z.number().int().nonnegative(),
})

export const accountRecoveryRequestSchema = z
  .object({
    fullNameChinese: z.string().trim().min(2).max(50),
    historicalOrderNumber: z.string().trim().min(8).max(64),
    identityDocumentNumber: z.string().trim().min(3).max(64),
    paymentTransactionId: z.string().trim().min(8).max(128),
    phone: z.string().trim().min(11).max(16),
    phoneUnavailable: z.literal(true),
    wechatUnavailable: z.literal(true),
  })
  .strict()

export const accountRecoveryRequestResponseSchema = z.object({
  recoveryRequestId: z.uuid(),
  status: z.literal('manual_review'),
  submittedAt: z.iso.datetime(),
})

export const accountRecoveryDecisionSchema = z
  .object({
    conclusion: z.enum(['approved', 'rejected']),
    note: z.string().trim().min(3).max(2_000),
  })
  .strict()

export const accountRecoveryDecisionResponseSchema = z.object({
  conclusion: z.enum(['approved', 'rejected']),
  cooldownEndsAt: z.iso.datetime().optional(),
  cooldownStartedAt: z.iso.datetime().optional(),
  customerId: z.number().int().positive(),
  decidedAt: z.iso.datetime(),
  reviewId: z.number().int().positive(),
  revokedSessionCount: z.number().int().nonnegative(),
})

export type SmsRequestInput = z.infer<typeof smsRequestSchema>
export type SmsVerifyInput = z.infer<typeof smsVerifySchema>
export type StepUpRequestInput = z.infer<typeof stepUpRequestSchema>
export type StepUpVerifyInput = z.infer<typeof stepUpVerifySchema>
export type AccountRecoveryDecisionInput = z.infer<typeof accountRecoveryDecisionSchema>
export type AccountRecoveryRequestInput = z.infer<typeof accountRecoveryRequestSchema>
export type CustomerRegistrationInput = z.infer<typeof customerRegistrationSchema>
export type WechatQrCreateInput = z.infer<typeof wechatQrCreateSchema>
