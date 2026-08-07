import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, Field, Payload } from 'payload'

import { hasRole, operationalFieldRead, sensitiveFieldRead, systemAdminField } from '@/access/roles'
import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { clientIp } from '@/services/auth/client-facts'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import {
  assertManagedFormDefinition,
  normalizePublicFormSubmission,
  type ManagedFormDocument,
} from '@/services/forms/form-contracts'
import {
  publicFormSubmissionRequestSchema,
  type PublicFormPurpose,
  type PublicFormSubmissionRequest,
  type PublicFormSubmissionResult,
} from '@/schemas/forms'

export const PUBLIC_FORM_SUBMISSION_CONTEXT = 'publicFormSubmission'

type SubmissionContext = {
  clientKeyHash: string
  purpose: PublicFormPurpose
  traceId: string
}

type FormSubmissionDocument = {
  clientKeyHash?: unknown
  contactMasked?: unknown
  form?: unknown
  id?: number | string
  pagePath?: unknown
  purpose?: unknown
  requestId?: unknown
  status?: unknown
  statusUpdatedAt?: unknown
  statusUpdatedBy?: unknown
  submissionData?: Array<{ field?: unknown; value?: unknown }> | null
  summary?: unknown
  tool?: unknown
  traceId?: unknown
}

const FORM_SUBMISSION_STATUSES = ['new', 'reviewed', 'closed'] as const
type FormSubmissionStatus = (typeof FORM_SUBMISSION_STATUSES)[number]

const allowedStatusTransitions: Readonly<
  Record<FormSubmissionStatus, readonly FormSubmissionStatus[]>
> = {
  closed: [] as FormSubmissionStatus[],
  new: ['reviewed', 'closed'],
  reviewed: ['closed'],
} satisfies Record<FormSubmissionStatus, FormSubmissionStatus[]>

function isSubmissionStatus(value: unknown): value is FormSubmissionStatus {
  return FORM_SUBMISSION_STATUSES.includes(value as FormSubmissionStatus)
}

function relationId(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return undefined
}

function submissionContext(value: unknown): SubmissionContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<SubmissionContext>
  if (
    typeof candidate.clientKeyHash !== 'string' ||
    typeof candidate.traceId !== 'string' ||
    !candidate.purpose
  ) {
    return undefined
  }
  return candidate as SubmissionContext
}

function inputFromSubmission(
  purpose: PublicFormPurpose,
  data: FormSubmissionDocument,
): PublicFormSubmissionRequest {
  const values: Record<string, string> = {}
  for (const item of data.submissionData ?? []) {
    if (typeof item.field !== 'string' || typeof item.value !== 'string' || item.field in values) {
      throw new AppError('FORM_FIELD_FORBIDDEN', '表单包含重复或未批准字段', 400)
    }
    values[item.field] = item.value
  }
  return publicFormSubmissionRequestSchema.parse({ purpose, values })
}

export const guardAndSanitizeFormSubmission: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const candidate = data as FormSubmissionDocument
  if (operation === 'create') {
    const context = submissionContext(req.context?.[PUBLIC_FORM_SUBMISSION_CONTEXT])
    if (!context) {
      throw new AppError(
        'FORM_SUBMISSION_ENTRY_FORBIDDEN',
        '表单提交只允许通过受控公开入口创建',
        403,
      )
    }
    const formId = relationId(candidate.form)
    if (formId === undefined) throw new AppError('FORM_UNAVAILABLE', '表单暂时不可用', 503)
    const form = (await req.payload.findByID({
      collection: 'forms',
      depth: 0,
      id: formId,
      overrideAccess: true,
      req,
    })) as ManagedFormDocument
    assertManagedFormDefinition(form)
    if (form.purpose !== context.purpose) {
      throw new AppError('FORM_PURPOSE_MISMATCH', '表单用途不匹配', 400)
    }

    const normalized = normalizePublicFormSubmission(
      inputFromSubmission(context.purpose, candidate),
    )
    candidate.clientKeyHash = context.clientKeyHash
    candidate.contactMasked = normalized.contactMasked
    candidate.pagePath = normalized.pagePath
    candidate.purpose = context.purpose
    candidate.requestId = normalized.requestId
    candidate.status = 'new'
    candidate.statusUpdatedAt = null
    candidate.statusUpdatedBy = null
    candidate.submissionData = normalized.submissionData
    candidate.summary = normalized.summary
    candidate.tool = normalized.tool
    candidate.traceId = context.traceId
    return data
  }

  const previous = originalDoc as FormSubmissionDocument | undefined
  if (!previous || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('FORM_STATUS_FORBIDDEN', '只有系统管理员可以管理表单状态', 403)
  }
  const from = previous.status
  const to = candidate.status
  if (!isSubmissionStatus(from) || !isSubmissionStatus(to)) {
    throw new AppError('FORM_STATUS_INVALID', '表单状态无效', 400)
  }
  if (from !== to && !allowedStatusTransitions[from].includes(to)) {
    throw new AppError('FORM_STATUS_TRANSITION_INVALID', '不允许执行该表单状态迁移', 409)
  }

  for (const field of [
    'clientKeyHash',
    'contactMasked',
    'form',
    'pagePath',
    'purpose',
    'requestId',
    'submissionData',
    'summary',
    'tool',
    'traceId',
  ] as const) {
    ;(candidate as Record<string, unknown>)[field] = (previous as Record<string, unknown>)[field]
  }
  candidate.statusUpdatedAt = from === to ? previous.statusUpdatedAt : new Date().toISOString()
  candidate.statusUpdatedBy = from === to ? previous.statusUpdatedBy : req.user?.id
  return data
}

