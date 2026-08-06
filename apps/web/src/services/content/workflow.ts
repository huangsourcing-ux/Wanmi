import type { PayloadRequest } from 'payload'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import type { ContentWorkflowInput } from '@/schemas/content'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { collectMediaIds, sanitizeRichText } from './rich-text'
import {
  CONTENT_WORKFLOW_CONTEXT,
  type ContentCollection,
  type ContentWorkflowAction,
  type ContentWorkflowStatus,
  isContentWorkflowStatus,
} from './types'

type ContentDocument = {
  _status?: 'draft' | 'published' | null
  content: unknown
  id: number | string
  publishedAt?: null | string
  scheduledPublishAt?: null | string
  source?: null | string
  workflowStatus?: null | string
}

type WorkflowOptions = {
  expectedPublishAt?: string
  scheduledExecution?: boolean
}

const requiredState: Record<ContentWorkflowAction, ContentWorkflowStatus> = {
  archive: 'unpublished',
  cancel_scheduled_publish: 'in_review',
  publish: 'in_review',
  publish_revision: 'published',
  schedule_publish: 'in_review',
  submit_review: 'draft',
  unpublish: 'published',
}

const resultState: Record<ContentWorkflowAction, ContentWorkflowStatus> = {
  archive: 'archived',
  cancel_scheduled_publish: 'in_review',
  publish: 'published',
  publish_revision: 'published',
  schedule_publish: 'in_review',
  submit_review: 'in_review',
  unpublish: 'unpublished',
}

export function canExecuteContentAction(
  status: ContentWorkflowStatus,
  action: ContentWorkflowAction,
): boolean {
  return requiredState[action] === status
}

export function contentStatusAfterAction(
  status: ContentWorkflowStatus,
  action: ContentWorkflowAction,
): ContentWorkflowStatus {
  if (!canExecuteContentAction(status, action)) {
    throw new AppError(
      'CONTENT_WORKFLOW_INVALID_TRANSITION',
      `不允许从 ${status} 执行 ${action}`,
      409,
    )
  }
  return resultState[action]
}

function statusOf(document: ContentDocument): ContentWorkflowStatus {
  if (isContentWorkflowStatus(document.workflowStatus)) return document.workflowStatus
  return 'draft'
}

function assertContentManager(req: PayloadRequest): void {
  if (!hasRole(req.user, ['content_editor', 'system_admin'])) {
    throw new AppError('CONTENT_ROLE_REQUIRED', '仅内容管理员可执行此操作', 403)
  }
}

async function validatePublishable(req: PayloadRequest, document: ContentDocument): Promise<void> {
  if (!document.source?.trim()) {
    throw new AppError('CONTENT_SOURCE_REQUIRED', '发布内容前必须填写来源', 409)
  }
  const sanitized = sanitizeRichText(document.content)
  const mediaIds = collectMediaIds(sanitized)
  if (!mediaIds.length) return

  const media = await req.payload.find({
    collection: 'media',
    depth: 0,
    limit: mediaIds.length,
    overrideAccess: false,
    req,
    user: req.user,
    where: { id: { in: mediaIds } },
  })
  const found = new Set(media.docs.map((item) => String(item.id)))
  if (mediaIds.some((id) => !found.has(String(id)))) {
    throw new AppError('CONTENT_MEDIA_INVALID', '内容包含无权访问或不存在的图片', 409)
  }
  if (media.docs.some((item) => !item.mimeType?.startsWith('image/'))) {
    throw new AppError('CONTENT_MEDIA_INVALID', '内容只能引用站内 OSS 图片', 409)
  }
}

function assertScheduledExecution(document: ContentDocument, expectedPublishAt: string): boolean {
  return (
    statusOf(document) === 'in_review' &&
    Boolean(document.scheduledPublishAt) &&
    document.scheduledPublishAt === expectedPublishAt
  )
}

