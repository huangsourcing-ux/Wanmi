import type { CollectionConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import { Orders, Quotes } from '@/collections/commerce'
import { DomainAssets, NameserverChanges, Renewals } from '@/collections/fulfillment'
import { ConsentRecords, CustomerIdentities } from '@/collections/identity'
import { RealnameDocuments, RealnameTemplates } from '@/collections/realname'

const sensitiveCustomerCollections: CollectionConfig[] = [
  Orders,
  Quotes,
  RealnameTemplates,
  RealnameDocuments,
  DomainAssets,
  NameserverChanges,
  Renewals,
  CustomerIdentities,
  ConsentRecords,
]

const owner = { collection: 'customers', id: 'customer-owner', status: 'active' }
const attacker = { collection: 'customers', id: 'customer-attacker', status: 'active' }
const nonSystemAdmin = {
  collection: 'admins',
  id: 'content-editor',
  roles: ['content_editor'],
  status: 'active',
}

async function evaluateAccess(
  config: CollectionConfig,
  operation: 'create' | 'delete' | 'read' | 'update',
  user: unknown,
) {
  const access = config.access?.[operation]
  if (!access) throw new Error(`${config.slug}.${operation} access is not configured`)
  return access({ req: { user } } as never)
}

describe('D7 customer isolation contract', () => {
  it('scopes every sensitive customer read to the authenticated owner', async () => {
    for (const config of sensitiveCustomerCollections) {
      await expect(evaluateAccess(config, 'read', owner), config.slug).resolves.toEqual({
        customer: { equals: owner.id },
      })
      await expect(evaluateAccess(config, 'read', attacker), config.slug).resolves.toEqual({
        customer: { equals: attacker.id },
      })
      await expect(evaluateAccess(config, 'read', undefined), config.slug).resolves.toBe(false)
      await expect(evaluateAccess(config, 'read', nonSystemAdmin), config.slug).resolves.toBe(false)
    }
  })

  it('denies generic writes for customers and non-system administrators', async () => {
    for (const config of sensitiveCustomerCollections) {
      for (const operation of ['create', 'delete', 'update'] as const) {
        await expect(
          evaluateAccess(config, operation, owner),
          `${config.slug}.${operation}`,
        ).resolves.toBe(false)
        await expect(
          evaluateAccess(config, operation, attacker),
          `${config.slug}.${operation}`,
        ).resolves.toBe(false)
        await expect(
          evaluateAccess(config, operation, nonSystemAdmin),
          `${config.slug}.${operation}`,
        ).resolves.toBe(false)
      }
    }
  })
})
