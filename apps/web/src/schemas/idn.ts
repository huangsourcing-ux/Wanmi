import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

export const IDN_INPUT_MAX_CHARACTERS = 1_024

export const idnConversionRequestSchema = z.strictObject({
  query: z.string().max(IDN_INPUT_MAX_CHARACTERS),
})

export const idnRiskSchema = z.strictObject({
  code: z.literal('DOMAIN_MIXED_SCRIPT_RISK'),
  labelAscii: z.string().min(1).max(63),
  message: z.string().min(1),
  scripts: z.array(z.string().min(1)).min(2),
})

export const idnConversionDataSchema = z.strictObject({
  ascii: z.string().min(1).max(253),
  display: z.string().min(1).max(253),
  risks: z.array(idnRiskSchema),
  unicode: z.string().min(1),
})

export const idnConversionResultSchema = createResultSchema(idnConversionDataSchema)

export type IdnConversionRequest = z.infer<typeof idnConversionRequestSchema>
export type IdnConversionData = z.infer<typeof idnConversionDataSchema>
export type IdnConversionResult = z.infer<typeof idnConversionResultSchema>
