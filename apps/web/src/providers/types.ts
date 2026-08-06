import type { ProviderResult } from '@/lib/domain'
import type { DnsRecord, DnsRecordType } from '@/schemas/dns'

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

export interface SmsProvider extends HealthAwareProvider {
  sendOtp(input: {
    code: string
    phone: string
    traceId: string
  }): Promise<ProviderResult<{ accepted: true }>>
}

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

export interface PaymentProvider extends HealthAwareProvider {
  queryOrder(input: {
    merchantOrderNumber: string
    traceId: string
  }): Promise<ProviderResult<{ paid: boolean }>>
}
