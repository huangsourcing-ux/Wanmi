import type { ProviderResult } from '@/lib/domain'

export interface HealthAwareProvider {
  health(): Promise<ProviderResult<{ healthy: boolean }>>
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

export interface DomainProvider extends HealthAwareProvider {
  queryRegistration(input: {
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<{ registered: boolean }>>
  submitOperation(input: {
    operationKey: string
    traceId: string
  }): Promise<ProviderResult<{ providerRequestId: string }>>
}

export interface PaymentProvider extends HealthAwareProvider {
  queryOrder(input: {
    merchantOrderNumber: string
    traceId: string
  }): Promise<ProviderResult<{ paid: boolean }>>
}
