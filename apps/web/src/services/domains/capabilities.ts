import { AppError } from '@/lib/errors'

export const DOMAIN_CAPABILITY_NAMES = [
  'asset_sync',
  'certificate_download',
  'contact_information_update',
  'management_password_read',
  'management_password_write',
  'realtime_transfer',
  'template_transfer',
] as const

export type DomainCapabilityName = (typeof DOMAIN_CAPABILITY_NAMES)[number]

export type DomainCapabilityDeclaration = Readonly<
  Record<DomainCapabilityName, { supported: boolean; unsupportedCode: string }>
>

export const WESTDIGITAL_DOMAIN_CAPABILITIES = {
  asset_sync: {
    supported: true,
    unsupportedCode: 'DOMAIN_CAPABILITY_ASSET_SYNC_UNSUPPORTED',
  },
  certificate_download: {
    supported: true,
    unsupportedCode: 'DOMAIN_CAPABILITY_CERTIFICATE_DOWNLOAD_UNSUPPORTED',
  },
  contact_information_update: {
    supported: true,
    unsupportedCode: 'DOMAIN_CAPABILITY_CONTACT_INFORMATION_UPDATE_UNSUPPORTED',
  },
  management_password_read: {
    supported: true,
    unsupportedCode: 'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_READ_UNSUPPORTED',
  },
  management_password_write: {
    supported: true,
    unsupportedCode: 'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_WRITE_UNSUPPORTED',
  },
  realtime_transfer: {
    supported: false,
    unsupportedCode: 'DOMAIN_CAPABILITY_REALTIME_TRANSFER_UNSUPPORTED',
  },
  template_transfer: {
    supported: true,
    unsupportedCode: 'DOMAIN_CAPABILITY_TEMPLATE_TRANSFER_UNSUPPORTED',
  },
} as const satisfies DomainCapabilityDeclaration

export function assertDomainCapability(
  capability: DomainCapabilityName,
  declaration: DomainCapabilityDeclaration = WESTDIGITAL_DOMAIN_CAPABILITIES,
): void {
  const value = declaration[capability]
  if (value.supported) return
  throw new AppError(value.unsupportedCode, '当前注册商不支持该域名能力', 409, {
    action: '请选择能力表中已支持的操作',
    retryable: false,
    title: '域名能力不受支持',
  })
}

export function domainCapabilityDeclaration(
  declaration: DomainCapabilityDeclaration = WESTDIGITAL_DOMAIN_CAPABILITIES,
) {
  return DOMAIN_CAPABILITY_NAMES.map((name) => ({
    name,
    supported: declaration[name].supported,
    ...(declaration[name].supported ? {} : { unsupportedCode: declaration[name].unsupportedCode }),
  }))
}
