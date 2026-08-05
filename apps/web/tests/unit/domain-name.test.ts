import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import {
  normalizeDomain,
  normalizeDomainResult,
  type DomainErrorCode,
  type NormalizedDomain,
} from '@/lib/domain-name'
import { createResultSchema, problemDetailsSchema } from '@/schemas/api'

const traceId = 'test-trace-d2-01-domain'

function expectNormalized(input: string): NormalizedDomain {
  const result = normalizeDomain(input)
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true)
  if (!result.ok) throw new Error(`Expected ${input} to normalize: ${result.error.code}`)
  return result.value
}

function expectDomainError(input: string, code: DomainErrorCode): void {
  const result = normalizeDomain(input)
  expect(result).toMatchObject({ error: { code }, ok: false })
}

describe('D2-01 domain normalization', () => {
  it('converts Chinese domains in both directions and keeps public display in ASCII', () => {
    const unicode = expectNormalized('例子.中国')
    expect(unicode).toMatchObject({
      ascii: 'xn--fsqu00a.xn--fiqs8s',
      display: 'xn--fsqu00a.xn--fiqs8s',
      risks: [],
      unicode: '例子.中国',
    })

    const punycode = expectNormalized('xn--fsqu00a.xn--fiqs8s')
    expect(punycode).toEqual(unicode)
  })

  it('normalizes whitespace, case, full-width characters, separators and one root dot', () => {
    expect(expectNormalized('  ＷＡＮＭＩ．ＮＥＴ。  ')).toMatchObject({
      ascii: 'wanmi.net',
      display: 'wanmi.net',
      unicode: 'wanmi.net',
    })
    expect(expectNormalized('WANMI.NET.').ascii).toBe('wanmi.net')
  })

  it('uses non-transitional UTS-46 processing', () => {
    expect(expectNormalized('faß.de')).toMatchObject({
      ascii: 'xn--fa-hia.de',
      unicode: 'faß.de',
    })
  })

  it('rejects emoji and other invalid characters under IDNA2008', () => {
    expectDomainError('😀.com', 'DOMAIN_INVALID_CHARACTER')
    expectDomainError('foo_bar.com', 'DOMAIN_INVALID_CHARACTER')
    expectDomainError('foo bar.com', 'DOMAIN_INVALID_CHARACTER')
  })

  it('enforces IDNA2008 contextual character rules', () => {
    expect(expectNormalized('l·l.cat').unicode).toBe('l·l.cat')
    expectDomainError('a·b.com', 'DOMAIN_IDNA_INVALID')
    expectDomainError('a・b.com', 'DOMAIN_IDNA_INVALID')
    expect(expectNormalized('カ・ナ.jp').unicode).toBe('カ・ナ.jp')
  })

  it('reports mixed scripts per label without flagging standard Japanese script combinations', () => {
    const mixed = expectNormalized('раypal.com')
    expect(mixed.risks).toEqual([
      expect.objectContaining({
        code: 'DOMAIN_MIXED_SCRIPT_RISK',
        labelAscii: mixed.ascii.split('.')[0],
        scripts: ['Cyrillic', 'Latin'],
      }),
    ])
    expect(mixed.risks[0].message).toContain('不代表可注册或商标安全')

    expect(expectNormalized('例カな.jp').risks).toEqual([])
    expect(expectNormalized('例子.com').risks).toEqual([])
  })

  it('enforces label and total ASCII length boundaries', () => {
    expect(expectNormalized(`${'a'.repeat(63)}.com`).ascii).toHaveLength(67)
    expectDomainError(`${'a'.repeat(64)}.com`, 'DOMAIN_LABEL_TOO_LONG')

    const length253 = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
    expect(expectNormalized(length253).ascii).toHaveLength(253)
    expectDomainError(`${length253}d`, 'DOMAIN_NAME_TOO_LONG')
  })

  it('rejects empty labels and invalid hyphen positions', () => {
    expectDomainError('foo..com', 'DOMAIN_EMPTY_LABEL')
    expectDomainError('foo.com..', 'DOMAIN_EMPTY_LABEL')
    expectDomainError('-foo.com', 'DOMAIN_INVALID_HYPHEN')
    expectDomainError('foo-.com', 'DOMAIN_INVALID_HYPHEN')
    expectDomainError('ab--cd.com', 'DOMAIN_INVALID_HYPHEN')
  })

  it('rejects malformed, Unicode-prefixed and double-encoded A-labels', () => {
    expectDomainError('xn--.com', 'DOMAIN_INVALID_PUNYCODE')
    expectDomainError('xn--例子.com', 'DOMAIN_INVALID_PUNYCODE')
    expectDomainError('xn--xn--fsqu00a.com', 'DOMAIN_INVALID_PUNYCODE')
  })

  it('rejects empty input and numeric TLDs while allowing a general single label', () => {
    expectDomainError('', 'DOMAIN_EMPTY')
    expectDomainError('   ', 'DOMAIN_EMPTY')
    expectDomainError('example.123', 'DOMAIN_NUMERIC_TLD')
    expectDomainError('example.١٢٣', 'DOMAIN_NUMERIC_TLD')
    expectDomainError('123', 'DOMAIN_NUMERIC_TLD')
    expect(expectNormalized('example').ascii).toBe('example')
  })

  it('adapts success and failure to the shared Result and Problem Details contract', () => {
    const normalizedDomainSchema = z.object({
      ascii: z.string(),
      display: z.string(),
      risks: z.array(
        z.object({
          code: z.literal('DOMAIN_MIXED_SCRIPT_RISK'),
          labelAscii: z.string(),
          message: z.string(),
          scripts: z.array(z.string()),
        }),
      ),
      unicode: z.string(),
    })
    const resultSchema = createResultSchema(normalizedDomainSchema)

    const ready = normalizeDomainResult('例子.中国', traceId)
    expect(resultSchema.parse(ready)).toMatchObject({
      data: { display: 'xn--fsqu00a.xn--fiqs8s' },
      state: 'ready',
    })

    const failed = normalizeDomainResult('😀.com', traceId)
    expect(resultSchema.parse(failed)).toMatchObject({
      problem: {
        code: 'DOMAIN_INVALID_CHARACTER',
        retryable: false,
        status: 400,
        traceId,
      },
      state: 'error',
    })
    if (failed.state !== 'error') throw new Error('Expected an error Result')
    expect(problemDetailsSchema.parse(failed.problem)).toEqual(failed.problem)
    expect(JSON.stringify(failed)).not.toContain('😀.com')
  })
})
