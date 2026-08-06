import { describe, expect, it } from 'vitest'

import { POST } from '@/app/api/v1/tools/idn/route'
import { AppError, toProblemDetails } from '@/lib/errors'
import {
  idnConversionDataSchema,
  idnConversionResultSchema,
  type IdnConversionData,
} from '@/schemas/idn'

const traceId = 'trace-idn-route-test'

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/tools/idn', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

const data: IdnConversionData = idnConversionDataSchema.parse({
  ascii: 'xn--fsqu00a.xn--fiqs8s',
  display: 'xn--fsqu00a.xn--fiqs8s',
  risks: [],
  unicode: '例子.中国',
})

describe('POST /api/v1/tools/idn', () => {
  it('returns a schema-validated no-store conversion with a request ID', async () => {
    const response = await POST(
      request(JSON.stringify({ query: '例子.中国' }), { 'x-request-id': traceId }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBe(traceId)
    expect(idnConversionResultSchema.parse(await response.json())).toEqual({
      data,
      state: 'ready',
    })
  })

  it('converts Punycode to Unicode and exposes concrete mixed-script warnings', async () => {
    const punycode = await POST(request(JSON.stringify({ query: 'xn--fsqu00a.xn--fiqs8s' })))
    expect(await punycode.json()).toMatchObject({ data: { unicode: '例子.中国' }, state: 'ready' })

    const mixed = await POST(request(JSON.stringify({ query: 'раypal.com' })))
    expect(await mixed.json()).toMatchObject({
      data: {
        display: expect.stringMatching(/^xn--/u),
        risks: [
          {
            code: 'DOMAIN_MIXED_SCRIPT_RISK',
            labelAscii: expect.stringMatching(/^xn--/u),
            message: expect.stringMatching(
              /西里尔文（Cyrillic）.*拉丁文（Latin）.*不代表可注册或商标安全/u,
            ),
            scripts: ['Cyrillic', 'Latin'],
          },
        ],
      },
      state: 'ready',
    })
  })

  it('returns semantic domain failures inside the six-state Result contract', async () => {
    const response = await POST(request(JSON.stringify({ query: 'wanmi..com' })))
    expect(response.status).toBe(200)
    expect(idnConversionResultSchema.parse(await response.json())).toMatchObject({
      problem: {
        code: 'DOMAIN_EMPTY_LABEL',
        detail: '第 2 个标签为空',
        retryable: false,
        status: 400,
      },
      state: 'error',
    })
  })

  it('keeps all six shared states representable', () => {
    const problem = toProblemDetails(new AppError('IDN_TEST_STATE', '测试状态', 503), traceId)
    for (const state of ['ready', 'empty'] as const) {
      expect(idnConversionResultSchema.parse({ data, state }).state).toBe(state)
    }
    for (const state of ['partial', 'degraded'] as const) {
      expect(idnConversionResultSchema.parse({ data, problem, state }).state).toBe(state)
    }
    for (const state of ['error', 'rate_limited'] as const) {
      expect(idnConversionResultSchema.parse({ problem, state }).state).toBe(state)
    }
  })

  it('rejects malformed, non-JSON, unknown, missing and oversized requests', async () => {
    const malformed = await POST(request('{'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_REQUEST')

    const media = await POST(request('{}', { 'content-type': 'text/plain' }))
    expect(media.status).toBe(415)
    expect((await media.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')

    const unknown = await POST(request(JSON.stringify({ query: 'wanmi.net', unexpected: true })))
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).code).toBe('INVALID_REQUEST')

    const missing = await POST(request('{}'))
    expect(missing.status).toBe(400)
    expect((await missing.json()).code).toBe('INVALID_REQUEST')

    const oversized = await POST(request('{}', { 'content-length': '4097' }))
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).code).toBe('IDN_REQUEST_TOO_LARGE')

    const streamedOversized = await POST(request(JSON.stringify({ query: 'a'.repeat(4_097) })))
    expect(streamedOversized.status).toBe(413)
    expect((await streamedOversized.json()).code).toBe('IDN_REQUEST_TOO_LARGE')

    const inputTooLong = await POST(request(JSON.stringify({ query: 'a'.repeat(1_025) })))
    expect(inputTooLong.status).toBe(400)
    expect((await inputTooLong.json()).code).toBe('INVALID_REQUEST')
  })
})
