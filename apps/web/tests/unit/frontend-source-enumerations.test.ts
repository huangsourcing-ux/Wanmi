import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BENTO_CARDS,
  MEGA_PANELS,
  SEARCH_TABS,
} from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/site-data'

/**
 * The CSP-safe patch replaced dynamic inline styles with CSS keyed by data attributes over the
 * finite value sets in site-data.ts. Those enumerations must stay in step with the data: a new
 * tab, card, column width or tone added to the data without a matching rule renders unstyled.
 */
const stylesheet = readFileSync(resolve(process.cwd(), 'src/app/(frontend)/styles.css'), 'utf8')
const hotAuctions = readFileSync(
  resolve(
    process.cwd(),
    'src/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/HotAuctions.tsx',
  ),
  'utf8',
)

function attributeValues(selector: string, attribute: string): string[] {
  const pattern = new RegExp(`${selector}\\[${attribute}=["']([^"']+)["']\\]`, 'gu')
  return [...stylesheet.matchAll(pattern)].map((match) => match[1])
}

function indexRange(length: number): string[] {
  return Array.from({ length }, (_, index) => String(index))
}

describe('vendored site CSS enumerations cover site-data.ts', () => {
  it('has exactly one tab indicator rule per SEARCH_TABS entry and divides the track by that count', () => {
    const indices = attributeValues('\\.dyna-search-tab-indicator', 'data-active-index')
    expect(indices).toEqual(indexRange(SEARCH_TABS.length))
    expect(stylesheet).toContain(`width: calc((100% - 8px) / ${SEARCH_TABS.length});`)
  })

  it('has exactly one build-card rule per BENTO_CARDS entry', () => {
    const indices = attributeValues('', 'data-build-card')
    expect(indices).toEqual(indexRange(BENTO_CARDS.length))
  })

  it('has a mega-column width rule for every columnWidth used by MEGA_PANELS', () => {
    const widths = new Set(attributeValues('\\.dyna-mega-column', 'data-column-width'))
    const used = [...new Set(MEGA_PANELS.map((panel) => String(panel.columnWidth)))]
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((width) => !widths.has(width))).toEqual([])
  })

  it('styles both auction tones for badge and price regardless of the current data', () => {
    const tones = hotAuctions.match(/endingSoon \? "([a-z-]+)" : "([a-z-]+)"/u)
    expect(tones?.slice(1).sort()).toEqual(['ending-soon', 'not-ending-soon'])
    for (const element of ['badge', 'price']) {
      const ruled = attributeValues(`\\.dyna-auction-${element}`, 'data-auction-tone')
      expect([...new Set(ruled)].sort()).toEqual(['ending-soon', 'not-ending-soon'])
    }
  })
})
