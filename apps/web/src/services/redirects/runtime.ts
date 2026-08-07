import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import {
  buildRedirectIndex,
  isRedirectReferenceCollection,
  type RedirectDocument,
  type RedirectReferenceCollection,
} from '@/lib/redirects'
import { logger } from '@/lib/logging'
import { PUBLIC_TAXONOMY_CONTEXT } from '@/services/content/types'

export const REDIRECT_CACHE_TTL_MS = 30_000
const REDIRECT_PAGE_SIZE = 200

type RedirectLoader = () => Promise<ReadonlyMap<string, string>>

export type RedirectResolver = {
  resolve(path: string): Promise<string | undefined>
}

function referenceIdentity(
  document: RedirectDocument,
): { collection: RedirectReferenceCollection; id: number | string } | undefined {
  const reference = document.to?.reference
  if (!reference || !isRedirectReferenceCollection(reference.relationTo)) return undefined
  const value = reference.value
  const id =
    typeof value === 'object' && value !== null && 'id' in value
      ? (value as { id?: unknown }).id
      : value
  if (typeof id !== 'number' && typeof id !== 'string') return undefined
  return { collection: reference.relationTo, id }
}

async function loadPublicReference(
  payload: Pick<Payload, 'find'>,
  collection: RedirectReferenceCollection,
  id: number | string,
): Promise<Record<string, unknown> | undefined> {
  const taxonomy = collection === 'categories' || collection === 'tags'
  const result = await payload.find({
    collection,
    ...(taxonomy ? { context: { [PUBLIC_TAXONOMY_CONTEXT]: [id] } } : {}),
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    where:
      taxonomy || collection === 'toolPages'
        ? { id: { equals: id } }
        : {
            and: [
              { id: { equals: id } },
              { _status: { equals: 'published' } },
              { workflowStatus: { equals: 'published' } },
            ],
          },
  })
  const reference = result.docs[0] as unknown as Record<string, unknown> | undefined
  if (!reference || !taxonomy) return reference
  const article = await payload.find({
    collection: 'articles',
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    where: {
      and: [
        { [collection]: { equals: id } },
        { _status: { equals: 'published' } },
        { workflowStatus: { equals: 'published' } },
      ],
    },
  })
  return { ...reference, publiclyAvailable: article.totalDocs > 0 }
}

async function hydrateRedirectReferences(
  payload: Pick<Payload, 'find'>,
  documents: RedirectDocument[],
): Promise<RedirectDocument[]> {
  const cache = new Map<string, Promise<Record<string, unknown> | undefined>>()
  return Promise.all(
    documents.map(async (document) => {
      const identity = referenceIdentity(document)
      if (!identity || document.to?.type !== 'reference') return document
      const key = `${identity.collection}:${identity.id}`
      let pending = cache.get(key)
      if (!pending) {
        pending = loadPublicReference(payload, identity.collection, identity.id).catch(
          () => undefined,
        )
        cache.set(key, pending)
      }
      const value = await pending
      if (!value) return { ...document, to: { ...document.to, reference: undefined } }
      return {
        ...document,
        to: {
          ...document.to,
          reference: { relationTo: identity.collection, value },
        },
      }
    }),
  )
}

export function createRedirectResolver(
  load: RedirectLoader,
  options: {
    now?: () => number
    onRefreshError?: (error: unknown) => void
    ttlMs?: number
  } = {},
): RedirectResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? REDIRECT_CACHE_TTL_MS
  let cached: { expiresAt: number; index: ReadonlyMap<string, string> } | undefined
  let refreshing: Promise<ReadonlyMap<string, string>> | undefined

  const refresh = (): Promise<ReadonlyMap<string, string>> => {
    if (refreshing) return refreshing
    refreshing = load()
      .then((index) => {
        cached = { expiresAt: now() + ttlMs, index }
        return index
      })
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }

  return {
    async resolve(path) {
      if (cached && cached.expiresAt > now()) return cached.index.get(path)
      if (cached) {
        try {
          return (await refresh()).get(path)
        } catch (error) {
          options.onRefreshError?.(error)
          return cached.index.get(path)
        }
      }
      try {
        return (await refresh()).get(path)
      } catch (error) {
        options.onRefreshError?.(error)
        return undefined
      }
    },
  }
}

export async function loadRedirectIndex(
  payload: Pick<Payload, 'find'>,
): Promise<ReadonlyMap<string, string>> {
  const documents: RedirectDocument[] = []
  let page = 1
  let hasNextPage = true

  while (hasNextPage) {
    const result = await payload.find({
      collection: 'redirects',
      depth: 0,
      limit: REDIRECT_PAGE_SIZE,
      overrideAccess: false,
      page,
      sort: 'from',
    })
    documents.push(...(result.docs as RedirectDocument[]))
    hasNextPage = result.hasNextPage
    page += 1
  }

  const built = buildRedirectIndex(await hydrateRedirectReferences(payload, documents))
  if (built.invalidRules) {
    logger.warn({
      invalidRules: built.invalidRules,
      msg: 'Ignored invalid public redirect rules',
    })
  }
  return built.destinations
}

const resolver = createRedirectResolver(
  async () => loadRedirectIndex(await getPayload({ config })),
  {
    onRefreshError: (error) =>
      logger.warn({
        errorName: error instanceof Error ? error.name : 'UnknownError',
        msg: 'Redirect cache refresh failed; using stale data or passing through',
      }),
  },
)

export const resolvePublicRedirect = resolver.resolve