export const auditFormSubmissionStatus: CollectionAfterChangeHook = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update' || doc.status === previousDoc?.status) return doc
  await recordAuditEvent(req, {
    action: 'form_submission.status_changed',
    metadata: { from: previousDoc?.status, purpose: doc.purpose, to: doc.status },
    targetId: doc.id,
  })
  return doc
}

function immutableReadField(field: Field): Field {
  if (!('name' in field)) return field
  if (field.name === 'submissionData' && field.type === 'array') {
    return {
      ...field,
      access: { create: () => false, read: sensitiveFieldRead, update: () => false },
    }
  }
  if (field.name === 'form' && field.type === 'relationship') {
    return {
      ...field,
      access: { create: () => false, read: operationalFieldRead, update: () => false },
    }
  }
  return field
}

export function appendFormSubmissionFields({ defaultFields }: { defaultFields: Field[] }): Field[] {
  const operationalReadOnly = {
    create: () => false,
    read: operationalFieldRead,
    update: () => false,
  }
  return [
    ...defaultFields.map(immutableReadField),
    {
      name: 'purpose',
      type: 'select',
      access: operationalReadOnly,
      index: true,
      options: ['contact', 'feedback', 'request'],
      required: true,
    },
    {
      name: 'summary',
      type: 'textarea',
      access: operationalReadOnly,
      maxLength: 500,
      required: true,
    },
    { name: 'contactMasked', type: 'text', access: operationalReadOnly, maxLength: 200 },
    { name: 'pagePath', type: 'text', access: operationalReadOnly, maxLength: 300 },
    {
      name: 'tool',
      type: 'select',
      access: operationalReadOnly,
      options: ['domain-search', 'whois', 'dns', 'ssl-check', 'idn', 'pricing'],
    },
    { name: 'requestId', type: 'text', access: operationalReadOnly, maxLength: 128 },
    {
      name: 'status',
      type: 'select',
      access: { create: () => false, read: operationalFieldRead, update: systemAdminField },
      defaultValue: 'new',
      index: true,
      options: [...FORM_SUBMISSION_STATUSES],
      required: true,
    },
    { name: 'traceId', type: 'text', access: operationalReadOnly, index: true, required: true },
    {
      name: 'clientKeyHash',
      type: 'text',
      access: { create: () => false, read: sensitiveFieldRead, update: () => false },
      admin: { hidden: true },
      index: true,
      required: true,
    },
    {
      name: 'statusUpdatedAt',
      type: 'date',
      access: { create: () => false, read: operationalFieldRead, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'statusUpdatedBy',
      type: 'relationship',
      access: { create: () => false, read: sensitiveFieldRead, update: () => false },
      admin: { readOnly: true },
      relationTo: 'admins',
    },
  ]
}

async function enforceSubmissionLimit(payload: Payload, clientKeyHash: string): Promise<void> {
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const [clientCount, globalCount] = await Promise.all([
    payload.count({
      collection: 'form-submissions',
      overrideAccess: true,
      where: {
        and: [{ clientKeyHash: { equals: clientKeyHash } }, { createdAt: { greater_than: since } }],
      },
    }),
    payload.count({
      collection: 'form-submissions',
      overrideAccess: true,
      where: { createdAt: { greater_than: since } },
    }),
  ])
  const env = getEnv()
  if (
    clientCount.totalDocs >= env.FORM_SUBMISSION_IP_LIMIT_PER_HOUR ||
    globalCount.totalDocs >= env.FORM_SUBMISSION_GLOBAL_LIMIT_PER_HOUR
  ) {
    throw new AppError('FORM_RATE_LIMITED', '表单提交过于频繁，请稍后再试', 429, {
      action: '请稍后再试；若问题持续，可保留本页请求 ID',
      retryAfterSeconds: 300,
      retryable: true,
      title: '表单提交过于频繁',
    })
  }
}

async function findManagedForm(payload: Payload, purpose: PublicFormPurpose) {
  const result = await payload.find({
    collection: 'forms',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    where: { purpose: { equals: purpose } },
  })
  if (result.totalDocs !== 1 || !result.docs[0]) {
    throw new AppError('FORM_UNAVAILABLE', '表单暂时不可用', 503, {
      action: '请稍后重试',
      retryable: true,
      title: '表单暂时不可用',
    })
  }
  const form = result.docs[0] as ManagedFormDocument & { id: number }
  assertManagedFormDefinition(form)
  return form
}

export async function submitPublicForm(
  payload: Payload,
  candidate: unknown,
  headers: Headers,
  traceId: string,
): Promise<PublicFormSubmissionResult> {
  const input = publicFormSubmissionRequestSchema.parse(candidate)
  const clientKeyHash = hmac(clientIp(headers), getEnv().SESSION_PEPPER)
  await enforceSubmissionLimit(payload, clientKeyHash)
  const form = await findManagedForm(payload, input.purpose)
  const normalized = normalizePublicFormSubmission(input)
  await payload.create({
    collection: 'form-submissions',
    context: {
      [PUBLIC_FORM_SUBMISSION_CONTEXT]: { clientKeyHash, purpose: input.purpose, traceId },
    },
    data: { form: form.id, submissionData: normalized.submissionData } as never,
    overrideAccess: true,
  })
  return {
    data: { accepted: true, purpose: input.purpose },
    meta: { observedAt: new Date().toISOString(), traceId },
    state: 'ready',
  }
}
