import { z } from 'zod'
import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionBeforeValidateHook,
  PayloadRequest,
} from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import type { RealnameStatus } from '@/lib/domain'
import { getTraceId } from '@/lib/request-id'
import type { WestDigitalRealnameProfile, WestDigitalRealnameProvider } from '@/providers/types'
import { recordAuditEvent, type AuditActor } from '@/services/audit/record-audit-event'

export const REALNAME_TRANSITION_CONTEXT = 'realnameStatusTransition'

const TRANSITIONS: Record<RealnameStatus, readonly RealnameStatus[]> = {
  approved: ['disabled'],
  disabled: [],
  draft: ['pending_review', 'disabled'],
  manual_review: ['disabled'],
  pending_review: ['approved', 'rejected', 'manual_review', 'disabled'],
  rejected: ['disabled'],
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
      .toUpperCase()
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
      context.addIssue({ code: 'custom', message: '组织模板必须填写中英文组织名称' })
    }
    if (profile.phoneType === 'landline' && !profile.phoneAreaCode) {
      context.addIssue({ code: 'custom', message: '座机必须填写区号' })
    }
  })

export const createRealnameTemplateSchema = profileSchema.extend({
  displayName: z.string().trim().min(1).max(64),
})

type TemplateRecord = Record<string, unknown> & { id: number | string }
type TransitionContext = {
  actor?: AuditActor
  expectedFrom: RealnameStatus
  expectedTo: RealnameStatus
  providerRequestId?: string
  reasonCode: string
}

function relationshipId(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'number' || typeof id === 'string' ? String(id) : undefined
}

function requireCustomer(req: PayloadRequest): { id: number | string } {
  if (!isCustomerUser(req.user) || (req.user as { status?: string }).status !== 'active') {
    throw new AppError('REALNAME_AUTH_REQUIRED', '请重新验证身份后再试', 401)
  }
  return req.user
}

function profileFromRecord(template: TemplateRecord): WestDigitalRealnameProfile {
  return profileSchema.parse({
    addressChinese: template.addressChinese,
    addressEnglish: template.addressEnglish,
    applicableScopes: template.applicableScopes,
    cityChinese: template.cityChinese,
    cityEnglish: template.cityEnglish,
    contactFirstNameChinese: template.contactFirstNameChinese,
    contactFirstNameEnglish: template.contactFirstNameEnglish,
    contactLastNameChinese: template.contactLastNameChinese,
    contactLastNameEnglish: template.contactLastNameEnglish,
    countryCode: template.countryCode,
    districtChinese: template.districtChinese,
    email: template.email,
    fullNameChinese: template.fullNameChinese,
    identityDocumentNumber: template.identityDocumentNumber,
    identityDocumentType: template.identityDocumentType,
    organizationNameChinese: template.organizationNameChinese ?? undefined,
    organizationNameEnglish: template.organizationNameEnglish ?? undefined,
    phone: template.phone,
    phoneAreaCode: template.phoneAreaCode ?? undefined,
    phoneCountryCode: template.phoneCountryCode,
    phoneExtension: template.phoneExtension ?? undefined,
    phoneType: template.phoneType,
    postalCode: template.postalCode,
    provinceChinese: template.provinceChinese,
    provinceEnglish: template.provinceEnglish,
    type: template.type,
  })
}

function transitionContext(value: unknown): TransitionContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const context = value as Partial<TransitionContext>
  if (
    typeof context.expectedFrom !== 'string' ||
    typeof context.expectedTo !== 'string' ||
    typeof context.reasonCode !== 'string'
  ) {
    return undefined
  }
  return context as TransitionContext
}

export function assertRealnameStatusTransition(from: RealnameStatus, to: RealnameStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new AppError(
      'REALNAME_STATUS_TRANSITION_INVALID',
      `实名模板状态不能从 ${from} 变更为 ${to}`,
      409,
    )
  }
}

async function ownedTemplate(
  req: PayloadRequest,
  templateId: number | string,
): Promise<TemplateRecord> {
  const customer = requireCustomer(req)
  try {
    const template = (await req.payload.findByID({
      collection: 'realnameTemplates',
      depth: 0,
      id: templateId,
      overrideAccess: false,
      req,
      user: req.user,
    })) as unknown as TemplateRecord
    if (relationshipId(template.customer) !== String(customer.id)) throw new Error('not owned')
    return template
  } catch {
    throw new AppError('REALNAME_TEMPLATE_NOT_AVAILABLE', '该实名模板当前不可用', 404)
  }
}

