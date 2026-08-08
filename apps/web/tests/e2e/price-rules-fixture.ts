import { getFixturePayload } from './redirect-fixture'

const fixedTlds = ['com', 'cn', 'net', 'org', 'top'] as const
const percentageTlds = ['xyz', 'vip', 'cc', 'com.cn'] as const

export async function createPriceRulesFixture() {
  const payload = await getFixturePayload()
  for (const tld of [...fixedTlds, ...percentageTlds]) {
    const existing = await payload.find({
      collection: 'priceRules',
      limit: 1,
      overrideAccess: true,
      where: { tld: { equals: tld } },
    })
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
    if (existing.docs[0]) {
      await payload.update({
        collection: 'priceRules',
        context: { skipPriceRuleAudit: true },
        data,
        id: existing.docs[0].id,
        overrideAccess: true,
      })
    } else {
      await payload.create({
        collection: 'priceRules',
        context: { skipPriceRuleAudit: true },
        data,
        overrideAccess: true,
      })
    }
  }
}
