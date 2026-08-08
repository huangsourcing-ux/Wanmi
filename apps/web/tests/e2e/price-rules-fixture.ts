import { findOrCreateUniqueFixture } from '../test-cleanup'
import { getFixturePayload } from './redirect-fixture'

const fixedTlds = ['com', 'cn', 'net', 'org', 'top'] as const
const percentageTlds = ['xyz', 'vip', 'cc', 'com.cn'] as const

export async function createPriceRulesFixture() {
  const payload = await getFixturePayload()
  for (const tld of [...fixedTlds, ...percentageTlds]) {
    const data = fixedTlds.includes(tld as (typeof fixedTlds)[number])
      ? {
          effectiveAt: new Date().toISOString(),
          enabled: true,
          fixedAmountMinor: 500,
          mode: 'fixed' as const,
          percentageBasisPoints: null,
          tld,
        }
      : {
          effectiveAt: new Date().toISOString(),
          enabled: true,
          fixedAmountMinor: null,
          mode: 'percentage' as const,
          percentageBasisPoints: 1_000,
          tld,
        }
    const ensured = await findOrCreateUniqueFixture({
      create: () =>
        payload.create({
          collection: 'priceRules',
          context: { skipPriceRuleAudit: true },
          data,
          overrideAccess: true,
        }),
      find: async () => {
        const existing = await payload.find({
          collection: 'priceRules',
          limit: 1,
          overrideAccess: true,
          where: { tld: { equals: tld } },
        })
        return existing.docs[0]
      },
      path: 'tld',
      tableName: 'price_rules',
    })
    if (!ensured.created) {
      await payload.update({
        collection: 'priceRules',
        context: { skipPriceRuleAudit: true },
        data,
        id: ensured.value.id,
        overrideAccess: true,
      })
    }
  }
}
