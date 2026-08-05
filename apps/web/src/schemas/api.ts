import { z } from 'zod'

import { REQUEST_ID_PATTERN } from '@/lib/request-id'

export const traceIdSchema = z.string().regex(REQUEST_ID_PATTERN)
export const PROBLEM_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/

export const problemDetailsSchema = z
  .object({
    action: z.string().min(1),
    code: z.string().regex(PROBLEM_CODE_PATTERN),
    dataSource: z.string().min(1).optional(),
    detail: z.string().min(1),
    lastSuccessfulAt: z.iso.datetime().optional(),
    message: z.string().min(1),
    observedAt: z.iso.datetime().optional(),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().positive().optional(),
    status: z.number().int().min(400).max(599),
    title: z.string().min(1),
    traceId: traceIdSchema,
    type: z.string().regex(/^urn:wanmi:problem:[A-Z][A-Z0-9_]*$/),
  })
  .refine((problem) => problem.message === problem.detail, {
    message: 'message must remain compatible with detail',
    path: ['message'],
  })
  .refine((problem) => problem.type === `urn:wanmi:problem:${problem.code}`, {
    message: 'type must identify code',
    path: ['type'],
  })

export type ProblemDetails = z.infer<typeof problemDetailsSchema>

export const resultCacheStatusSchema = z.enum(['hit', 'miss', 'mixed', 'not_used'])

export const resultMetaSchema = z.object({
  cacheStatus: resultCacheStatusSchema.optional(),
  dataSource: z.string().min(1).optional(),
  lastSuccessfulAt: z.iso.datetime().optional(),
  observedAt: z.iso.datetime().optional(),
  stale: z.boolean().optional(),
  traceId: traceIdSchema.optional(),
})

export type ResultMeta = z.infer<typeof resultMetaSchema>

export type Result<T> =
  | { data: T; meta?: ResultMeta; state: 'empty' | 'ready' }
  | { data: T; meta?: ResultMeta; problem: ProblemDetails; state: 'degraded' | 'partial' }
  | { meta?: ResultMeta; problem: ProblemDetails; state: 'error' | 'rate_limited' }

export function createResultSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  const dataResult = z.object({ data: dataSchema, meta: resultMetaSchema.optional() })
  const problemResult = z.object({
    meta: resultMetaSchema.optional(),
    problem: problemDetailsSchema,
  })

  return z.discriminatedUnion('state', [
    dataResult.extend({ state: z.literal('ready') }),
    dataResult.extend({ state: z.literal('empty') }),
    dataResult.extend({ problem: problemDetailsSchema, state: z.literal('partial') }),
    dataResult.extend({ problem: problemDetailsSchema, state: z.literal('degraded') }),
    problemResult.extend({ state: z.literal('error') }),
    problemResult.extend({ state: z.literal('rate_limited') }),
  ])
}
