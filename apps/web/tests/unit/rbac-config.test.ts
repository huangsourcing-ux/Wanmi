import type { Access, CollectionConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import { collections } from '@/collections'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
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
    operationalScopes: ['funds_operations', 'system_configuration'],
    roles: ['system_admin'],
    status: 'active',
  },
}

const publicReads = [
  'adCreatives',
  'adMedia',
  'adPlacements',
  'adSchedules',
  'advertisers',
  'articles',
  'helpPages',
  'media',
  'navigation',
  'siteSettings',
  'tldPages',
  'toolPages',
  'topics',
]
const customerReads = [
  ...publicReads,
  'accountClosureRequests',
  'automaticRenewalEvents',
  'consentRecords',
  'customerIdentities',
  'customerSecurityEvents',
  'customers',
  'dnsRecordChanges',
  'domainAssetSyncEvents',
  'domainAssets',
  'domainBatchOperationEvents',
  'domainExpiryReminders',
  'domainManagementEvents',
  'invitationRelationships',
  'invitationRewardClaims',
  'invitationRewardEvents',
  'nameserverChanges',
  'notificationMarketingPreferences',
  'notificationOutboxEvents',
  'notificationReadStates',
  'orderEvents',
  'orders',
  'pointsAccounts',
  'pointsBatches',
  'pointsConsumptionAllocations',
  'pointsLedger',
  'pointsRedemptions',
  'quotes',
  'realnameDocuments',
  'realnameTemplates',
  'renewalMandates',
  'renewals',
  'toolQuotaLedger',
  'vipSpendEntries',
  'vipTierAppeals',
  'vipTierEvents',
  'walletAccounts',
  'walletEntries',
  'walletTopUpOrders',
  'walletTransactions',
]
const contentWrites = [
  'articles',
  'categories',
  'helpPages',
  'media',
  'navigation',
  'tags',
  'tldPages',
  'topics',
]
const advertisingWrites = ['adCreatives', 'adMedia', 'adPlacements', 'adSchedules', 'advertisers']
const operationalReads = [...publicReads, 'admins', 'reconciliations', 'userFeedback']
const analyticalReads = [...operationalReads, 'toolObservabilityBuckets']
const contentAdminCollections = [
  'articles',
  'categories',
  'helpPages',
  'media',
  'navigation',
  'tags',
  'tldPages',
  'toolPages',
  'topics',
]
const advertisingAdminCollections = [
  'adCreatives',
  'adMedia',
  'adPlacements',
  'adSchedules',
  'advertisers',
  'reconciliations',
  'userFeedback',
]
const analyticalAdminCollections = [...advertisingAdminCollections, 'toolObservabilityBuckets']
const alwaysHiddenCollections = [
  'adminInvitations',
  'adminMfaCredentials',
  'customerRegistrationIntents',
  'customerSessions',
  'notificationDeliveries',
  'notificationMarketingPreferences',
  'notificationReadStates',
  'realnameDocuments',
  'smsChallenges',
  'smsRateLimits',
  'stepUpGrants',
  'wechatAuthorizationCodes',
  'wechatLoginScenes',
  'wechatOAuthStates',
]

const systemUnreadableCollections = [
  'adminInvitations',
  'adminMfaCredentials',
  'customerRegistrationIntents',
  'notificationDeliveries',
  'stepUpGrants',
  'wechatAuthorizationCodes',
  'wechatLoginScenes',
  'wechatOAuthStates',
]

const expected: Record<Persona, Record<Operation, string[]>> = {
  anonymous: { create: [], delete: [], read: publicReads, readVersions: [], update: [] },
  customer: { create: [], delete: [], read: customerReads, readVersions: [], update: [] },
  content_editor: {
    create: contentWrites,
    delete: [],
    read: [...publicReads, 'admins', 'categories', 'tags'],
    readVersions: ['articles', 'helpPages', 'tldPages', 'topics'],
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
    read: analyticalReads,
    readVersions: [],
    update: ['admins'],
  },
  system_admin: {
    create: [...advertisingWrites, ...contentWrites, 'priceRules', 'siteSettings'],
    delete: [...advertisingWrites, ...contentWrites, 'admins', 'priceRules', 'siteSettings'],
    read: collections
      .map(({ slug }) => slug)
      .filter((slug) => !systemUnreadableCollections.includes(slug)),
    readVersions: ['articles', 'helpPages', 'tldPages', 'topics'],
    update: [
      ...advertisingWrites,
      ...contentWrites,
      'admins',
      'priceRules',
      'siteSettings',
      'userFeedback',
    ],
  },
  disabled_admin: { create: [], delete: [], read: publicReads, readVersions: [], update: [] },
}

