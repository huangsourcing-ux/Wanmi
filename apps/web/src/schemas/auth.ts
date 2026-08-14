import { z } from 'zod'

import { ADMIN_ROLES } from '@/lib/domain'

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

export const logoutSchema = z.object({
  scope: z.enum(['current', 'all']).default('current'),
})

export const customerRegistrationSchema = z
  .object({
    acceptedPrivacyPolicy: z.literal(true),
    acceptedServiceTerms: z.literal(true),
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

export const customerDeletionRequestSchema = z.object({
  confirmation: z.literal('DELETE_MY_ACCOUNT'),
})

export const customerDeletionResponseSchema = z.object({
  deletionRequestedAt: z.iso.datetime(),
  status: z.literal('deletion_requested'),
})

export type SmsRequestInput = z.infer<typeof smsRequestSchema>
export type SmsVerifyInput = z.infer<typeof smsVerifySchema>
export type CustomerRegistrationInput = z.infer<typeof customerRegistrationSchema>
export type WechatQrCreateInput = z.infer<typeof wechatQrCreateSchema>