export async function executeContentWorkflow(
  req: PayloadRequest,
  collection: ContentCollection,
  id: number | string,
  input: ContentWorkflowInput,
  options: WorkflowOptions = {},
) {
  assertContentManager(req)
  const document = (await req.payload.findByID({
    collection,
    depth: 0,
    draft: true,
    id,
    overrideAccess: false,
    req,
    user: req.user,
  })) as ContentDocument

  if (
    options.scheduledExecution &&
    options.expectedPublishAt &&
    !assertScheduledExecution(document, options.expectedPublishAt)
  ) {
    return { ignored: true, status: statusOf(document) }
  }

  const fromStatus = statusOf(document)
  const toStatus = contentStatusAfterAction(fromStatus, input.action)
  if (input.action === 'cancel_scheduled_publish' && !document.scheduledPublishAt) {
    throw new AppError('CONTENT_SCHEDULE_NOT_FOUND', '当前内容没有待执行的定时发布', 409)
  }

  const now = new Date()
  if (input.action === 'schedule_publish') {
    const publishAt = new Date(input.publishAt as string)
    if (publishAt.getTime() <= now.getTime()) {
      throw new AppError('CONTENT_SCHEDULE_IN_PAST', '定时发布时间必须晚于当前时间', 400)
    }
    await validatePublishable(req, document)
  }
  if (input.action === 'publish' || input.action === 'publish_revision') {
    await validatePublishable(req, document)
  }

  const publishing = input.action === 'publish' || input.action === 'publish_revision'
  // Payload keeps the previous published version visible when a document is only saved as a
  // draft. Persist unpublish as a new internal published version whose workflowStatus is
  // unpublished; the anonymous access predicate then hides it immediately.
  const replacesPublicVersion = publishing || input.action === 'unpublish'
  const scheduledPublishAt =
    input.action === 'schedule_publish'
      ? input.publishAt
      : input.action === 'submit_review'
        ? document.scheduledPublishAt
        : null
  const previousWorkflowContext = req.context[CONTENT_WORKFLOW_CONTEXT]
  let updated: ContentDocument
  try {
    updated = (await req.payload.update({
      collection,
      context: { [CONTENT_WORKFLOW_CONTEXT]: true },
      data: {
        _status: replacesPublicVersion ? 'published' : 'draft',
        publishedAt: publishing
          ? (document.publishedAt ?? now.toISOString())
          : document.publishedAt,
        revisionBy: String(req.user?.id),
        scheduledPublishAt,
        workflowStatus: toStatus,
      },
      draft: !replacesPublicVersion,
      id,
      overrideAccess: false,
      req,
      user: req.user,
    })) as ContentDocument
  } finally {
    if (previousWorkflowContext === undefined) delete req.context[CONTENT_WORKFLOW_CONTEXT]
    else req.context[CONTENT_WORKFLOW_CONTEXT] = previousWorkflowContext
  }

  const auditAction =
    input.action === 'schedule_publish'
      ? 'content.publish.scheduled'
      : input.action === 'cancel_scheduled_publish'
        ? 'content.publish.schedule_cancelled'
        : input.action === 'publish_revision'
          ? 'content.revision.published'
          : 'content.status.changed'
  await recordAuditEvent(req, {
    action: auditAction,
    metadata: {
      action: input.action,
      collection,
      fromStatus,
      publishAt: input.publishAt,
      scheduledExecution: Boolean(options.scheduledExecution),
      toStatus,
    },
    targetId: id,
  })

  if (input.action === 'schedule_publish') {
    await req.payload.jobs.queue({
      input: {
        collection,
        documentId: String(id),
        publishAt: input.publishAt as string,
        scheduledBy: String(req.user?.id),
      },
      overrideAccess: true,
      queue: 'publishing',
      req,
      waitUntil: new Date(input.publishAt as string),
      workflow: 'contentScheduledPublish',
    })
  }

  return {
    ignored: false,
    scheduledPublishAt: updated.scheduledPublishAt ?? null,
    status: statusOf(updated),
  }
}

export async function runScheduledContentPublish(
  req: PayloadRequest,
  input: {
    collection: ContentCollection
    documentId: string
    publishAt: string
    scheduledBy: string
  },
) {
  const admin = await req.payload.findByID({
    collection: 'admins',
    depth: 0,
    id: input.scheduledBy,
    overrideAccess: true,
    req,
  })
  if (!isActiveAdminUser({ ...admin, collection: 'admins' })) {
    req.payload.logger.warn({
      collection: input.collection,
      documentId: input.documentId,
      msg: 'Scheduled content publish skipped because scheduler is inactive',
    })
    return { ignored: true, status: 'in_review' as const }
  }
  req.user = { ...admin, collection: 'admins' } as typeof req.user
  return executeContentWorkflow(
    req,
    input.collection,
    input.documentId,
    { action: 'publish' },
    { expectedPublishAt: input.publishAt, scheduledExecution: true },
  )
}
