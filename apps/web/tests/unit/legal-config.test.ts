import { describe, expect, it } from 'vitest'

import { getLegalDocument, LEGAL_DOCUMENTS } from '@/lib/legal-config'

describe('D8-01 legal review skeletons', () => {
  it.each([
    ['realname', ['收集范围与最小化', '共享对象与处理责任', '留存、删除与备份']],
    ['payment', ['支付方式与确认口径', '退款规则与处理流程', '争议与投诉处理']],
  ] as const)('keeps %s as a structured, non-final review skeleton', (slug, sectionTitles) => {
    const document = getLegalDocument(slug)

    expect(document?.reviewSections?.map((section) => section.title)).toEqual(
      expect.arrayContaining([...sectionTitles]),
    )
    const items = document?.reviewSections?.flatMap((section) => section.items) ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.startsWith('确认'))).toBe(true)
    expect(document?.description).toContain('待负责人和外部法务确认')
  })

  it('adds both legal routes without replacing the four existing documents', () => {
    expect(LEGAL_DOCUMENTS.map((document) => document.slug)).toEqual([
      'privacy',
      'terms',
      'realname',
      'payment',
      'cookies',
      'advertising',
    ])
  })
})
