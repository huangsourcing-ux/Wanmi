import { getEnv } from '@/lib/env'
import { normalizeDomain } from '@/lib/domain-name'

export type WestDigitalGuardedWrite =
  | {
      domainAscii: string
      operation:
        | 'dns_record_add'
        | 'dns_record_batch_delete'
        | 'dns_record_delete'
        | 'dns_record_modify'
        | 'dns_record_pause'
        | 'domain_contact_update'
        | 'domain_management_password'
        | 'domain_template_transfer'
        | 'nameserver'
        | 'realname'
    }
  | {
      clientPriceFen: number
      domainAscii: string
      operation: 'register' | 'renew'
    }

export class ProviderWriteGuardError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ProviderWriteGuardError'
  }
}

export type ProviderWriteBudgetAuthorization = {
  amountFen: number
  amountLimitFen: number
  amountLimitExceededCode: string
  capability: 'payment' | 'refund' | 'register_renew'
  operationDelta: number
  operationKey: string
  operationLimit: number
  operationLimitExceededCode: string
  provider: 'wechatpay' | 'westdigital'
}

function requireGate(enabled: boolean, code: string): void {
  if (!enabled) throw new ProviderWriteGuardError(code)
}

function normalizedAllowlist(raw: string): Set<string> {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const result = new Set<string>()
  for (const value of values) {
    const normalized = normalizeDomain(value)
    if (!normalized.ok || normalized.value.ascii !== value.toLowerCase()) {
      throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_ALLOWLIST_INVALID')
    }
    result.add(normalized.value.ascii)
  }
  return result
}

function westDigitalCapabilityEnabled(operation: WestDigitalGuardedWrite['operation']): boolean {
  const env = getEnv()
  if (operation.startsWith('dns_record_')) return env.ALLOW_REAL_WESTDIGITAL_DNS_WRITES
  if (operation === 'realname') return env.ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES
  if (operation === 'register') return env.ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES
  if (operation === 'renew') return env.ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES
  if (
    operation === 'domain_contact_update' ||
    operation === 'domain_management_password' ||
    operation === 'domain_template_transfer'
  ) {
    return env.ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES
  }
  return env.ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES
}

export function authorizeWestDigitalWrite(
  input: WestDigitalGuardedWrite,
  operationKey: string,
): ProviderWriteBudgetAuthorization | undefined {
  const env = getEnv()
  if (!env.ALLOW_REAL_PROVIDER_WRITES) return undefined

  requireGate(env.ALLOW_REAL_WESTDIGITAL, 'WESTDIGITAL_PROVIDER_WRITE_DISABLED')
  requireGate(
    westDigitalCapabilityEnabled(input.operation),
    input.operation.startsWith('dns_record_')
      ? 'WESTDIGITAL_DNS_WRITE_DISABLED'
      : `WESTDIGITAL_${input.operation.toUpperCase()}_WRITE_DISABLED`,
  )

  const domain = normalizeDomain(input.domainAscii)
  if (!domain.ok || domain.value.ascii !== input.domainAscii.toLowerCase()) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_DOMAIN_INVALID')
  }
  const allowlist = normalizedAllowlist(env.WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST)
  if (!allowlist.has(domain.value.ascii)) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_DOMAIN_NOT_ALLOWLISTED')
  }

  if (input.operation !== 'register' && input.operation !== 'renew') return undefined
  if (!Number.isSafeInteger(input.clientPriceFen) || input.clientPriceFen <= 0) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_AMOUNT_INVALID')
  }
  if (
    env.WESTDIGITAL_WRITE_MAX_REGISTER_RENEW_OPERATIONS < 1 ||
    env.WESTDIGITAL_WRITE_SINGLE_AMOUNT_LIMIT_FEN < 1 ||
    env.WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN < 1
  ) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_LIMITS_UNCONFIGURED')
  }
  if (input.clientPriceFen > env.WESTDIGITAL_WRITE_SINGLE_AMOUNT_LIMIT_FEN) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_SINGLE_AMOUNT_LIMIT_EXCEEDED')
  }
  return {
    amountFen: input.clientPriceFen,
    amountLimitFen: env.WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN,
    amountLimitExceededCode: 'WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED',
    capability: 'register_renew',
    operationDelta: 1,
    operationKey,
    operationLimit: env.WESTDIGITAL_WRITE_MAX_REGISTER_RENEW_OPERATIONS,
    operationLimitExceededCode: 'WESTDIGITAL_WRITE_OPERATION_LIMIT_EXCEEDED',
    provider: 'westdigital',
  }
}

export function authorizeWechatPayWrite(
  operation: 'payment' | 'payment_close' | 'refund',
  amountFen: number,
  operationKey: string,
): ProviderWriteBudgetAuthorization | undefined {
  const env = getEnv()
  requireGate(env.ALLOW_REAL_PROVIDER_WRITES, 'PROVIDER_WRITE_DISABLED')
  requireGate(env.ALLOW_REAL_WECHATPAY, 'WECHATPAY_PROVIDER_WRITE_DISABLED')
  requireGate(
    operation === 'refund' ? env.ALLOW_REAL_WECHATPAY_REFUNDS : env.ALLOW_REAL_WECHATPAY_PAYMENTS,
    operation === 'refund' ? 'WECHATPAY_REFUND_WRITE_DISABLED' : 'WECHATPAY_PAYMENT_WRITE_DISABLED',
  )
  if (operation === 'payment_close') return undefined
  if (
    env.WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN < 1 ||
    env.WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN < 1
  ) {
    throw new ProviderWriteGuardError('WECHATPAY_WRITE_LIMITS_UNCONFIGURED')
  }
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw new ProviderWriteGuardError('WECHATPAY_WRITE_AMOUNT_INVALID')
  }
  if (amountFen > env.WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN) {
    throw new ProviderWriteGuardError('WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_EXCEEDED')
  }
  if (!operationKey.trim()) {
    throw new ProviderWriteGuardError('WECHATPAY_WRITE_OPERATION_KEY_INVALID')
  }
  return {
    amountFen,
    amountLimitFen: env.WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN,
    amountLimitExceededCode: 'WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED',
    capability: operation,
    operationDelta: 0,
    operationKey,
    operationLimit: 0,
    operationLimitExceededCode: 'WECHATPAY_WRITE_OPERATION_LIMIT_EXCEEDED',
    provider: 'wechatpay',
  }
}

export function assertLiveRuntimeTransportAllowed(provider: 'wechatpay' | 'westdigital'): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    throw new Error(`Automated tests must never construct a live ${provider} runtime transport`)
  }
}
