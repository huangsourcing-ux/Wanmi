import { contentPath, type SeoContentCollection } from '@/lib/seo'
import { getPublicToolDefinition, type PublicToolSlug } from '@/lib/site-config'

export const MAX_REDIRECT_HOPS = 10

const PROTECTED_REDIRECT_PATHS = new Set([
  '/favicon.ico',
  '/healthz',
  '/opengraph-image',
  '/readyz',
  '/robots.txt',
  '/sitemap.xml',
])
const PROTECTED_REDIRECT_PREFIXES = ['/admin', '/api', '/_next']
// ASCII characters have an unambiguous literal spelling in a canonical path.
// Rejecting their encoded forms also prevents reserved-path and delimiter smuggling.
const AMBIGUOUS_ESCAPE_PATTERN = /%[0-7][0-9a-f]/i
const RAW_WHITESPACE_OR_CONTROL_PATTERN = /[\u0000-\u0020\u007f]/u

export type RedirectReference = {
  relationTo?: unknown
  value?: unknown
}

export type RedirectReferenceCollection = SeoContentCollection | 'toolPages'

export type RedirectTarget = {
  reference?: null | RedirectReference
  type?: null | string
  url?: null | string
}

export type RedirectDocument = {
  from?: unknown
  id?: number | string
  to?: null | RedirectTarget
  type?: unknown
}

export function isProtectedRedirectPath(path: string): boolean {
  if (PROTECTED_REDIRECT_PATHS.has(path)) return true
  return PROTECTED_REDIRECT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )
}

export function normalizeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('REDIRECT_INVALID')
  const path = value
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    RAW_WHITESPACE_OR_CONTROL_PATTERN.test(path) ||
    AMBIGUOUS_ESCAPE_PATTERN.test(path)
  ) {
    throw new Error('REDIRECT_OPEN_TARGET')
  }

  let normalized: string
  try {
    const parsed = new URL(path, 'https://wanmi.invalid')
    normalized = parsed.pathname.replace(/\/{2,}/g, '/')
  } catch {
    throw new Error('REDIRECT_INVALID')
  }
  if (normalized.length > 2_048) throw new Error('REDIRECT_TOO_LONG')
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  if (isProtectedRedirectPath(normalized)) throw new Error('REDIRECT_PROTECTED_PATH')
  return normalized
}

export function isRedirectEligiblePath(value: string): boolean {
  try {
    normalizeRedirectPath(value)
    return true
  } catch {
    return false
  }
}

export function isSeoContentCollection(value: unknown): value is SeoContentCollection {
  return (
    value === 'articles' ||
    value === 'topics' ||
    value === 'tldPages' ||
    value === 'helpPages' ||
    value === 'categories' ||
    value === 'tags'
  )
}

export function isRedirectReferenceCollection(
  value: unknown,
): value is RedirectReferenceCollection {
  return value === 'toolPages' || isSeoContentCollection(value)
}

function referenceValue(value: unknown): null | Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function referenceDocumentPath(reference: unknown): string | undefined {
  const candidate = referenceValue(reference)
  if (!candidate || !isRedirectReferenceCollection(candidate.relationTo)) return undefined
  const document = referenceValue(candidate.value)
  if (!document || typeof document.slug !== 'string') return undefined
  if (candidate.relationTo === 'toolPages') {
    try {
      return normalizeRedirectPath(getPublicToolDefinition(document.slug as PublicToolSlug).href)
    } catch {
      return undefined
    }
  }
  if (candidate.relationTo === 'categories' || candidate.relationTo === 'tags') {
    if (document.publiclyAvailable !== true) return undefined
  } else if (document._status !== 'published' || document.workflowStatus !== 'published') {
    return undefined
  }
  return normalizeRedirectPath(contentPath(candidate.relationTo, document.slug))
}

export function runtimeRedirectTarget(document: RedirectDocument): string | undefined {
  if (document.type !== '301' || !document.to) return undefined
  if (document.to.type === 'custom') {
    try {
      return normalizeRedirectPath(document.to.url)
    } catch {
      return undefined
    }
  }
  if (document.to.type === 'reference') return referenceDocumentPath(document.to.reference)
  return undefined
}

export type RedirectIndexResult = {
  destinations: ReadonlyMap<string, string>
  invalidRules: number
}

export function buildRedirectIndex(documents: RedirectDocument[]): RedirectIndexResult {
  const direct = new Map<string, string>()
  const invalidSources = new Set<string>()

  for (const document of documents) {
    let from: string
    try {
      from = normalizeRedirectPath(document.from)
    } catch {
      continue
    }
    const target = runtimeRedirectTarget(document)
    if (!target || from === target || direct.has(from) || invalidSources.has(from)) {
      direct.delete(from)
      invalidSources.add(from)
      continue
    }
    direct.set(from, target)
  }

  const destinations = new Map<string, string>()
  let invalidRules = invalidSources.size
  for (const [from, initialTarget] of direct) {
    const visited = new Set([from])
    let target = initialTarget
    let hops = 1
    let valid = true

    while (true) {
      if (visited.has(target) || invalidSources.has(target)) {
        valid = false
        break
      }
      visited.add(target)
      const next = direct.get(target)
      if (!next) break
      if (hops >= MAX_REDIRECT_HOPS) {
        valid = false
        break
      }
      target = next
      hops += 1
    }

    if (valid) destinations.set(from, target)
    else invalidRules += 1
  }

  return { destinations, invalidRules }
}
