import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ASSETS,
  MEGA_PANELS,
  SEARCH_TABS,
} from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/site-data'

/**
 * The CSP-safe patch replaced dynamic inline styles with CSS keyed by data attributes over the
 * finite value sets in site-data.ts. Those enumerations must stay in step with the data: a new
 * tab or column width added to the data without a matching rule renders unstyled. The build-card
 * and auction-tone enumerations left with the blocks that used them in frontend merge two.
 */
const stylesheet = readFileSync(resolve(process.cwd(), 'src/app/(frontend)/styles.css'), 'utf8')

function attributeValues(selector: string, attribute: string): string[] {
  const pattern = new RegExp(`${selector}\\[${attribute}=["']([^"']+)["']\\]`, 'gu')
  return [...stylesheet.matchAll(pattern)].map((match) => match[1])
}

function indexRange(length: number): string[] {
  return Array.from({ length }, (_, index) => String(index))
}

/** First `property` declaration of the rule whose selector list contains `selector`. */
function declaration(selector: string, property: string): string | undefined {
  const pattern = new RegExp(`${selector}[^{]*\\{[^}]*?${property}:\\s*([^;]+);`, 'u')
  return stylesheet.match(pattern)?.[1]
}

describe('vendored site CSS enumerations cover site-data.ts', () => {
  it('has exactly one tab indicator rule per SEARCH_TABS entry and divides the track by that count', () => {
    const indices = attributeValues('\\.dyna-search-tab-indicator', 'data-active-index')
    expect(indices).toEqual(indexRange(SEARCH_TABS.length))
    expect(stylesheet).toContain(`width: calc((100% - 8px) / ${SEARCH_TABS.length});`)
  })

  it('has a mega-column width rule for every columnWidth used by MEGA_PANELS', () => {
    const widths = new Set(attributeValues('\\.dyna-mega-column', 'data-column-width'))
    const used = [...new Set(MEGA_PANELS.map((panel) => String(panel.columnWidth)))]
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((width) => !widths.has(width))).toEqual([])
  })

  it('points .dyna-hero-glow at the hero background under ASSETS', () => {
    const ruled = declaration('\\.dyna-hero-glow', 'background-image')
    expect(ruled).toBeDefined()
    expect(ruled!.match(/url\(["']?([^"')]+)["']?\)/u)?.[1]).toBe(`${ASSETS}/images/hero-bg.webp`)
  })
})
