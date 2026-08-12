export const providerReadContractCategories = [
  'westdigital',
  'wechatpay',
  'aliyun.oss_private',
  'aliyun.sms_configuration',
] as const

export type ProviderReadContractCategory = (typeof providerReadContractCategories)[number]

export function parseProviderReadContractSelection(
  value: string | undefined,
): ProviderReadContractCategory[] {
  if (value === undefined) return [...providerReadContractCategories]
  if (!value.trim()) throw new Error('Provider read-contract category list must not be empty')

  const requested = new Set(value.split(',').map((item) => item.trim()))
  if (requested.has(''))
    throw new Error('Provider read-contract category list contains an empty item')

  const unknown = [...requested].filter(
    (item) => !providerReadContractCategories.includes(item as ProviderReadContractCategory),
  )
  if (unknown.length > 0) {
    throw new Error(`Unknown provider read-contract categories: ${unknown.join(', ')}`)
  }

  return providerReadContractCategories.filter((category) => requested.has(category))
}

export function providerReadContractSelectionIsComplete(
  selection: readonly ProviderReadContractCategory[],
): boolean {
  return selection.length === providerReadContractCategories.length
}

export function shouldUseWestDigitalReadContractProxy(input: {
  nodeUseEnvProxy: string | undefined
  requested: string | undefined
}): boolean {
  if (!input.requested?.trim() || input.requested === 'false') return false
  if (input.requested !== 'true') {
    throw new Error('WestDigital read-contract proxy flag must be true or false')
  }
  if (input.nodeUseEnvProxy !== '1') {
    throw new Error('WestDigital read-contract proxy requires NODE_USE_ENV_PROXY=1 at startup')
  }
  return true
}
