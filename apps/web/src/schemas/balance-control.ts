import { z } from 'zod'

const tldSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,63}$/u)
const tldListSchema = z.array(tldSchema).min(1).max(100).transform((values) => [...new Set(values)].sort())

export const balanceControlSettingSchema = z
  .object({
    affectedTlds: tldListSchema,
    automaticStoppedTlds: z.array(tldSchema).max(100).transform((values) => [...new Set(values)].sort()),
    manualStoppedTlds: z.array(tldSchema).max(100).transform((values) => [...new Set(values)].sort()),
    schemaVersion: z.literal(1),
    thresholdMinor: z.number().int().nonnegative().safe(),
    updatedAt: z.iso.datetime(),
  })
  .strict()

export type BalanceControlSetting = z.infer<typeof balanceControlSettingSchema>

export const balanceControlUpdateSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('configure'),
      affectedTlds: tldListSchema,
      thresholdMinor: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_sales_stop'),
      source: z.enum(['automatic', 'manual']),
      stopped: z.boolean(),
      tld: tldSchema,
    })
    .strict(),
])

export const salesStopResolutionSchema = z
  .object({
    decision: z.enum(['refund', 'resume']),
    evidence: z
      .object({
        observedAt: z.iso.datetime(),
        reference: z.string().trim().min(3).max(256),
        source: z.enum(['provider_console', 'provider_query', 'written_confirmation']),
      })
      .strict(),
    note: z.string().trim().min(3).max(1000),
  })
  .strict()

export type SalesStopResolution = z.infer<typeof salesStopResolutionSchema>