const expectedVisible: Record<Persona, string[]> = {
  anonymous: [],
  customer: [],
  content_editor: contentAdminCollections,
  ad_operator: [...advertisingAdminCollections, 'auditLogs'],
  analyst: analyticalAdminCollections,
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
      const operationalRole = ['ad_operator', 'analyst', 'system_admin'].includes(persona)
      const systemRole = persona === 'system_admin'
      expect(operations).toEqual({
        create: sorted(contentRole ? ['forms', 'redirects'] : []),
        delete: systemRole ? ['forms', 'redirects'] : [],
        read: sorted([
          ...(contentRole ? ['forms'] : []),
          'redirects',
          ...(operationalRole ? ['form-submissions'] : []),
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
          ...(operationalRole ? ['form-submissions'] : []),
        ]),
      )
    },
  )
})

describe('D1 administrator navigation groups', () => {
  const expectedGroups: Record<string, string> = {
    adCreatives: ADMIN_GROUPS.advertising,
    adMedia: ADMIN_GROUPS.advertising,
    adPlacements: ADMIN_GROUPS.advertising,
    adSchedules: ADMIN_GROUPS.advertising,
    adminAccessEvents: ADMIN_GROUPS.operations,
    adminApprovalRequests: ADMIN_GROUPS.operations,
    adminInvitations: ADMIN_GROUPS.identity,
    adminMfaCredentials: ADMIN_GROUPS.identity,
    admins: ADMIN_GROUPS.identity,
    advertisers: ADMIN_GROUPS.advertising,
    articles: ADMIN_GROUPS.content,
    automaticRenewalEvents: ADMIN_GROUPS.fulfillment,
    categories: ADMIN_GROUPS.content,
    auditLogs: ADMIN_GROUPS.operations,
    accountClosureRequests: ADMIN_GROUPS.identity,
    accountRecoveryRecords: ADMIN_GROUPS.identity,
    consentRecords: ADMIN_GROUPS.identity,
    customerIdentities: ADMIN_GROUPS.identity,
    customerRegistrationIntents: ADMIN_GROUPS.identity,
    customerSecurityEvents: ADMIN_GROUPS.operations,
    customerSessions: ADMIN_GROUPS.identity,
    customers: ADMIN_GROUPS.identity,
    dnsRecordChanges: ADMIN_GROUPS.fulfillment,
    domainAssetSyncEvents: ADMIN_GROUPS.fulfillment,
    domainAssets: ADMIN_GROUPS.fulfillment,
    domainBatchOperationEvents: ADMIN_GROUPS.fulfillment,
    domainExpiryReminders: ADMIN_GROUPS.fulfillment,
    domainManagementEvents: ADMIN_GROUPS.fulfillment,
    firstPartyEvents: ADMIN_GROUPS.operations,
    helpPages: ADMIN_GROUPS.content,
    invitationRelationships: ADMIN_GROUPS.operations,
    invitationRewardClaims: ADMIN_GROUPS.operations,
    invitationRewardEvents: ADMIN_GROUPS.operations,
    invitationRewardRuleVersions: ADMIN_GROUPS.operations,
    manualReviews: ADMIN_GROUPS.operations,
    media: ADMIN_GROUPS.content,
    nameserverChanges: ADMIN_GROUPS.fulfillment,
    navigation: ADMIN_GROUPS.content,
    notificationDeliveries: ADMIN_GROUPS.operations,
    notificationMarketingPreferences: ADMIN_GROUPS.operations,
    notificationOutboxEvents: ADMIN_GROUPS.operations,
    notificationProviderReceipts: ADMIN_GROUPS.operations,
    notificationReadStates: ADMIN_GROUPS.operations,
    orderEvents: ADMIN_GROUPS.commerce,
    orderManualActions: ADMIN_GROUPS.commerce,
    orders: ADMIN_GROUPS.commerce,
    paymentNotificationArchives: ADMIN_GROUPS.commerce,
    paymentNotifications: ADMIN_GROUPS.commerce,
    pointsAccounts: ADMIN_GROUPS.commerce,
    pointsBatches: ADMIN_GROUPS.commerce,
    pointsConsumptionAllocations: ADMIN_GROUPS.commerce,
    pointsLedger: ADMIN_GROUPS.commerce,
    pointsRedemptions: ADMIN_GROUPS.commerce,
    priceRules: ADMIN_GROUPS.commerce,
    priceSnapshots: ADMIN_GROUPS.commerce,
    providerOperations: ADMIN_GROUPS.fulfillment,
    providerWriteBudgetDebits: ADMIN_GROUPS.fulfillment,
    providerWriteBudgets: ADMIN_GROUPS.fulfillment,
    quotes: ADMIN_GROUPS.commerce,
    realnameDocuments: ADMIN_GROUPS.realname,
    realnameTemplates: ADMIN_GROUPS.realname,
    reconciliations: ADMIN_GROUPS.operations,
    refundNotifications: ADMIN_GROUPS.commerce,
    refunds: ADMIN_GROUPS.commerce,
    renewalMandates: ADMIN_GROUPS.fulfillment,
    renewals: ADMIN_GROUPS.fulfillment,
    siteSettings: ADMIN_GROUPS.content,
    smsChallenges: ADMIN_GROUPS.identity,
    smsRateLimits: ADMIN_GROUPS.identity,
    stepUpGrants: ADMIN_GROUPS.identity,
    tags: ADMIN_GROUPS.content,
    tldPages: ADMIN_GROUPS.content,
    toolPages: ADMIN_GROUPS.content,
    toolQuotaLedger: ADMIN_GROUPS.commerce,
    topics: ADMIN_GROUPS.content,
    toolObservabilityBuckets: ADMIN_GROUPS.operations,
    userFeedback: ADMIN_GROUPS.operations,
    vipSpendEntries: ADMIN_GROUPS.operations,
    vipTierAppeals: ADMIN_GROUPS.operations,
    vipTierEvents: ADMIN_GROUPS.operations,
    vipTierRuleLevels: ADMIN_GROUPS.operations,
    vipTierRuleVersions: ADMIN_GROUPS.operations,
    walletAccounts: ADMIN_GROUPS.commerce,
    walletEntries: ADMIN_GROUPS.commerce,
    walletPolicyVersions: ADMIN_GROUPS.commerce,
    walletTopUpOrders: ADMIN_GROUPS.commerce,
    walletTransactions: ADMIN_GROUPS.commerce,
    wechatAuthorizationCodes: ADMIN_GROUPS.identity,
    wechatLoginScenes: ADMIN_GROUPS.identity,
    wechatOAuthStates: ADMIN_GROUPS.identity,
  }

  it('assigns every core and plugin collection to its frozen domain', () => {
    expect(
      Object.fromEntries(
        collections.map((collection) => [collection.slug, collection.admin?.group]),
      ),
    ).toEqual(expectedGroups)
    expect(redirectsOverrides.admin.group).toBe(ADMIN_GROUPS.content)
    expect(formOverrides.admin.group).toBe(ADMIN_GROUPS.content)
    expect(formSubmissionOverrides.admin.group).toBe(ADMIN_GROUPS.operations)
  })

  it.each([
    ['content_editor', [ADMIN_GROUPS.content]],
    ['ad_operator', [ADMIN_GROUPS.advertising, ADMIN_GROUPS.operations]],
    ['analyst', [ADMIN_GROUPS.advertising, ADMIN_GROUPS.operations]],
    ['system_admin', Object.values(ADMIN_GROUPS)],
  ] as const)('shows only authorized groups to %s', (persona, expected) => {
    const visibleGroups = new Set(
      collections
        .filter((collection) => visibleInAdmin(collection, personas[persona]))
        .map((collection) => collection.admin?.group as string),
    )
    expect([...visibleGroups].sort()).toEqual([...expected].sort())
  })

  it('shows the union of groups for a multi-role administrator', () => {
    const user = {
      collection: 'admins',
      id: 20,
      roles: ['content_editor', 'ad_operator'],
      status: 'active',
    }
    const visibleGroups = new Set(
      collections
        .filter((collection) => visibleInAdmin(collection, user))
        .map((collection) => collection.admin?.group as string),
    )
    expect([...visibleGroups].sort()).toEqual(
      [ADMIN_GROUPS.advertising, ADMIN_GROUPS.content, ADMIN_GROUPS.operations].sort(),
    )
  })
})
