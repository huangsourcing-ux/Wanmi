import { describe, expect, it } from 'vitest'

import { parsePublicContentPath } from '@/services/content/publication-gate'

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
})
