import { AppError } from '@/lib/errors'

const ALLOWED_TEXT_FORMAT_MASK = 1 | 2 | 8 | 16
const ALLOWED_CONTAINER_TYPES = new Set([
  'heading',
  'link',
  'list',
  'listitem',
  'paragraph',
  'quote',
  'root',
])
const FORBIDDEN_NODE_TYPES = new Set([
  'block',
  'embed',
  'html',
  'iframe',
  'inlineBlock',
  'object',
  'relationship',
  'script',
])
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u
const FORBIDDEN_PROTOCOL_PATTERN = /^(?:data|file|ftp|javascript):/iu

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidContent(message = '富文本包含不允许的内容'): never {
  throw new AppError('CONTENT_RICH_TEXT_INVALID', message, 400)
}

export function sanitizeContentLink(value: unknown): string {
  if (typeof value !== 'string') return invalidContent('链接地址无效')
  const href = value.trim()
  if (!href || href.includes('\\') || CONTROL_CHARACTER_PATTERN.test(href)) {
    return invalidContent('链接地址无效')
  }
  if (href.startsWith('//') || FORBIDDEN_PROTOCOL_PATTERN.test(href)) {
    return invalidContent('链接协议不受允许')
  }
  if (href.startsWith('/') || href.startsWith('#')) return href

  try {
    const url = new URL(href)
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
      return invalidContent('链接协议不受允许')
    }
    if (url.username || url.password) return invalidContent('链接不得包含用户凭据')
    return url.toString()
  } catch {
    return invalidContent('链接地址无效')
  }
}

export function isExternalContentLink(href: string, siteOrigin: string): boolean {
  if (!/^https?:/iu.test(href)) return false
  try {
    return new URL(href).origin !== new URL(siteOrigin).origin
  } catch {
    return false
  }
}

function scalarDocumentId(value: unknown): number | string {
  if (typeof value === 'number' || typeof value === 'string') return value
  if (isRecord(value) && (typeof value.id === 'number' || typeof value.id === 'string')) {
    return value.id
  }
  return invalidContent('图片引用无效')
}

function sanitizeTextNode(node: JsonRecord): JsonRecord {
  if (typeof node.text !== 'string') return invalidContent()
  return {
    detail: typeof node.detail === 'number' ? node.detail & 3 : 0,
    format: typeof node.format === 'number' ? node.format & ALLOWED_TEXT_FORMAT_MASK : 0,
    mode: 'normal',
    style: '',
    text: node.text,
    type: 'text',
    version: 1,
  }
}

function sanitizeUploadNode(node: JsonRecord): JsonRecord {
  if (node.relationTo !== 'media') return invalidContent('图片只能引用站内 OSS Media')
  return {
    fields: {},
    format: '',
    id: typeof node.id === 'string' && node.id ? node.id : crypto.randomUUID(),
    relationTo: 'media',
    type: 'upload',
    value: scalarDocumentId(node.value),
    version: 1,
  }
}

function sanitizeContainerNode(node: JsonRecord, type: string): JsonRecord {
  if (!Array.isArray(node.children)) return invalidContent()
  const children = node.children.map(sanitizeNode)
  const base: JsonRecord = {
    children,
    direction: node.direction === 'ltr' || node.direction === 'rtl' ? node.direction : null,
    format: '',
    indent: 0,
    type,
    version: 1,
  }

  if (type === 'root') return base
  if (type === 'paragraph') return { ...base, textFormat: 0, textStyle: '' }
  if (type === 'heading') {
    if (!['h2', 'h3', 'h4'].includes(String(node.tag))) {
      return invalidContent('只允许 H2 至 H4 标题')
    }
    return { ...base, tag: node.tag }
  }
  if (type === 'quote') return base
  if (type === 'list') {
    const listType =
      node.listType === 'number' ? 'number' : node.listType === 'bullet' ? 'bullet' : null
    if (!listType) return invalidContent('只允许有序或无序列表')
    return {
      ...base,
      listType,
      start: typeof node.start === 'number' && Number.isInteger(node.start) ? node.start : 1,
      tag: listType === 'number' ? 'ol' : 'ul',
    }
  }
  if (type === 'listitem') {
    return {
      ...base,
      value: typeof node.value === 'number' && Number.isInteger(node.value) ? node.value : 1,
    }
  }

  if (type === 'link') {
    if (!isRecord(node.fields)) return invalidContent('链接字段无效')
    if (node.fields.linkType !== 'custom') return invalidContent('富文本只允许受控 URL 链接')
    return {
      ...base,
      fields: {
        linkType: 'custom',
        newTab: Boolean(node.fields.newTab),
        url: sanitizeContentLink(node.fields.url),
      },
      id: typeof node.id === 'string' ? node.id : undefined,
    }
  }

  return invalidContent()
}

function sanitizeNode(value: unknown): JsonRecord {
  if (!isRecord(value) || typeof value.type !== 'string') return invalidContent()
  if (FORBIDDEN_NODE_TYPES.has(value.type)) return invalidContent()
  if (value.type === 'text') return sanitizeTextNode(value)
  if (value.type === 'linebreak') return { type: 'linebreak', version: 1 }
  if (value.type === 'upload') return sanitizeUploadNode(value)
  if (ALLOWED_CONTAINER_TYPES.has(value.type)) return sanitizeContainerNode(value, value.type)
  return invalidContent(`不支持的富文本节点：${value.type}`)
}

export function sanitizeRichText(value: unknown): JsonRecord {
  if (!isRecord(value) || !isRecord(value.root)) return invalidContent('富文本根节点无效')
  const root = sanitizeNode(value.root)
  if (root.type !== 'root') return invalidContent('富文本根节点无效')
  return { root }
}

export function collectMediaIds(value: unknown): Array<number | string> {
  const ids = new Set<number | string>()
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!isRecord(candidate)) return
    if (candidate.type === 'upload' && candidate.relationTo === 'media') {
      ids.add(scalarDocumentId(candidate.value))
    }
    if (Array.isArray(candidate.children)) candidate.children.forEach(visit)
    if (isRecord(candidate.root)) visit(candidate.root)
  }
  visit(value)
  return [...ids]
}
