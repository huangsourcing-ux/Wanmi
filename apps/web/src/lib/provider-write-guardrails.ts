import { getEnv } from '@/lib/env'
import { normalizeDomain } from '@/lib/domain-name'

export type WestDigitalGuardedWrite =
  | {
      domainAscii: string
      operation: 'nameserver' | 'realname'
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

type WestDigitalRuntimeBudget = {
  amountFen: number
  operationKeys: Set<string>
  registerRenewOperations: number
}

let westDigitalBudget: WestDigitalRuntimeBudget = {
  amountFen: 0,
  operationKeys: new Set(),
  registerRenewOperations: 0,
}
let wechatPayAmountFen = 0

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
  if (operation === 'realname') return env.ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES
  if (operation === 'register') return env.ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES
  if (operation === 'renew') return env.ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES
  return env.ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES
}

export function authorizeWestDigitalWrite(
  input: WestDigitalGuardedWrite,
  operationKey: string,
): void {
  const env = getEnv()
  if (!env.ALLOW_REAL_PROVIDER_WRITES) return

  requireGate(env.ALLOW_REAL_WESTDIGITAL, 'WESTDIGITAL_PROVIDER_WRITE_DISABLED')
  requireGate(
    westDigitalCapabilityEnabled(input.operation),
    `WESTDIGITAL_${input.operation.toUpperCase()}_WRITE_DISABLED`,
  )

  const domain = normalizeDomain(input.domainAscii)
  if (!domain.ok || domain.value.ascii !== input.domainAscii.toLowerCase()) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_DOMAIN_INVALID')
  }
  const allowlist = normalizedAllowlist(env.WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST)
  if (!allowlist.has(domain.value.ascii)) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_DOMAIN_NOT_ALLOWLISTED')
  }

  if (input.operation !== 'register' && input.operation !== 'renew') return
  if (westDigitalBudget.operationKeys.has(operationKey)) return
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
  if (
    westDigitalBudget.registerRenewOperations + 1 >
    env.WESTDIGITAL_WRITE_MAX_REGISTER_RENEW_OPERATIONS
  ) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_OPERATION_LIMIT_EXCEEDED')
  }
  if (
    westDigitalBudget.amountFen + input.clientPriceFen >
    env.WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN
  ) {
    throw new ProviderWriteGuardError('WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED')
  }

  westDigitalBudget.operationKeys.add(operationKey)
  westDigitalBudget.registerRenewOperations += 1
  westDigitalBudget.amountFen += input.clientPriceFen
}

export function authorizeWechatPayWrite(
  operation: 'payment' | 'payment_close' | 'refund',
  amountFen: number,
): void {
  const env = getEnv()
  requireGate(env.ALLOW_REAL_PROVIDER_WRITES, 'PROVIDER_WRITE_DISABLED')
  requireGate(env.ALLOW_REAL_WECHATPAY, 'WECHATPAY_PROVIDER_WRITE_DISABLED')
  requireGate(
    operation === 'refund' ? env.ALLOW_REAL_WECHATPAY_REFUNDS : env.ALLOW_REAL_WECHATPAY_PAYMENTS,
    operation === 'refund' ? 'WECHATPAY_REFUND_WRITE_DISABLED' : 'WECHATPAY_PAYMENT_WRITE_DISABLED',
  )
  if (operation === 'payment_close') return
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
  if (wechatPayAmountFen + amountFen > env.WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN) {
    throw new ProviderWriteGuardError('WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED')
  }
  wechatPayAmountFen += amountFen
}

export function assertLiveRuntimeTransportAllowed(provider: 'wechatpay' | 'westdigital'): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    throw new Error(`Automated tests must never construct a live ${provider} runtime transport`)
  }
}

export function resetProviderWriteGuardrailsForTests(): void {
  westDigitalBudget = {
    amountFen: 0,
    operationKeys: new Set(),
    registerRenewOperations: 0,
  }
  wechatPayAmountFen = 0
}
