import type { Access, CollectionConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import { collections } from '@/collections'
import { formOverrides, formSubmissionOverrides, redirectsOverrides } from '@/plugins/guards'

type Operation = 'create' | 'delete' | 'read' | 'readVersions' | 'update'
type Persona =
  | 'ad_operator'
  | 'analyst'
  | 'anonymous'
  | 'content_editor'
  | 'customer'
  | 'disabled_admin'
  | 'system_admin'

const personas: Record<Persona, unknown> = {
  ad_operator: {
    collection: 'admins',
    id: 12,
    roles: ['ad_operator'],
    status: 'active',
  },
  analyst: { collection: 'admins', id: 13, roles: ['analyst'], status: 'active' },
  anonymous: null,
  content_editor: {
    collection: 'admins',
    id: 11,
    roles: ['content_editor'],
    status: 'active',
  },
  customer: { collection: 'customers', id: 101 },
  disabled_admin: {
    collection: 'admins',
    id: 15,
    roles: ['content_editor', 'ad_operator', 'analyst', 'system_admin'],
    status: 'disabled',
  },
  system_admin: {
    collection: 'admins',
    id: 14,
    roles: ['system_admin'],
    status: 'active',
  },
}

const publicReads = [
  'adPlacements',
  'articles',
  'media',
  'navigation',
  'siteSettings',
  'tldPages',
  'topics',
]
const customerReads = [
  ...publicReads,
  'customerSecurityEvents',
  'customers',
  'domainAssets',
  'nameserverChanges',
  'orderEvents',
  'orders',
  'quotes',
  'realnameTemplates',
  'renewals',
]
const contentWrites = ['articles', 'media', 'navigation', 'tldPages', 'topics']
const advertisingWrites = ['adCreatives', 'adPlacements', 'adSchedules', 'advertisers']
const operationalReads = [
  ...publicReads,
  'adCreatives',
  'adSchedules',
  'admins',
  'advertisers',
  'reconciliations',
  'userFeedback',
]
const contentAdminCollections = ['articles', 'media', 'navigation', 'tldPages', 'topics']
const advertisingAdminCollections = [
  'adCreatives',
  'adPlacements',
  'adSchedules',
  'advertisers',
  'reconciliations',
  'userFeedback',
]
const alwaysHiddenCollections = [
  'adminInvitations',
  'adminMfaCredentials',
  'customerSessions',
  'realnameDocuments',
  'smsChallenges',
]

const expected: Record<Persona, Record<Operation, string[]>> = {
  anonymous: { create: [], delete: [], read: publicReads, readVersions: [], update: [] },
  customer: { create: [], delete: [], read: customerReads, readVersions: [], update: [] },
  content_editor: {
    create: contentWrites,
    delete: [],
    read: [...publicReads, 'admins'],
    readVersions: ['articles', 'tldPages', 'topics'],
    update: [...contentWrites, 'admins'],
  },
  ad_operator: {
    create: advertisingWrites,
    delete: [],
    read: [...operationalReads, 'auditLogs'],
    readVersions: [],
    update: [...advertisingWrites, 'admins'],
  },
  analyst: {
    create: [],
    delete: [],
    read: operationalReads,
    readVersions: [],
    update: ['admins'],
  },
  system_admin: {
    create: [...advertisingWrites, ...contentWrites, 'siteSettings'],
    delete: [...advertisingWrites, ...contentWrites, 'admins', 'siteSettings'],
    read: collections
      .map(({ slug }) => slug)
      .filter((slug) => !['adminInvitations', 'adminMfaCredentials'].includes(slug)),
    readVersions: ['articles', 'tldPages', 'topics'],
    update: [...advertisingWrites, ...contentWrites, 'admins', 'siteSettings', 'userFeedback'],
  },
  disabled_admin: { create: [], delete: [], read: publicReads, readVersions: [], update: [] },
}

const expectedVisible: Record<Persona, string[]> = {
  anonymous: [],
  customer: [],
  content_editor: contentAdminCollections,
  ad_operator: [...advertisingAdminCollections, 'auditLogs'],
  analyst: advertisingAdminCollections,
  system_admin: collections
    .map(({ slug }) => slug)
    .filter((slug) => !alwaysHiddenCollections.includes(slug)),
  disabled_admin: [],
}

async function accessAllowed(
  collection: CollectionConfig,
  operation: Operation,
  user: unknown,
): Promise<boolean> {
  const handler = collection.access?.[operation] as Access | undefined
  if (!handler) return false
  const result = await handler({
    data: {},
    id: 1,
    req: { user },
  } as never)
  return result !== false
}

function visibleInAdmin(collection: CollectionConfig, user: unknown): boolean {
  const hidden = collection.admin?.hidden
  if (typeof hidden === 'function') return !hidden({ user } as never)
  return hidden !== true
}

function sorted(values: string[]): string[] {
  return [...values].sort()
}

describe('D1 collection permission matrix', () => {
  for (const [persona, user] of Object.entries(personas) as [Persona, unknown][]) {
    for (const operation of ['create', 'delete', 'read', 'readVersions', 'update'] as const) {
      it(`${persona} has the expected ${operation} surface across every core collection`, async () => {
        const actual: string[] = []
        for (const collection of collections) {
          if (await accessAllowed(collection, operation, user)) actual.push(collection.slug)
        }
        expect(sorted(actual)).toEqual(sorted(expected[persona][operation]))
      })
    }

    it(`${persona} sees only its allowed core collections in Payload Admin`, () => {
      const actual = collections
        .filter((collection) => visibleInAdmin(collection, user))
        .map(({ slug }) => slug)
      expect(sorted(actual)).toEqual(sorted(expectedVisible[persona]))
    })
  }
})

describe('D1 official plugin permission matrix', () => {
  const pluginCollections = [
    { ...redirectsOverrides, slug: 'redirects' },
    { ...formOverrides, slug: 'forms' },
    { ...formSubmissionOverrides, slug: 'form-submissions' },
  ] as CollectionConfig[]

  it.each(Object.entries(personas) as [Persona, unknown][])(
    'enforces plugin operations and visibility for %s',
    async (persona, user) => {
      const operations = Object.fromEntries(
        await Promise.all(
          (['create', 'delete', 'read', 'update'] as const).map(async (operation) => [
            operation,
            sorted(
              (
                await Promise.all(
                  pluginCollections.map(async (collection) => ({
                    allowed: await accessAllowed(collection, operation, user),
                    slug: collection.slug,
                  })),
                )
              )
                .filter(({ allowed }) => allowed)
                .map(({ slug }) => slug),
            ),
          ]),
        ),
      )

      const contentRole = persona === 'content_editor' || persona === 'system_admin'
      const systemRole = persona === 'system_admin'
      expect(operations).toEqual({
        create: sorted([...(contentRole ? ['forms', 'redirects'] : []), 'form-submissions']),
        delete: systemRole ? ['forms', 'redirects'] : [],
        read: sorted([
          ...(contentRole ? ['forms'] : []),
          'redirects',
          ...(systemRole ? ['form-submissions'] : []),
        ]),
        update: sorted([
          ...(contentRole ? ['forms', 'redirects'] : []),
          ...(systemRole ? ['form-submissions'] : []),
        ]),
      })

      const visible = pluginCollections
        .filter((collection) => visibleInAdmin(collection, user))
        .map(({ slug }) => slug)
      expect(sorted(visible)).toEqual(
        sorted([
          ...(contentRole ? ['forms', 'redirects'] : []),
          ...(systemRole ? ['form-submissions'] : []),
        ]),
      )
    },
  )
})
