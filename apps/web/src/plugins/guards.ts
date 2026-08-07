import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeValidateHook,
  Field,
  PayloadRequest,
} from 'payload'

import {
  contentAdminHidden,
  contentManagers,
  deny,
  systemAdminHidden,
  systemAdminOnly,
} from '@/access/roles'
import { AppError } from '@/lib/errors'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import {
  isRedirectReferenceCollection,
  MAX_REDIRECT_HOPS,
  normalizeRedirectPath,
  type RedirectDocument,
  type RedirectTarget,
} from '@/lib/redirects'
import { contentPath } from '@/lib/seo'
import { getPublicToolDefinition, type PublicToolSlug } from '@/lib/site-config'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

function normalizePath(value: unknown): string {
  try {
    return normalizeRedirectPath(value)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'REDIRECT_INVALID'
    if (code === 'REDIRECT_PROTECTED_PATH') {
      throw new AppError(code, '重定向不能覆盖后台、API 或系统路径', 400)
    }
    if (code === 'REDIRECT_TOO_LONG') {
      throw new AppError(code, '重定向路径不能超过 2048 个字符', 400)
    }
    if (code === 'REDIRECT_OPEN_TARGET') {
      throw new AppError(code, '重定向只允许不含查询或片段的站内绝对路径', 400)
    }
    throw new AppError('REDIRECT_INVALID', '重定向路径无效', 400)
  }
}

function referenceIdentity(reference: RedirectTarget['reference']):
  | {
      id: number | string
      relationTo:
        | 'articles'
        | 'categories'
        | 'helpPages'
        | 'tags'
        | 'tldPages'
        | 'toolPages'
        | 'topics'
    }
  | undefined {
  if (!reference || !isRedirectReferenceCollection(reference.relationTo)) return undefined
  const value = reference.value
  const id =
    typeof value === 'object' && value !== null && 'id' in value
      ? (value as { id?: unknown }).id
      : value
  if (typeof id !== 'number' && typeof id !== 'string') return undefined
  return { id, relationTo: reference.relationTo }
}

async function taxonomyHasPublishedArticle(
  req: PayloadRequest,
  collection: 'categories' | 'tags',
  id: number | string,
): Promise<boolean> {
  const result = await req.payload.find({
    collection: 'articles',
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    req,
    user: req.user ?? undefined,
    where: {
      and: [
        { [collection]: { equals: id } },
        { _status: { equals: 'published' } },
        { workflowStatus: { equals: 'published' } },
      ],
    },
  })
  return result.totalDocs > 0
}

async function resolveReferenceTarget(
  req: PayloadRequest,
  reference: RedirectTarget['reference'],
): Promise<string> {
  const identity = referenceIdentity(reference)
  if (!identity) throw new AppError('REDIRECT_REFERENCE_INVALID', '重定向引用目标无效', 400)
  const document = await req.payload.findByID({
    collection: identity.relationTo,
    depth: 0,
    id: identity.id,
    overrideAccess: false,
    req,
    user: req.user ?? undefined,
  })
  const targetDocument = document as unknown as Record<string, unknown>
  if (identity.relationTo === 'toolPages') {
    return normalizePath(getPublicToolDefinition(targetDocument.slug as PublicToolSlug).href)
  }
  if (identity.relationTo === 'categories' || identity.relationTo === 'tags') {
    if (!(await taxonomyHasPublishedArticle(req, identity.relationTo, identity.id))) {
      throw new AppError(
        'REDIRECT_TARGET_UNPUBLISHED',
        '分类或标签目标必须至少包含一篇已发布文章',
        400,
      )
    }
  } else if (
    targetDocument._status !== 'published' ||
    targetDocument.workflowStatus !== 'published'
  ) {
    throw new AppError('REDIRECT_TARGET_UNPUBLISHED', '重定向引用目标必须已发布', 400)
  }
  return normalizePath(contentPath(identity.relationTo, targetDocument.slug))
}

async function resolveTarget(
  req: PayloadRequest,
  target: RedirectTarget | undefined,
): Promise<string> {
  if (target?.type === 'custom') return normalizePath(target.url)
  if (target?.type === 'reference') return resolveReferenceTarget(req, target.reference)
  throw new AppError('REDIRECT_TARGET_INVALID', '重定向目标无效', 400)
}

function mergeTarget(
  data: RedirectTarget | undefined,
  original: RedirectTarget | undefined,
): RedirectTarget | undefined {
  if (!data && !original) return undefined
  return { ...original, ...data }
}

