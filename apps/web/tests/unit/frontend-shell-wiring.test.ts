import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The byte gate proves the vendored copy exists; this proves the site renders it. The baseline
 * page (frontend-source/src/app/page.tsx) is the contract: everything it renders inside <main>
 * must be rendered, in order, by (frontend)/page.tsx, and the shell it renders around <main>
 * must be rendered by (frontend)/layout.tsx — all imported from @/components/sites/….
 */
const repository = resolve(process.cwd(), '../..')
const read = (path: string) => readFileSync(resolve(repository, path), 'utf8')
const SITES = '@/components/sites/www-dynadot-com-7f8c2392/'

const baselinePage = read('frontend-source/src/app/page.tsx')
const layout = read('apps/web/src/app/(frontend)/layout.tsx')
const page = read('apps/web/src/app/(frontend)/page.tsx')
const siteFooter = read('apps/web/src/components/site/site-footer.tsx')

/** Capitalised JSX tags in source order, e.g. ['Hero', 'HeroAdRail', 'StatsBar', …]. */
function jsxTags(source: string): string[] {
  return [...source.matchAll(/<([A-Z][A-Za-z]*)\b/gu)].map((match) => match[1])
}

/** Local names imported from @/components/sites/… (handles `X as Y`). */
function sitesImports(source: string): string[] {
  return [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/gu)]
    .filter(([, , specifier]) => specifier.startsWith(SITES))
    .flatMap(([, names]) =>
      names.split(',').map(
        (name) =>
          name
            .trim()
            .split(/\s+as\s+/u)
            .at(-1)!,
      ),
    )
    .filter(Boolean)
}

// lastIndexOf: the file's JSDoc mentions <main> before the JSX does.
const baselineMain = baselinePage.slice(
  baselinePage.lastIndexOf('<main>'),
  baselinePage.lastIndexOf('</main>'),
)
const baselineShell = jsxTags(baselinePage).filter((tag) => !jsxTags(baselineMain).includes(tag))

describe('the (frontend) shell and homepage render the vendored components', () => {
  it('homepage renders exactly the baseline <main> sections, in order, imported from @/components/sites', () => {
    const expected = jsxTags(baselineMain)
    expect(expected.length).toBeGreaterThan(0)
    expect(jsxTags(page)).toEqual(expected)
    expect(sitesImports(page).sort()).toEqual([...new Set(expected)].sort())
    expect(page).not.toMatch(/from '@\/components\/(?!sites\/)/u)
  })

  it('layout renders the baseline shell around <main>, imported from @/components/sites', () => {
    expect(baselineShell.sort()).toEqual(['OverlayProvider', 'SiteFooter', 'SiteHeader'])
    for (const tag of ['OverlayProvider', 'SiteHeader']) {
      expect(sitesImports(layout), tag).toContain(tag)
      expect(jsxTags(layout), tag).toContain(tag)
    }
    expect(layout).toContain("import { SiteFooter } from '@/components/site/site-footer'")
    expect(jsxTags(layout)).toContain('SiteFooter')
    expect(sitesImports(siteFooter)).toEqual(['SourceSiteFooter'])
    expect(jsxTags(siteFooter)).toContain('SourceSiteFooter')
  })
})
