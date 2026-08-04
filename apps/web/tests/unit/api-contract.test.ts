import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { AppError, problemResponse, readProblemResponse, toProblemDetails } from '@/lib/errors'
import { getTraceId, isValidTraceId } from '@/lib/request-id'
import { providerResultToResult } from '@/lib/results'
import { createResultSchema, problemDetailsSchema } from '@/schemas/api'

const traceId = 'test-trace-d1-02'

describe('D1 API result and problem contract', () => {
  it('returns a backwards-compatible RFC 9457 problem with retry metadata', async () => {
    const response = problemResponse(
      new AppError('AUTH_RATE_LIMITED', '请求过于频繁，请稍后再试', 429, {
        action: '请在一分钟后重试',
        retryAfterSeconds: 60,
        retryable: true,
        title: '验证码请求过于频繁',
      }),
      traceId,
    )

    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toBe('application/problem+json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('retry-after')).toBe('60')
    expect(response.headers.get('x-request-id')).toBe(traceId)
    const body = await response.json()
    expect(problemDetailsSchema.parse(body)).toMatchObject({
      action: '请在一分钟后重试',
      code: 'AUTH_RATE_LIMITED',
      detail: '请求过于频繁，请稍后再试',
      message: '请求过于频繁，请稍后再试',
      retryable: true,
      status: 429,
      traceId,
      type: 'urn:wanmi:problem:AUTH_RATE_LIMITED',
    })
    expect(body.stack).toBeUndefined()
  })

  it('sanitizes unknown and validation failures without leaking original messages', async () => {
    const unknown = await problemResponse(
      new Error('database password and stack must never leave the server'),
      traceId,
    ).json()
    expect(unknown).toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: '服务暂时不可用',
      message: '服务暂时不可用',
      status: 500,
    })
    expect(JSON.stringify(unknown)).not.toContain('database password')

    let validationError: unknown
    try {
      z.object({ phone: z.string().min(11) }).parse({ phone: 'short' })
    } catch (error) {
      validationError = error
    }
    expect(toProblemDetails(validationError, traceId)).toMatchObject({
      code: 'INVALID_REQUEST',
      detail: '请求参数无效',
      status: 400,
    })

    const invalidInternalError = toProblemDetails(
      new AppError('invalid-code', 'should not escape', 400),
      'bad',
    )
    expect(invalidInternalError).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 })
    expect(invalidInternalError.detail).not.toContain('should not escape')
    expect(isValidTraceId(invalidInternalError.traceId)).toBe(true)

    const invalidMetadata = toProblemDetails(
      new AppError('BROKEN_METADATA', 'must also stay private', 503, {
        observedAt: 'not-an-iso-date',
      }),
      traceId,
    )
    expect(invalidMetadata).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 })
    expect(invalidMetadata.detail).not.toContain('must also stay private')
  })

  it('parses valid problems and safely falls back when an error body is malformed', async () => {
    const validResponse = problemResponse(new AppError('CONFLICT', '状态冲突', 409), traceId)
    await expect(readProblemResponse(validResponse)).resolves.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      traceId,
    })

    const malformed = new Response('{"stack":"secret"}', {
      headers: { 'content-type': 'application/json', 'x-request-id': traceId },
      status: 503,
    })
    await expect(readProblemResponse(malformed)).resolves.toMatchObject({
      code: 'HTTP_503',
      detail: '服务暂时不可用',
      status: 503,
      traceId,
    })
  })

  it('accepts only bounded request IDs and replaces invalid external values', () => {
    expect(getTraceId(new Headers({ 'x-request-id': traceId }))).toBe(traceId)
    const replacement = getTraceId(new Headers({ 'x-request-id': 'short' }))
    expect(replacement).not.toBe('short')
    expect(isValidTraceId(replacement)).toBe(true)
  })

  it('validates every Result state and maps provider failures without exposing raw messages', () => {
    const dataSchema = z.array(z.string())
    const schema = createResultSchema(dataSchema)
    const problem = toProblemDetails(new AppError('SOURCE_FAILED', '安全说明', 503), traceId)

    for (const candidate of [
      { data: ['ok'], state: 'ready' },
      { data: [], state: 'empty' },
      { data: ['ok'], problem, state: 'partial' },
      { data: ['cached'], problem, state: 'degraded' },
      { problem, state: 'error' },
      { problem: { ...problem, status: 429 }, state: 'rate_limited' },
    ]) {
      expect(schema.safeParse(candidate).success, candidate.state).toBe(true)
    }

    const providerFailure = {
      error: {
        code: 'WHODAT_UNAVAILABLE',
        message: 'raw provider response must stay private',
        retryable: true,
        statusKnown: false,
      },
      observedAt: '2026-08-04T12:00:00.000Z',
      ok: false as const,
      requestId: 'provider-private-id',
    }
    const degraded = providerResultToResult(providerFailure, {
      dataSource: 'Who-Dat',
      fallbackData: ['cached'],
      lastSuccessfulAt: '2026-08-04T11:00:00.000Z',
      traceId,
    })
    expect(degraded).toMatchObject({
      data: ['cached'],
      meta: { dataSource: 'Who-Dat', stale: true, traceId },
      problem: { code: 'WHODAT_UNAVAILABLE', dataSource: 'Who-Dat' },
      state: 'degraded',
    })
    expect(JSON.stringify(degraded)).not.toContain('raw provider response')
    expect(JSON.stringify(degraded)).not.toContain('provider-private-id')
  })
})
