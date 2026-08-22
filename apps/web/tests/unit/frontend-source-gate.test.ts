import { describe, expect, it } from 'vitest'

import { FRONTEND_SOURCE_MIRRORS } from '../../../../scripts/frontend-source-paths.mjs'
import { verifyFrontendSource } from '../../../../scripts/verify-frontend-source.mjs'

/**
 * verify:frontend-source only protects the paths it is told about. Removing a mirror entry
 * would let that subtree drift while the gate stays green, so the mirror list and the number
 * of files it covers are pinned here; both numbers change only by a deliberate edit.
 */
describe('frontend-source gate scope', () => {
  it('mirrors exactly the three baseline paths', () => {
    expect(FRONTEND_SOURCE_MIRRORS).toEqual([
      {
        source: 'frontend-source/src/components/sites',
        target: 'apps/web/src/components/sites',
      },
      { source: 'frontend-source/src/types/dynadot.ts', target: 'apps/web/src/types/dynadot.ts' },
      { source: 'frontend-source/public/sites', target: 'apps/web/public/sites' },
    ])
  })

  it('compares the full current mirror set and all five stylesheet blocks', () => {
    const result = verifyFrontendSource()
    expect(result.problems).toEqual([])
    expect(result.compared).toBe(29)
    expect(result.cssBlocks).toBe(5)
  })
})
