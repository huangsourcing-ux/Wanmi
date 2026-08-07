import { describe, expect, it, vi } from 'vitest'

import { redirectsOverrides, validateRedirect, validateSafeForm } from '@/plugins/guards'

function admin(role: 'ad_operator' | 'analyst' | 'content_editor' | 'system_admin') {
  return { collection: 'admins', id: 1, roles: [role], status: 'active' }
}

function request(
  options: {
    find?: ReturnType<typeof vi.fn>
    findByID?: ReturnType<typeof vi.fn>
  } = {},
) {
  return {
    headers: new Headers({ 'x-request-id': 'redirect-unit-trace' }),
    payload: {
      find: options.find ?? vi.fn().mockResolvedValue({ docs: [] }),
      findByID:
        options.findByID ??
        vi.fn().mockResolvedValue({
          _status: 'published',
          id: 1,
          slug: 'published',
          workflowStatus: 'published',
        }),
    },
    user: admin('content_editor'),
  }
}

describe('official plugin boundaries', () => {
  it.each([
    ['https://bad.test', /站内/],
    ['//bad.test/path', /站内/],
    ['/target?next=1', /站内/],
    ['/target#fragment', /站内/],
    ['/api/orders', /系统路径/],
    ['/target\\evil', /站内/],
  ])('rejects unsafe custom target %s', async (target, message) => {
    await expect(
      validateRedirect({
        data: { from: '/a', to: { type: 'custom', url: target }, type: '301' },
        req: request(),
      } as never),
    ).rejects.toThrow(message)
  })

  it('normalizes safe paths and rejects non-permanent and direct-loop redirects', async () => {
    const req = request()
    const data = {
      from: '/old//path/',
      to: { type: 'custom', url: '/new//path/' },
      type: '301',
    }
    await expect(validateRedirect({ data, req } as never)).resolves.toBe(data)
    expect(data).toMatchObject({ from: '/old/path', to: { url: '/new/path' } })

    await expect(
      validateRedirect({
        data: { from: '/a', to: { type: 'custom', url: '/b' }, type: '302' },
        req,
      } as never),
    ).rejects.toThrow(/301/)
    await expect(
      validateRedirect({
        data: { from: '/a', to: { type: 'custom', url: '/a' }, type: '301' },
        req,
      } as never),
    ).rejects.toThrow(/起点和终点/)
  })

  it('requires published references and derives their public path', async () => {
    const published = request({
      findByID: vi.fn().mockResolvedValue({
        _status: 'published',
        id: 7,
        slug: 'guide',
        workflowStatus: 'published',
      }),
    })
    await expect(
      validateRedirect({
        data: {
          from: '/legacy-guide',
          to: { reference: { relationTo: 'articles', value: 7 }, type: 'reference' },
          type: '301',
        },
        req: published,
      } as never),
    ).resolves.toBeTruthy()
    expect(published.payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'articles',
        overrideAccess: false,
        user: published.user,
      }),
    )

    await expect(
      validateRedirect({
        data: {
          from: '/draft-guide',
          to: { reference: { relationTo: 'articles', value: 8 }, type: 'reference' },
          type: '301',
        },
        req: request({
          findByID: vi.fn().mockResolvedValue({ _status: 'draft', id: 8, slug: 'draft' }),
        }),
      } as never),
    ).rejects.toThrow(/必须已发布/)
  })

  it('accepts only live taxonomy and fixed tool reference targets', async () => {
    const liveTaxonomyFind = vi
      .fn()
      .mockImplementation(({ collection }) =>
        Promise.resolve(
          collection === 'articles' ? { docs: [{ id: 3 }], totalDocs: 1 } : { docs: [] },
        ),
      )
    const taxonomy = request({
      find: liveTaxonomyFind,
      findByID: vi.fn().mockResolvedValue({ id: 3, slug: 'guides' }),
    })
    await expect(
      validateRedirect({
        data: {
          from: '/old-guides',
          to: { reference: { relationTo: 'categories', value: 3 }, type: 'reference' },
          type: '301',
        },
        req: taxonomy,
      } as never),
    ).resolves.toBeTruthy()
    expect(taxonomy.payload.find).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'articles', overrideAccess: false }),
    )

    const orphanTaxonomy = request({
      find: vi.fn().mockResolvedValue({ docs: [], totalDocs: 0 }),
      findByID: vi.fn().mockResolvedValue({ id: 4, slug: 'orphan' }),
    })
    await expect(
      validateRedirect({
        data: {
          from: '/old-orphan',
          to: { reference: { relationTo: 'tags', value: 4 }, type: 'reference' },
          type: '301',
        },
        req: orphanTaxonomy,
      } as never),
    ).rejects.toThrow(/至少包含一篇已发布文章/)

    await expect(
      validateRedirect({
        data: {
          from: '/legacy-whois',
          to: { reference: { relationTo: 'toolPages', value: 5 }, type: 'reference' },
          type: '301',
        },
        req: request({ findByID: vi.fn().mockResolvedValue({ id: 5, slug: 'whois' }) }),
      } as never),
    ).resolves.toBeTruthy()
  })

  it('detects indirect loops and uses access control for graph reads', async () => {
    const find = vi.fn().mockImplementation(({ where }) => {
      const serialized = JSON.stringify(where)
      if (serialized.includes('/b')) {
        return Promise.resolve({ docs: [{ from: '/b', to: { type: 'custom', url: '/a' } }] })
      }
      return Promise.resolve({ docs: [] })
    })
    const req = request({ find })
    await expect(
      validateRedirect({
        data: { from: '/a', to: { type: 'custom', url: '/b' }, type: '301' },
        req,
      } as never),
    ).rejects.toThrow(/循环/)
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ overrideAccess: false, req, user: req.user }),
    )
  })

  it('enforces the redirect role matrix', () => {
    const create = redirectsOverrides.access.create
    const remove = redirectsOverrides.access.delete
    for (const role of ['ad_operator', 'analyst'] as const) {
      expect(create({ req: { user: admin(role) } } as never)).toBe(false)
      expect(remove({ req: { user: admin(role) } } as never)).toBe(false)
    }
    expect(create({ req: { user: admin('content_editor') } } as never)).toBe(true)
    expect(remove({ req: { user: admin('content_editor') } } as never)).toBe(false)
    expect(create({ req: { user: admin('system_admin') } } as never)).toBe(true)
    expect(remove({ req: { user: admin('system_admin') } } as never)).toBe(true)
    expect(create({ req: { user: null } } as never)).toBe(false)
  })

  it('rejects payment and upload form blocks', () => {
    expect(() =>
      validateSafeForm({ data: { fields: [{ blockType: 'payment' }] } } as never),
    ).toThrow(/不允许/)
    expect(() =>
      validateSafeForm({ data: { fields: [{ blockType: 'upload' }] } } as never),
    ).toThrow(/不允许/)
  })
})
