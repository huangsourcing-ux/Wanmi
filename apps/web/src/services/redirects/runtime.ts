import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import { buildRedirectIndex, type RedirectDocument } from '@/lib/redirects'
import { logger } from '@/lib/logging'

export const REDIRECT_CACHE_TTL_MS = 30_000
const REDIRECT_PAGE_SIZE = 200

type RedirectLoader = () => Promise<ReadonlyMap<string, string>>

export type RedirectResolver = {
  resolve(path: string): Promise<string | undefined>
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
      depth: 1,
      limit: REDIRECT_PAGE_SIZE,
      overrideAccess: false,
      page,
      sort: 'from',
    })
    documents.push(...(result.docs as RedirectDocument[]))
    hasNextPage = result.hasNextPage
    page += 1
  }

  const built = buildRedirectIndex(documents)
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
