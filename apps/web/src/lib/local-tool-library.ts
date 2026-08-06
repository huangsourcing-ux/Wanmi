import { z } from 'zod'

import { isTrackingOptedOut } from '@/lib/analytics'
import { normalizeDomain } from '@/lib/domain-name'

export const LOCAL_HISTORY_STORAGE_KEY = 'wanmi:tool-history:v1'
export const LOCAL_FAVORITES_STORAGE_KEY = 'wanmi:tool-favorites:v1'
export const LOCAL_LIBRARY_CHANGED_EVENT = 'wanmi:local-tool-library-change'
export const LOCAL_LIBRARY_MAX_ITEMS = 30
export const LOCAL_LIBRARY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

export const queryToolSlugSchema = z.enum(['dns', 'domain-search', 'idn', 'ssl-check', 'whois'])
export const favoriteToolSlugSchema = z.enum([
  'dns',
  'domain-search',
  'idn',
  'pricing',
  'ssl-check',
  'whois',
])

export type QueryToolSlug = z.infer<typeof queryToolSlugSchema>
export type FavoriteToolSlug = z.infer<typeof favoriteToolSlugSchema>

const localHistoryItemSchema = z
  .object({
    query: z.string().trim().min(1).max(1_024),
    tool: queryToolSlugSchema,
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict()

const toolFavoriteSchema = z
  .object({
    kind: z.literal('tool'),
    tool: favoriteToolSlugSchema,
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict()

const domainFavoriteSchema = z
  .object({
    domainAscii: z.string().min(1).max(253),
    domainUnicode: z.string().min(1).max(253),
    kind: z.literal('domain'),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict()

const localFavoriteItemSchema = z
  .discriminatedUnion('kind', [toolFavoriteSchema, domainFavoriteSchema])
  .refine(
    (item) => {
      if (item.kind === 'tool') return true
      const normalized = normalizeDomain(item.domainAscii)
      return (
        normalized.ok &&
        normalized.value.ascii === item.domainAscii &&
        normalized.value.unicode === item.domainUnicode
      )
    },
    { message: '收藏域名必须是相互匹配的规范化 ASCII 与 Unicode 值' },
  )

const collectionEnvelopeSchema = z
  .object({
    items: z.array(z.unknown()),
    version: z.literal(1),
  })
  .strict()

export type LocalHistoryItem = z.infer<typeof localHistoryItemSchema>
export type LocalFavoriteItem = z.infer<typeof localFavoriteItemSchema>

export type LocalToolLibrarySnapshot = {
  available: boolean
  favorites: LocalFavoriteItem[]
  history: LocalHistoryItem[]
  historyRecordingEnabled: boolean
  recovered: boolean
}

export type LocalLibraryMutationReason =
  | 'invalid_domain'
  | 'invalid_query'
  | 'privacy_signal'
  | 'storage_unavailable'

export type LocalLibraryMutationResult = {
  changed?: 'added' | 'removed' | 'updated'
  ok: boolean
  reason?: LocalLibraryMutationReason
  snapshot: LocalToolLibrarySnapshot
}

export type LocalLibraryOptions = {
  notify?: boolean
  now?: number
  privacyOptedOut?: boolean
  storage?: Storage | null
}

type ReadCollectionResult<T> = {
  available: boolean
  items: T[]
  recovered: boolean
}

const historyPaths: Record<QueryToolSlug, string> = {
  dns: '/tools/dns',
  'domain-search': '/tools/domain-search',
  idn: '/tools/idn',
  'ssl-check': '/tools/ssl-check',
  whois: '/tools/whois',
}

const favoriteToolPaths: Record<FavoriteToolSlug, string> = {
  ...historyPaths,
  pricing: '/pricing',
}

function resolveNow(options: LocalLibraryOptions): number {
  return options.now ?? Date.now()
}

function resolvePrivacyOptOut(options: LocalLibraryOptions): boolean {
  return options.privacyOptedOut ?? isTrackingOptedOut()
}

function resolveStorage(options: LocalLibraryOptions): Storage | undefined {
  if ('storage' in options) return options.storage ?? undefined
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function normalizeRawQuery(query: string): string {
  return query.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

export function historyIdentity(item: Pick<LocalHistoryItem, 'query' | 'tool'>): string {
  const normalized = normalizeDomain(item.query)
  const queryKey = normalized.ok
    ? `domain:${normalized.value.ascii}`
    : `raw:${normalizeRawQuery(item.query)}`
  return `${item.tool}:${queryKey}`
}

export function favoriteIdentity(item: LocalFavoriteItem): string {
  return item.kind === 'tool' ? `tool:${item.tool}` : `domain:${item.domainAscii}`
}

function sanitizeItems<T extends { updatedAt: number }>(
  candidates: unknown[],
  schema: z.ZodType<T>,
  identity: (item: T) => string,
  now: number,
): { items: T[]; recovered: boolean } {
  const cutoff = now - LOCAL_LIBRARY_RETENTION_MS
  const deduplicated = new Map<string, T>()
  let recovered = false

  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate)
    if (!parsed.success) {
      recovered = true
      continue
    }
    const item = parsed.data
    if (item.updatedAt <= cutoff || item.updatedAt > now + MAX_CLOCK_SKEW_MS) {
      recovered = true
      continue
    }
    const key = identity(item)
    const existing = deduplicated.get(key)
    if (!existing || item.updatedAt > existing.updatedAt) deduplicated.set(key, item)
    if (existing) recovered = true
  }

  const sorted = [...deduplicated.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  if (sorted.length > LOCAL_LIBRARY_MAX_ITEMS) recovered = true
  return { items: sorted.slice(0, LOCAL_LIBRARY_MAX_ITEMS), recovered }
}

function persistCollection<T>(storage: Storage, key: string, items: T[]): boolean {
  try {
    if (items.length === 0) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify({ items, version: 1 }))
    return true
  } catch {
    return false
  }
}

function removeCorruptCollection(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

function readCollection<T extends { updatedAt: number }>(
  storage: Storage,
  key: string,
  schema: z.ZodType<T>,
  identity: (item: T) => string,
  now: number,
): ReadCollectionResult<T> {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return { available: false, items: [], recovered: false }
  }
  if (raw === null) return { available: true, items: [], recovered: false }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return {
      available: removeCorruptCollection(storage, key),
      items: [],
      recovered: true,
    }
  }

  const envelope = collectionEnvelopeSchema.safeParse(parsedJson)
  if (!envelope.success) {
    return {
      available: removeCorruptCollection(storage, key),
      items: [],
      recovered: true,
    }
  }

  const sanitized = sanitizeItems(envelope.data.items, schema, identity, now)
  const normalizedRaw = JSON.stringify({ items: sanitized.items, version: 1 })
  const needsRewrite = sanitized.recovered || normalizedRaw !== raw
  const available = !needsRewrite || persistCollection(storage, key, sanitized.items)
  return { available, items: sanitized.items, recovered: needsRewrite }
}

export function readLocalToolLibrary(options: LocalLibraryOptions = {}): LocalToolLibrarySnapshot {
  const storage = resolveStorage(options)
  const historyRecordingEnabled = !resolvePrivacyOptOut(options)
  if (!storage) {
    return {
      available: false,
      favorites: [],
      history: [],
      historyRecordingEnabled,
      recovered: false,
    }
  }

  const now = resolveNow(options)
  const history = readCollection(
    storage,
    LOCAL_HISTORY_STORAGE_KEY,
    localHistoryItemSchema,
    historyIdentity,
    now,
  )
  const favorites = readCollection(
    storage,
    LOCAL_FAVORITES_STORAGE_KEY,
    localFavoriteItemSchema,
    favoriteIdentity,
    now,
  )
  return {
    available: history.available && favorites.available,
    favorites: favorites.items,
    history: history.items,
    historyRecordingEnabled,
    recovered: history.recovered || favorites.recovered,
  }
}

function notifyLibraryChanged(options: LocalLibraryOptions): void {
  if (options.notify === false || typeof window === 'undefined') return
  try {
    window.dispatchEvent(new Event(LOCAL_LIBRARY_CHANGED_EVENT))
  } catch {
    // Local state synchronization is best effort and must not interrupt a tool flow.
  }
}

function failedMutation(
  reason: LocalLibraryMutationReason,
  options: LocalLibraryOptions,
  snapshot = readLocalToolLibrary(options),
): LocalLibraryMutationResult {
  return { ok: false, reason, snapshot }
}

function snapshotAfterWrite(
  options: LocalLibraryOptions,
  changed: LocalLibraryMutationResult['changed'],
): LocalLibraryMutationResult {
  notifyLibraryChanged(options)
  return { changed, ok: true, snapshot: readLocalToolLibrary(options) }
}

export function recordLocalHistory(
  input: { query: string; tool: QueryToolSlug },
  options: LocalLibraryOptions = {},
): LocalLibraryMutationResult {
  if (resolvePrivacyOptOut(options)) return failedMutation('privacy_signal', options)
  const query = input.query.trim()
  if (!query || query.length > 1_024) return failedMutation('invalid_query', options)

  const storage = resolveStorage(options)
  if (!storage) return failedMutation('storage_unavailable', options)
  const snapshot = readLocalToolLibrary({ ...options, storage })
  if (!snapshot.available) return failedMutation('storage_unavailable', options, snapshot)

  const updatedAt = resolveNow(options)
  const nextItem: LocalHistoryItem = { query, tool: input.tool, updatedAt }
  const key = historyIdentity(nextItem)
  const existed = snapshot.history.some((item) => historyIdentity(item) === key)
  const nextItems = [
    nextItem,
    ...snapshot.history.filter((item) => historyIdentity(item) !== key),
  ].slice(0, LOCAL_LIBRARY_MAX_ITEMS)
  if (!persistCollection(storage, LOCAL_HISTORY_STORAGE_KEY, nextItems)) {
    return failedMutation('storage_unavailable', options, snapshot)
  }
  return snapshotAfterWrite({ ...options, storage }, existed ? 'updated' : 'added')
}

export function toggleToolFavorite(
  tool: FavoriteToolSlug,
  options: LocalLibraryOptions = {},
): LocalLibraryMutationResult {
  const storage = resolveStorage(options)
  if (!storage) return failedMutation('storage_unavailable', options)
  const snapshot = readLocalToolLibrary({ ...options, storage })
  if (!snapshot.available) return failedMutation('storage_unavailable', options, snapshot)

  const identity = `tool:${tool}`
  const existed = snapshot.favorites.some((item) => favoriteIdentity(item) === identity)
  const nextItems = existed
    ? snapshot.favorites.filter((item) => favoriteIdentity(item) !== identity)
    : [
        { kind: 'tool' as const, tool, updatedAt: resolveNow(options) },
        ...snapshot.favorites,
      ].slice(0, LOCAL_LIBRARY_MAX_ITEMS)
  if (!persistCollection(storage, LOCAL_FAVORITES_STORAGE_KEY, nextItems)) {
    return failedMutation('storage_unavailable', options, snapshot)
  }
  return snapshotAfterWrite({ ...options, storage }, existed ? 'removed' : 'added')
}

export function toggleDomainFavorite(
  domain: string,
  options: LocalLibraryOptions = {},
): LocalLibraryMutationResult {
  const normalized = normalizeDomain(domain)
  if (!normalized.ok) return failedMutation('invalid_domain', options)
  const storage = resolveStorage(options)
  if (!storage) return failedMutation('storage_unavailable', options)
  const snapshot = readLocalToolLibrary({ ...options, storage })
  if (!snapshot.available) return failedMutation('storage_unavailable', options, snapshot)

  const nextItem: LocalFavoriteItem = {
    domainAscii: normalized.value.ascii,
    domainUnicode: normalized.value.unicode,
    kind: 'domain',
    updatedAt: resolveNow(options),
  }
  const identity = favoriteIdentity(nextItem)
  const existed = snapshot.favorites.some((item) => favoriteIdentity(item) === identity)
  const nextItems = existed
    ? snapshot.favorites.filter((item) => favoriteIdentity(item) !== identity)
    : [nextItem, ...snapshot.favorites].slice(0, LOCAL_LIBRARY_MAX_ITEMS)
  if (!persistCollection(storage, LOCAL_FAVORITES_STORAGE_KEY, nextItems)) {
    return failedMutation('storage_unavailable', options, snapshot)
  }
  return snapshotAfterWrite({ ...options, storage }, existed ? 'removed' : 'added')
}

export function deleteLocalHistory(
  item: Pick<LocalHistoryItem, 'query' | 'tool'>,
  options: LocalLibraryOptions = {},
): LocalLibraryMutationResult {
  const storage = resolveStorage(options)
  if (!storage) return failedMutation('storage_unavailable', options)
  const snapshot = readLocalToolLibrary({ ...options, storage })
  if (!snapshot.available) return failedMutation('storage_unavailable', options, snapshot)
  const identity = historyIdentity(item)
  const nextItems = snapshot.history.filter((candidate) => historyIdentity(candidate) !== identity)
  if (!persistCollection(storage, LOCAL_HISTORY_STORAGE_KEY, nextItems)) {
    return failedMutation('storage_unavailable', options, snapshot)
  }
  return snapshotAfterWrite({ ...options, storage }, 'removed')
}

export function deleteLocalFavorite(
  item: LocalFavoriteItem,
  options: LocalLibraryOptions = {},
): LocalLibraryMutationResult {
  const storage = resolveStorage(options)
  if (!storage) return failedMutation('storage_unavailable', options)
  const snapshot = readLocalToolLibrary({ ...options, storage })
  if (!snapshot.available) return failedMutation('storage_unavailable', options, snapshot)
  const identity = favoriteIdentity(item)
  const nextItems = snapshot.favorites.filter(
    (candidate) => favoriteIdentity(candidate) !== identity,
  )
  if (!persistCollection(storage, LOCAL_FAVORITES_STORAGE_KEY, nextItems)) {
    return failedMutation('storage_unavailable', options, snapshot)
  }
  return snapshotAfterWrite({ ...options, storage }, 'removed')
}

function clearKeys(keys: string[], options: LocalLibraryOptions): LocalLibraryMutationResult {
  const storage = resolveStorage(options)
  if (!storage) return failedMutation('storage_unavailable', options)
  let removed = true
  for (const key of keys) {
    try {
      storage.removeItem(key)
    } catch {
      removed = false
    }
  }
  if (!removed) return failedMutation('storage_unavailable', options)
  return snapshotAfterWrite({ ...options, storage }, 'removed')
}

export function clearLocalHistory(options: LocalLibraryOptions = {}): LocalLibraryMutationResult {
  return clearKeys([LOCAL_HISTORY_STORAGE_KEY], options)
}

export function clearLocalFavorites(options: LocalLibraryOptions = {}): LocalLibraryMutationResult {
  return clearKeys([LOCAL_FAVORITES_STORAGE_KEY], options)
}

export function clearLocalToolLibrary(
  options: LocalLibraryOptions = {},
): LocalLibraryMutationResult {
  return clearKeys([LOCAL_HISTORY_STORAGE_KEY, LOCAL_FAVORITES_STORAGE_KEY], options)
}

export function getHistoryHref(item: Pick<LocalHistoryItem, 'query' | 'tool'>): string {
  const parameters = new URLSearchParams({ q: item.query })
  return `${historyPaths[item.tool]}?${parameters.toString()}`
}

export function getFavoriteHref(item: LocalFavoriteItem): string {
  if (item.kind === 'tool') return favoriteToolPaths[item.tool]
  const parameters = new URLSearchParams({ q: item.domainAscii })
  return `/tools/domain-search?${parameters.toString()}`
}

export function getFavoriteDomainDisplay(item: Extract<LocalFavoriteItem, { kind: 'domain' }>): {
  primary: string
  secondary?: string
} {
  return item.domainUnicode === item.domainAscii
    ? { primary: item.domainAscii }
    : { primary: item.domainUnicode, secondary: item.domainAscii }
}
