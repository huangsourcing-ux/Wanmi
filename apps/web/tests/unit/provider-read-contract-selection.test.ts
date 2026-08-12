import { describe, expect, it } from 'vitest'

import {
  parseProviderReadContractSelection,
  providerReadContractCategories,
  providerReadContractSelectionIsComplete,
  shouldUseWestDigitalReadContractProxy,
} from '@/lib/provider-read-contract-selection'

describe('provider read-contract category selection', () => {
  it('defaults to all categories so the established full contract remains unchanged', () => {
    const selection = parseProviderReadContractSelection(undefined)

    expect(selection).toEqual(providerReadContractCategories)
    expect(providerReadContractSelectionIsComplete(selection)).toBe(true)
  })

  it('allows an explicit partial selection in canonical execution order', () => {
    const selection = parseProviderReadContractSelection(
      'aliyun.oss_private,westdigital,westdigital',
    )

    expect(selection).toEqual(['westdigital', 'aliyun.oss_private'])
    expect(providerReadContractSelectionIsComplete(selection)).toBe(false)
  })

  it('rejects unknown or empty category items', () => {
    expect(() => parseProviderReadContractSelection('   ')).toThrow(/must not be empty/u)
    expect(() => parseProviderReadContractSelection('westdigital,unknown')).toThrow(
      /Unknown provider read-contract categories/u,
    )
    expect(() => parseProviderReadContractSelection('westdigital,')).toThrow(/empty item/u)
  })

  it('requires an explicit startup proxy opt-in for the one-time WestDigital contract', () => {
    expect(
      shouldUseWestDigitalReadContractProxy({ nodeUseEnvProxy: undefined, requested: undefined }),
    ).toBe(false)
    expect(shouldUseWestDigitalReadContractProxy({ nodeUseEnvProxy: '1', requested: 'true' })).toBe(
      true,
    )
    expect(() =>
      shouldUseWestDigitalReadContractProxy({ nodeUseEnvProxy: undefined, requested: 'true' }),
    ).toThrow(/NODE_USE_ENV_PROXY=1/u)
    expect(() =>
      shouldUseWestDigitalReadContractProxy({ nodeUseEnvProxy: '1', requested: 'yes' }),
    ).toThrow(/must be true or false/u)
  })
})
