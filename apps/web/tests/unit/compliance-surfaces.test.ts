import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repository = resolve(process.cwd(), '../..')

function source(path: string): string {
  return readFileSync(resolve(repository, path), 'utf8')
}

describe('D8-01 required registrar disclosure surfaces', () => {
  it.each([
    ['footer', 'apps/web/src/components/site/site-footer.tsx'],
    ['pricing', 'apps/web/src/app/(frontend)/pricing/page.tsx'],
    ['checkout', 'apps/web/src/components/commerce/payment-flow.tsx'],
    ['domain asset detail', 'apps/web/src/app/(frontend)/account/domains/[assetId]/page.tsx'],
  ])('keeps the shared disclosure component on %s', (_surface, path) => {
    expect(source(path).match(/<RegistrarDisclosure\b/gu) ?? []).toHaveLength(1)
  })
})