async function updateWithTransition(
  req: PayloadRequest,
  template: TemplateRecord,
  to: RealnameStatus,
  input: {
    actor?: AuditActor
    data?: Record<string, unknown>
    providerRequestId?: string
    reasonCode: string
  },
): Promise<TemplateRecord> {
  const from = template.status as RealnameStatus
  assertRealnameStatusTransition(from, to)
  return (await req.payload.update({
    collection: 'realnameTemplates',
    context: {
      [REALNAME_TRANSITION_CONTEXT]: {
        actor: input.actor,
        expectedFrom: from,
        expectedTo: to,
        providerRequestId: input.providerRequestId,
        reasonCode: input.reasonCode,
      } satisfies TransitionContext,
    },
    data: { ...input.data, status: to },
    id: template.id,
    overrideAccess: true,
    req,
  })) as unknown as TemplateRecord
}

export const pinRealnameTemplateOwner: CollectionBeforeValidateHook = ({
  data,
  operation,
  req,
}) => {
  if (!data || operation !== 'create') return data
  if (isCustomerUser(req.user)) data.customer = req.user.id
  return data
}

export const guardRealnameTemplateChange: CollectionBeforeChangeHook = ({
  context,
  data,
  operation,
  originalDoc,
}) => {
  const combined = { ...(originalDoc ?? {}), ...data }
  if (operation === 'create') {
    createRealnameTemplateSchema.parse(combined)
    data.status = 'draft'
    data.providerReviewState = 'unsubmitted'
    return data
  }

  const from = originalDoc?.status as RealnameStatus
  const to = (data.status ?? originalDoc?.status) as RealnameStatus
  if (from !== to) {
    const authorized = transitionContext(context[REALNAME_TRANSITION_CONTEXT])
    if (!authorized || authorized.expectedFrom !== from || authorized.expectedTo !== to) {
      throw new AppError(
        'REALNAME_STATUS_SERVICE_REQUIRED',
        '实名模板状态只能通过实名服务变更',
        403,
      )
    }
    assertRealnameStatusTransition(from, to)
  }
  if (to === 'approved') {
    if (
      combined.providerReviewState !== 'approved' ||
      typeof combined.providerTemplateId !== 'string' ||
      !combined.providerTemplateId ||
      typeof combined.providerConfirmedAt !== 'string'
    ) {
      throw new AppError(
        'REALNAME_PROVIDER_CONFIRMATION_REQUIRED',
        '实名模板尚未获得服务商确认',
        409,
      )
    }
  }
  return data
}

export const auditRealnameTemplateStatusChange: CollectionAfterChangeHook = async ({
  context,
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation === 'create' || !previousDoc || doc.status === previousDoc.status) return doc
  const authorized = transitionContext(context[REALNAME_TRANSITION_CONTEXT])
  if (!authorized) throw new Error('Missing real-name transition audit context')
  await recordAuditEvent(req, {
    action: 'realname.template.status_changed',
    actor: authorized.actor,
    metadata: {
      fromStatus: previousDoc.status,
      providerRequestId: authorized.providerRequestId,
      reasonCode: authorized.reasonCode,
      toStatus: doc.status,
    },
    targetId: doc.id,
  })
  return doc
}

export async function createRealnameTemplate(
  req: PayloadRequest,
  input: z.input<typeof createRealnameTemplateSchema>,
): Promise<TemplateRecord> {
  const customer = requireCustomer(req)
  const data = createRealnameTemplateSchema.parse(input)
  return (await req.payload.create({
    collection: 'realnameTemplates',
    data: {
      ...data,
      customer: customer.id,
      providerReviewState: 'unsubmitted',
      status: 'draft',
    } as never,
    overrideAccess: true,
    req,
  })) as unknown as TemplateRecord
}

export async function submitRealnameTemplate(
  req: PayloadRequest,
  templateId: number | string,
  provider: WestDigitalRealnameProvider,
): Promise<TemplateRecord> {
  const draft = await ownedTemplate(req, templateId)
  const pending = await updateWithTransition(req, draft, 'pending_review', {
    data: { providerReviewState: 'pending', safeFailureReason: null },
    reasonCode: 'customer_submitted',
  })
  const result = await provider.createTemplate({
    profile: profileFromRecord(pending),
    traceId: getTraceId(req.headers),
  })
  if (!result.ok) {
    return updateWithTransition(req, pending, 'manual_review', {
      actor: { id: 'westdigital', type: 'provider' },
      data: {
        providerLastCheckedAt: result.observedAt,
        providerRequestId: result.requestId,
        providerReviewState: 'unknown',
        safeFailureReason: 'provider_unavailable',
      },
      providerRequestId: result.requestId,
      reasonCode: 'provider_create_unavailable',
    })
  }
  return (await req.payload.update({
    collection: 'realnameTemplates',
    data: {
      providerLastCheckedAt: result.observedAt,
      providerRequestId: result.requestId,
      providerReviewState: 'pending',
      providerTemplateId: result.data.providerTemplateId,
    },
    id: pending.id,
    overrideAccess: true,
    req,
  })) as unknown as TemplateRecord
}

