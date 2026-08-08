import type { ProviderResult } from '@/lib/domain'
import type { DnsRecord, DnsRecordType } from '@/schemas/dns'
import type { TlsCertificate, TlsFinding } from '@/schemas/tls'

export interface HealthAwareProvider {
  health(): Promise<ProviderResult<{ healthy: boolean }>>
}

export type PublicRegistrationRecord = {
  dates: {
    created: string | null
    expires: string | null
    updated: string | null
  }
  domainAscii: string
  domainUnicode: string
  nameServers: string[]
  recordStatus: 'record_found' | 'no_public_record'
  registrar: string | null
  source: {
    protocol: 'rdap' | 'whois'
    provider: 'whodat' | 'westdigital'
  }
  statuses: string[]
}

export interface PublicRegistrationProvider extends HealthAwareProvider {
  queryPublicRegistration(input: {
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<PublicRegistrationRecord>>
}

export type DnsProviderAnswer = {
  fallbackUsed: boolean
  negativeTtlSeconds?: number
  records: DnsRecord[]
  resolverNode: 'alidns_primary' | 'alidns_secondary'
  status: 'records' | 'no_record' | 'nxdomain' | 'servfail'
}

export interface DnsReadProvider extends HealthAwareProvider {
  queryRecordSet(input: {
    domainAscii: string
    recordType: DnsRecordType
    traceId: string
  }): Promise<ProviderResult<DnsProviderAnswer>>
}

export type TlsHandshakeReport = {
  certificate: TlsCertificate
  cipherSuite: string
  findings: TlsFinding[]
  protocol: string
}

export interface TlsHandshakeProvider extends HealthAwareProvider {
  inspectCertificate(input: {
    addresses: string[]
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<TlsHandshakeReport>>
}

export interface SmsProvider extends HealthAwareProvider {
  sendOtp(input: { code: string; phone: string; traceId: string }): Promise<
    ProviderResult<{
      accepted: true
      deliveryStatus: 'accepted' | 'delivered'
      providerMessageId: string
    }>
  >
  queryReceipt(input: {
    phone: string
    providerMessageId: string
    sentAt: string
    traceId: string
  }): Promise<
    ProviderResult<{
      failureCategory?: SmsFailureCategory
      providerCode?: string
      status: 'delivered' | 'failed' | 'pending'
    }>
  >
}

export type SmsFailureCategory =
  | 'balance_insufficient'
  | 'invalid_number'
  | 'rate_limited'
  | 'template_unapproved'
  | 'unknown'

export interface KmsProvider extends HealthAwareProvider {
  decryptDataKey(input: {
    ciphertext: string
    traceId: string
  }): Promise<ProviderResult<{ plaintext: Uint8Array }>>
  generateDataKey(input: {
    traceId: string
  }): Promise<ProviderResult<{ ciphertext: string; plaintext: Uint8Array }>>
}

export interface RealnameObjectProvider extends HealthAwareProvider {
  deleteObject(input: { key: string; traceId: string }): Promise<ProviderResult<{ deleted: true }>>
  read(input: {
    key: string
    traceId: string
  }): Promise<ProviderResult<{ body: Uint8Array; etag: string }>>
  signRead(input: {
    expiresSeconds: number
    key: string
    traceId: string
  }): Promise<ProviderResult<{ url: string }>>
  upload(input: {
    body: Uint8Array
    key: string
    traceId: string
  }): Promise<ProviderResult<{ etag: string }>>
}

export interface DomainOperationProvider extends HealthAwareProvider {
  submitOperation(input: {
    operationKey: string
    traceId: string
  }): Promise<ProviderResult<{ providerRequestId: string }>>
}

export type WestDigitalAvailability = {
  available: boolean
  currency: 'CNY'
  domainAscii: string
  premium: boolean
  premiumRegistrationPriceFen?: number
}

export type WestDigitalPrice = {
  currency: 'CNY'
  domainAscii: string
  productId: string
  purchaseYears: number
  registrationPriceFen: number
  renewalPriceFen: number
}

export interface WestDigitalReadProvider extends HealthAwareProvider {
  queryAvailability(input: {
    domain: string
    traceId: string
  }): Promise<ProviderResult<WestDigitalAvailability>>
  queryPrice(input: {
    domain: string
    traceId: string
    years: number
  }): Promise<ProviderResult<WestDigitalPrice>>
}

export type WestDigitalRealnameProfile = {
  addressChinese: string
  addressEnglish: string
  applicableScopes: ('cg' | 'gswl' | 'hk')[]
  cityChinese: string
  cityEnglish: string
  contactFirstNameChinese: string
  contactFirstNameEnglish: string
  contactLastNameChinese: string
  contactLastNameEnglish: string
  countryCode: string
  districtChinese: string
  email: string
  fullNameChinese: string
  identityDocumentNumber: string
  identityDocumentType: string
  organizationNameChinese?: string
  organizationNameEnglish?: string
  phone: string
  phoneAreaCode?: string
  phoneCountryCode: string
  phoneExtension?: string
  phoneType: 'landline' | 'mobile'
  postalCode: string
  provinceChinese: string
  provinceEnglish: string
  type: 'individual' | 'organization'
}

export type WestDigitalRealnameReviewState = 'approved' | 'pending' | 'rejected' | 'unknown'

export interface WestDigitalRealnameProvider extends HealthAwareProvider {
  createTemplate(input: { profile: WestDigitalRealnameProfile; traceId: string }): Promise<
    ProviderResult<{
      providerTemplateId: string
      reviewState: 'pending'
    }>
  >
  queryTemplate(input: { providerTemplateId: string; traceId: string }): Promise<
    ProviderResult<{
      reviewState: WestDigitalRealnameReviewState
      safeFailureReason?: 'identity_mismatch' | 'material_invalid' | 'other'
    }>
  >
}

export type WestDigitalDomainAsset = {
  domainAscii: string
  expiresAt: string
  nameservers: string[]
  providerAssetId: string
  registeredAt: string
  registrarCode: string
}

export type WestDigitalWriteConfirmation = {
  providerClientId: string
  state: 'accepted' | 'failed' | 'pending' | 'succeeded' | 'unknown'
}

export interface WestDigitalWriteProvider extends HealthAwareProvider {
  changeNameservers(input: {
    domainAscii: string
    nameservers: string[]
    traceId: string
  }): Promise<ProviderResult<WestDigitalWriteConfirmation>>
  createRealname(input: {
    profile: WestDigitalRealnameProfile
    traceId: string
  }): Promise<ProviderResult<WestDigitalWriteConfirmation & { providerTemplateId: string }>>
  queryAsset(input: {
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<WestDigitalDomainAsset>>
  queryRealname(input: {
    providerTemplateId: string
    traceId: string
  }): Promise<ProviderResult<WestDigitalWriteConfirmation & { reviewState: WestDigitalRealnameReviewState }>>
  register(input: {
    clientPriceFen: number
    domainAscii: string
    nameservers: string[]
    premium: boolean
    providerTemplateId: string
    traceId: string
    years: number
  }): Promise<ProviderResult<WestDigitalWriteConfirmation>>
  renew(input: {
    clientPriceFen: number
    currentExpiresOn: string
    domainAscii: string
    premium: boolean
    traceId: string
    years: number
  }): Promise<ProviderResult<WestDigitalWriteConfirmation>>
}

export type PaymentChannel = 'h5' | 'native'

export type PaymentOrderState = 'closed' | 'not_paid' | 'paid' | 'refunded' | 'unknown'

export type PaymentOrder = {
  amountMinor?: number
  currency?: 'CNY'
  merchantOrderNumber: string
  paidAt?: string
  state: PaymentOrderState
  transactionId?: string
}

export type VerifiedPaymentNotification =
  | {
      notificationId?: undefined
      reason: 'invalid_resource' | 'invalid_signature' | 'malformed_headers'
      signatureVerified: boolean
      verified: false
    }
  | {
      amountMinor: number
      currency: 'CNY'
      merchantOrderNumber: string
      notificationId: string
      paidAt: string
      transactionId: string
      verified: true
    }

export type RefundState = 'processing' | 'succeeded' | 'failed' | 'closed' | 'unknown'

export type RefundOrder = {
  amountMinor?: number
  currency?: 'CNY'
  merchantOrderNumber: string
  providerRefundId?: string
  refundNumber: string
  refundedAt?: string
  state: RefundState
  failureCategory?: 'balance_insufficient' | 'disputed' | 'provider_rejected' | 'unknown'
}

export type VerifiedRefundNotification =
  | {
      notificationId?: undefined
      reason: 'invalid_resource' | 'invalid_signature' | 'malformed_headers'
      signatureVerified: boolean
      verified: false
    }
  | {
      amountMinor: number
      currency: 'CNY'
      merchantOrderNumber: string
      notificationId: string
      providerRefundId: string
      refundNumber: string
      refundedAt: string
      verified: true
    }

export interface PaymentProvider extends HealthAwareProvider {
  closeOrder(input: {
    merchantOrderNumber: string
    traceId: string
  }): Promise<ProviderResult<{ closed: true }>>
  createPayment(input: {
    amountMinor: number
    channel: PaymentChannel
    clientIp?: string
    description: string
    expiresAt: string
    merchantOrderNumber: string
    traceId: string
  }): Promise<
    ProviderResult<
      | { channel: 'h5'; expiresAt: string; h5Url: string }
      | { channel: 'native'; codeUrl: string; expiresAt: string }
    >
  >
  queryOrder(input: {
    merchantOrderNumber: string
    traceId: string
  }): Promise<ProviderResult<PaymentOrder>>
  verifyNotification(input: {
    body: string
    headers: Headers
    traceId: string
  }): Promise<VerifiedPaymentNotification>
}

export interface RefundProvider extends HealthAwareProvider {
  createRefund(input: {
    amountMinor: number
    merchantOrderNumber: string
    reason: string
    refundNumber: string
    traceId: string
  }): Promise<ProviderResult<RefundOrder>>
  queryRefund(input: {
    refundNumber: string
    traceId: string
  }): Promise<ProviderResult<RefundOrder>>
  verifyRefundNotification(input: {
    body: string
    headers: Headers
    traceId: string
  }): Promise<VerifiedRefundNotification>
}
