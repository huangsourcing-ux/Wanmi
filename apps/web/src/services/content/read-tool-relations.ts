import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import { PUBLIC_TOOL_DEFINITIONS, type PublicToolSlug } from '@/lib/site-config'

import { PUBLIC_CONTENT_RELATIONS_CONTEXT, contentPublicPath } from './types'
import type { PublicRelatedItem } from './read-content'

export type PublicToolRelations = {
  content: PublicRelatedItem[]
  tldPages: PublicRelatedItem[]
}

const EMPTY_TOOL_RELATIONS: PublicToolRelations = { content: [], tldPages: [] }
export const TOOL_RELATIONS_CACHE_TTL_MS = 30_000
export const TOOL_RELATIONS_SCAN_LIMIT = 200

type RelationValue = number | string | { id: number | string }
type RelatedDocument = {
  id: number | string
  relatedTools?: RelationValue[] | null
  slug: string
  summary?: null | string
  title: string
}
type ToolRelationDirectory = Record<PublicToolSlug, PublicToolRelations>

function relationIds(values: RelationValue[] | null | undefined): Array<number | string> {
  return (values ?? []).flatMap((value) => {
    if (typeof value === 'number' || typeof value === 'string') return [value]
    return typeof value.id === 'number' || typeof value.id === 'string' ? [value.id] : []
  })
}

function emptyDirectory(): ToolRelationDirectory {
  return PUBLIC_TOOL_DEFINITIONS.reduce((directory, tool) => {
    directory[tool.slug] = { content: [], tldPages: [] }
    return directory
  }, {} as ToolRelationDirectory)
}

async function readPublicToolRelationDirectory(payload: Payload): Promise<ToolRelationDirectory> {
  const directory = emptyDirectory()
  try {
    const tools = await payload.find({
      collection: 'toolPages',
      depth: 0,
      limit: PUBLIC_TOOL_DEFINITIONS.length,
      overrideAccess: false,
    })
    const toolsById = new Map(tools.docs.map((tool) => [String(tool.id), tool.slug]))
    const collections = ['articles', 'topics', 'helpPages', 'tldPages'] as const
    const results = await Promise.allSettled(
      collections.map((collection) =>
        payload.find({
          collection,
          context: { [PUBLIC_CONTENT_RELATIONS_CONTEXT]: true },
          depth: 0,
          draft: false,
          limit: TOOL_RELATIONS_SCAN_LIMIT,
          overrideAccess: false,
          sort: '-updatedAt',
          where: {
            and: [
              { relatedTools: { exists: true } },
              { _status: { equals: 'published' } },
              { workflowStatus: { equals: 'published' } },
            ],
          },
        }),
      ),
    )

    results.forEach((result, index) => {
      if (result.status === 'rejected') return
      const collection = collections[index] as (typeof collections)[number]
      const perTool = new Map<PublicToolSlug, PublicRelatedItem[]>()
      for (const document of result.value.docs as RelatedDocument[]) {
        const item = {
          description: document.summary?.trim() || undefined,
          href: contentPublicPath(collection, document.slug),
          id: `${collection}:${document.id}`,
          title: document.title,
        }
        for (const toolId of relationIds(document.relatedTools)) {
          const slug = toolsById.get(String(toolId))
          if (!slug || !PUBLIC_TOOL_DEFINITIONS.some((tool) => tool.slug === slug)) continue
          const toolSlug = slug as PublicToolSlug
          const items = perTool.get(toolSlug) ?? []
          if (items.length < 12) items.push(item)
          perTool.set(toolSlug, items)
        }
      }
      for (const [slug, items] of perTool) {
        if (collection === 'tldPages') directory[slug].tldPages.push(...items)
        else directory[slug].content.push(...items)
      }
    })
    return directory
  } catch {
    return directory
  }
}

export async function readPublicToolRelations(
  payload: Payload,
  slug: PublicToolSlug,
): Promise<PublicToolRelations> {
  return (await readPublicToolRelationDirectory(payload))[slug] ?? EMPTY_TOOL_RELATIONS
}

let cachedDirectory:
  | { expiresAt: number; value: ToolRelationDirectory }
  | undefined
let refreshingDirectory: Promise<ToolRelationDirectory> | undefined

export async function readCachedPublicToolRelations(
  slug: PublicToolSlug,
): Promise<PublicToolRelations> {
  if (cachedDirectory && cachedDirectory.expiresAt > Date.now()) {
    return cachedDirectory.value[slug] ?? EMPTY_TOOL_RELATIONS
  }
  if (!refreshingDirectory) {
    refreshingDirectory = getPayload({ config })
      .then(readPublicToolRelationDirectory)
      .then((value) => {
        cachedDirectory = { expiresAt: Date.now() + TOOL_RELATIONS_CACHE_TTL_MS, value }
        return value
      })
      .finally(() => {
        refreshingDirectory = undefined
      })
  }
  return (await refreshingDirectory)[slug] ?? EMPTY_TOOL_RELATIONS
}