export async function syncRealnameTemplateStatus(
  req: PayloadRequest,
  templateId: number | string,
  provider: WestDigitalRealnameProvider,
): Promise<TemplateRecord> {
  if (req.user) {
    throw new AppError('REALNAME_STATUS_SYNC_FORBIDDEN', '实名审核状态只能由后台任务同步', 403)
  }
  const template = (await req.payload.findByID({
    collection: 'realnameTemplates',
    depth: 0,
    id: templateId,
    overrideAccess: true,
    req,
  })) as unknown as TemplateRecord
  if (template.status !== 'pending_review') {
    throw new AppError('REALNAME_STATUS_NOT_PENDING', '实名模板当前不在审核中', 409)
  }
  if (typeof template.providerTemplateId !== 'string' || !template.providerTemplateId) {
    return updateWithTransition(req, template, 'manual_review', {
      actor: { type: 'system' },
      data: { providerReviewState: 'unknown', safeFailureReason: 'status_unknown' },
      reasonCode: 'provider_template_id_missing',
    })
  }

  const result = await provider.queryTemplate({
    providerTemplateId: template.providerTemplateId,
    traceId: getTraceId(req.headers),
  })
  if (!result.ok || result.data.reviewState === 'unknown') {
    return updateWithTransition(req, template, 'manual_review', {
      actor: { id: 'westdigital', type: 'provider' },
      data: {
        providerLastCheckedAt: result.observedAt,
        providerRequestId: result.requestId,
        providerReviewState: 'unknown',
        safeFailureReason: !result.ok ? 'provider_unavailable' : 'status_unknown',
      },
      providerRequestId: result.requestId,
      reasonCode: !result.ok ? 'provider_status_unavailable' : 'provider_status_unknown',
    })
  }
  if (result.data.reviewState === 'pending') {
    return (await req.payload.update({
      collection: 'realnameTemplates',
      data: {
        providerLastCheckedAt: result.observedAt,
        providerRequestId: result.requestId,
        providerReviewState: 'pending',
      },
      id: template.id,
      overrideAccess: true,
      req,
    })) as unknown as TemplateRecord
  }

  const approved = result.data.reviewState === 'approved'
  return updateWithTransition(req, template, approved ? 'approved' : 'rejected', {
    actor: { id: 'westdigital', type: 'provider' },
    data: {
      providerConfirmedAt: approved ? result.observedAt : null,
      providerLastCheckedAt: result.observedAt,
      providerRequestId: result.requestId,
      providerReviewState: result.data.reviewState,
      safeFailureReason: approved ? null : (result.data.safeFailureReason ?? 'other'),
    },
    providerRequestId: result.requestId,
    reasonCode: approved ? 'provider_approved' : 'provider_rejected',
  })
}

export async function disableRealnameTemplate(
  req: PayloadRequest,
  templateId: number | string,
): Promise<TemplateRecord> {
  const template = await ownedTemplate(req, templateId)
  if (template.status === 'disabled') return template
  return updateWithTransition(req, template, 'disabled', {
    data: { disabledAt: new Date().toISOString() },
    reasonCode: 'customer_disabled',
  })
}

export async function assertRealnameTemplateUsableForRegistration(
  req: PayloadRequest,
  input: { customerId: number | string; templateId: number | string },
): Promise<{
  id: number | string
  providerTemplateId: string
  type: 'individual' | 'organization'
}> {
  const customer = requireCustomer(req)
  if (String(customer.id) !== String(input.customerId)) {
    throw new AppError('REALNAME_TEMPLATE_NOT_USABLE', '该实名模板当前不可用于注册', 409)
  }
  let template: TemplateRecord
  try {
    template = (await req.payload.findByID({
      collection: 'realnameTemplates',
      depth: 0,
      id: input.templateId,
      overrideAccess: false,
      req,
      user: req.user,
    })) as unknown as TemplateRecord
  } catch {
    throw new AppError('REALNAME_TEMPLATE_NOT_USABLE', '该实名模板当前不可用于注册', 409)
  }
  if (
    relationshipId(template.customer) !== String(customer.id) ||
    template.status !== 'approved' ||
    template.providerReviewState !== 'approved' ||
    typeof template.providerTemplateId !== 'string' ||
    !template.providerTemplateId ||
    typeof template.providerConfirmedAt !== 'string'
  ) {
    throw new AppError('REALNAME_TEMPLATE_NOT_USABLE', '该实名模板当前不可用于注册', 409)
  }
  return {
    id: template.id,
    providerTemplateId: template.providerTemplateId,
    type: template.type as 'individual' | 'organization',
  }
}
