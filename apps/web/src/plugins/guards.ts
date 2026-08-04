import type { CollectionBeforeValidateHook, Field } from 'payload'

import { contentManagers, deny, systemAdminOnly } from '@/access/roles'
import { AppError } from '@/lib/errors'

function normalizePath(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('REDIRECT_INVALID', '重定向路径无效', 400)
  const path = value.trim()
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new AppError('REDIRECT_OPEN_TARGET', '重定向只允许站内绝对路径', 400)
  }
  return path
}

export const validateRedirect: CollectionBeforeValidateHook = async ({
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data
  const from = normalizePath(data.from ?? originalDoc?.from)
  data.from = from
  if (data.to?.type !== 'custom') return data

  const target = normalizePath(data.to.url)
  data.to.url = target
  if (from === target) throw new AppError('REDIRECT_LOOP', '重定向起点和终点不能相同', 400)

  const visited = new Set([from])
  let cursor = target
  for (let depth = 0; depth < 10; depth += 1) {
    if (visited.has(cursor)) throw new AppError('REDIRECT_LOOP', '检测到重定向循环', 400)
    visited.add(cursor)
    const next = await req.payload.find({
      collection: 'redirects',
      limit: 1,
      overrideAccess: true,
      req,
      where: { from: { equals: cursor } },
    })
    const redirect = next.docs[0] as { to?: { type?: string; url?: string } } | undefined
    if (redirect?.to?.type !== 'custom' || !redirect.to.url) return data
    cursor = redirect.to.url
  }
  throw new AppError('REDIRECT_CHAIN_TOO_LONG', '重定向链不能超过 10 跳', 400)
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
  hooks: { beforeValidate: [validateRedirect] },
}

export const formOverrides = {
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: contentManagers,
    update: contentManagers,
  },
  hooks: { beforeValidate: [validateSafeForm] },
}

export const formSubmissionOverrides = {
  access: {
    create: () => true,
    delete: deny,
    read: systemAdminOnly,
    update: systemAdminOnly,
  },
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
