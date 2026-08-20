import { z } from 'zod'

const tierCode = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,31}$/u)
const note = z.string().trim().min(8).max(1_000)

export const vipTierRuleLevelInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(64),
    quotaBenefits: z.record(z.string(), z.number().int().nonnegative().safe()).default({}),
    serviceContent: z.string().trim().min(1).max(2_000),
    thresholdFen: z.number().int().positive().safe(),
    tierCode,
    tierRank: z.number().int().positive().max(100),
  })
  .strict()

export const vipTierRulePublishSchema = z
  .object({
    changeNote: note,
    effectiveAt: z.iso.datetime(),
    tiers: z.array(vipTierRuleLevelInputSchema).min(1).max(100),
  })
  .strict()

export const vipOperationalPromotionSchema = z
  .object({ customerId: z.coerce.number().int().positive(), reasonNote: note, tierCode })
  .strict()

export const vipTierAppealCreateSchema = z
  .object({ statement: note, tierEventId: z.coerce.number().int().positive() })
  .strict()

export type VipTierRuleLevelInput = z.infer<typeof vipTierRuleLevelInputSchema>
export type VipTierRulePublishInput = z.infer<typeof vipTierRulePublishSchema>
