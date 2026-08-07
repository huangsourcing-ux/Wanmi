import { describe, expect, it, vi } from 'vitest'

import { PUBLIC_SEO_ROUTES } from '@/lib/seo'
import {
  DYNAMIC_SITEMAP_LIMIT,
  readPublicSitemap,
  SITEMAP_PAGE_SIZE,
  SITEMAP_RELATION_SCAN_LIMIT,
} from '@/services/content/sitemap'

function result(docs: Record<string, unknown>[], hasNextPage = false) {
  return { docs, hasNextPage, totalDocs: docs.length }
}

const published = (slug: string, extra: Record<string, unknown> = {}) => ({
  _status: 'published',
  meta: { noIndex: false },
  slug,
  updatedAt: '2026-08-06T00:00:00.000Z',
  workflowStatus: 'published',
  ...extra,
})

describe('D3 dynamic sitemap', () => {
  it('paginates reads and includes only published, indexable content and live taxonomies', async () => {
    let indexArticlePage = 0
    const find = vi.fn().mockImplementation((args: Record<string, unknown>) => {
      const collection = args.collection
      const where = JSON.stringify(args.where)
      if (collection === 'articles' && where.includes('meta.noIndex')) {
        indexArticlePage += 1
        return Promise.resolve(
          indexArticlePage === 1
            ? result(
                [
                  published('published-one', {
                    categories: [11],
                    meta: { canonical: '/articles/canonical-one', noIndex: false },
                    tags: [21],
                  }),
                  published('hidden-by-noindex', { meta: { noIndex: true } }),
                  { ...published('draft-leak'), _status: 'draft', workflowStatus: 'draft' },
                ],
                true,
              )
            : result([published('published-two')]),
        )
      }
      if (collection === 'articles') {
        return Promise.resolve(
          result([published('taxonomy-source', { categories: [11], tags: [21] })]),
        )
      }
      if (collection === 'categories') {
        return Promise.resolve(
          result([{ ...published('guides'), _status: undefined, workflowStatus: undefined }]),
        )
      }
      if (collection === 'tags') {
        return Promise.resolve(
          result([
            {
              ...published('private-tag', { meta: { noIndex: true } }),
              _status: undefined,
              workflowStatus: undefined,
            },
          ]),
        )
      }
      return Promise.resolve(result([]))
    })

    const entries = await readPublicSitemap({ find: find as never })
    const paths = entries.map((entry) => new URL(entry.url).pathname)

    expect(paths).not.toContain('/articles/canonical-one')
    expect(paths).not.toContain('/articles/published-one')
    expect(paths).toContain('/articles/published-two')
    expect(paths).toContain('/articles/category/guides')
    expect(paths).not.toContain('/articles/hidden-by-noindex')
    expect(paths).not.toContain('/articles/draft-leak')
    expect(paths).not.toContain('/articles/tag/private-tag')
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }))
    expect(
      find.mock.calls.every(([args]) =>
        typeof args.limit === 'number' ? args.limit <= SITEMAP_PAGE_SIZE : true,
      ),
    ).toBe(true)
  })

  it('enforces a hard dynamic entry cap and a bounded taxonomy relation scan', async () => {
    const find = vi
      .fn()
      .mockResolvedValue(
        result(
          Array.from({ length: DYNAMIC_SITEMAP_LIMIT + 1 }, (_, index) =>
            published(`bounded-${index}`),
          ),
        ),
      )
    const entries = await readPublicSitemap({ find: find as never })

    expect(entries).toHaveLength(PUBLIC_SEO_ROUTES.length + DYNAMIC_SITEMAP_LIMIT)
    expect(entries.some((entry) => entry.url.endsWith(`/bounded-${DYNAMIC_SITEMAP_LIMIT}`))).toBe(
      false,
    )
    expect(SITEMAP_RELATION_SCAN_LIMIT).toBeGreaterThanOrEqual(DYNAMIC_SITEMAP_LIMIT)
    expect(find).toHaveBeenCalledTimes(1)
  })
})
