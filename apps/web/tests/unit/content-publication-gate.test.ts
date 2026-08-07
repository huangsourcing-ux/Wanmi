import { describe, expect, it } from 'vitest'

import {
  parsePublicContentPath,
  parsePublicTaxonomyPath,
} from '@/services/content/publication-gate'

describe('D3 public content publication gate', () => {
  it.each([
    ['/articles/how-to', 'articles'],
    ['/topics/domain-basics', 'topics'],
    ['/tld/com', 'tldPages'],
    ['/help/account', 'helpPages'],
  ] as const)('maps %s to %s', (pathname, collection) => {
    expect(parsePublicContentPath(pathname)).toEqual({
      collection,
      slug: pathname.slice(pathname.lastIndexOf('/') + 1),
    })
  })

  it.each([
    '/articles',
    '/articles/a/b',
    '/preview/content/articles/draft',
    '/articles/%2Fadmin',
    '/articles/%5Cadmin',
    '/orders/example',
  ])('does not treat %s as a public content detail', (pathname) => {
    expect(parsePublicContentPath(pathname)).toBeUndefined()
  })

  it.each([
    ['/articles/category/guides', 'categories'],
    ['/articles/tag/dns', 'tags'],
  ] as const)('maps taxonomy route %s to %s', (pathname, collection) => {
    expect(parsePublicTaxonomyPath(pathname)).toEqual({
      collection,
      slug: pathname.slice(pathname.lastIndexOf('/') + 1),
    })
  })

  it.each([
    '/articles/category',
    '/articles/tag/a/b',
    '/articles/category/%2Fadmin',
    '/articles/tag/%5Cadmin',
  ])('rejects malformed taxonomy route %s', (pathname) => {
    expect(parsePublicTaxonomyPath(pathname)).toBeUndefined()
  })
})