export const validateRedirect: CollectionBeforeValidateHook = async ({
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data
  const from = normalizePath(data.from ?? originalDoc?.from)
  data.from = from
  if ((data.type ?? originalDoc?.type) !== '301') {
    throw new AppError('REDIRECT_TYPE_FORBIDDEN', '页面改址只允许永久 301 重定向', 400)
  }

  const mergedTarget = mergeTarget(data.to, originalDoc?.to)
  const target = await resolveTarget(req, mergedTarget)
  if (mergedTarget?.type === 'custom') {
    data.to = { ...data.to, type: 'custom', url: target }
  }
  if (from === target) throw new AppError('REDIRECT_LOOP', '重定向起点和终点不能相同', 400)

  const visited = new Set([from])
  let cursor = target
  let hops = 1
  while (true) {
    if (visited.has(cursor)) throw new AppError('REDIRECT_LOOP', '检测到重定向循环', 400)
    visited.add(cursor)
    const next = await req.payload.find({
      collection: 'redirects',
      depth: 0,
      limit: 1,
      overrideAccess: false,
      req,
      user: req.user ?? undefined,
      where: originalDoc?.id
        ? {
            and: [
              { from: { equals: cursor } },
              { id: { not_equals: originalDoc.id as number | string } },
            ],
          }
        : { from: { equals: cursor } },
    })
    const redirect = next.docs[0] as RedirectDocument | undefined
    if (!redirect) return data
    if (hops >= MAX_REDIRECT_HOPS) {
      throw new AppError('REDIRECT_CHAIN_TOO_LONG', '重定向链不能超过 10 跳', 400)
    }
    cursor = await resolveTarget(req, redirect.to ?? undefined)
    hops += 1
  }
}

function redirectSnapshot(
  document: RedirectDocument | undefined,
): Record<string, unknown> | undefined {
  if (!document) return undefined
  const reference = referenceIdentity(document.to?.reference)
  return {
    from: document.from,
    to:
      document.to?.type === 'reference'
        ? { reference, type: 'reference' }
        : { type: document.to?.type, url: document.to?.url },
    type: document.type,
  }
}

export const auditRedirectChange: CollectionAfterChangeHook = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  await recordAuditEvent(req, {
    action: operation === 'create' ? 'redirect.create' : 'redirect.update',
    metadata: {
      after: redirectSnapshot(doc as RedirectDocument),
      before: redirectSnapshot(previousDoc as RedirectDocument | undefined),
    },
    targetId: doc.id,
  })
  return doc
}

export const auditRedirectDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await recordAuditEvent(req, {
    action: 'redirect.delete',
    metadata: { before: redirectSnapshot(doc as RedirectDocument) },
    targetId: doc.id,
  })
  return doc
}

const allowedFormBlocks = new Set([
  'checkbox',
  'email',
  'message',
  'number',
  'select',
  'text',
  'textarea',
])

export const validateSafeForm: CollectionBeforeValidateHook = ({ data }) => {
  if (!data) return data
  for (const field of data.fields ?? []) {
    if (!allowedFormBlocks.has(field.blockType)) {
      throw new AppError('FORM_FIELD_FORBIDDEN', '表单不允许支付、实名或文件上传字段', 400)
    }
  }
  if (data.redirect?.url) data.redirect.url = normalizePath(data.redirect.url)
  return data
}

export const redirectsOverrides = {
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: () => true,
    update: contentManagers,
  },
  admin: { group: ADMIN_GROUPS.content, hidden: contentAdminHidden },
  hooks: {
    afterChange: [auditRedirectChange],
    afterDelete: [auditRedirectDelete],
    beforeValidate: [validateRedirect],
  },
}

export const formOverrides = {
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: contentManagers,
    update: contentManagers,
  },
  admin: { group: ADMIN_GROUPS.content, hidden: contentAdminHidden },
  hooks: { beforeValidate: [validateSafeForm] },
}

export const formSubmissionOverrides = {
  access: {
    create: () => true,
    delete: deny,
    read: systemAdminOnly,
    update: systemAdminOnly,
  },
  admin: { group: ADMIN_GROUPS.operations, hidden: systemAdminHidden },
}

export function appendFormPurposeField({ defaultFields }: { defaultFields: Field[] }): Field[] {
  return [
    ...defaultFields,
    {
      name: 'purpose',
      type: 'select',
      defaultValue: 'feedback',
      options: ['contact', 'feedback', 'request'],
      required: true,
    },
  ]
}
