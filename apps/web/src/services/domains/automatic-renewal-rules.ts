import { getEnv } from '@/lib/env'

export const AUTOMATIC_RENEWAL_RULES_VERSION = '2026-08-18.1'
export const AUTOMATIC_RENEWAL_PREVIEW_TTL_MS = 5 * 60 * 1_000
export const AUTOMATIC_RENEWAL_MANDATE_MAX_VALIDITY_MS = 10 * 365 * 86_400_000

export type AutomaticRenewalRules = {
  balanceReminderLimit: number
  firstAttemptDays: number
  mandateMaxFen: bigint
  retryDays: number[]
  version: string
}

export function automaticRenewalRules(): AutomaticRenewalRules {
  const env = getEnv()
  const retryDays = [...new Set(env.AUTOMATIC_RENEWAL_RETRY_DAYS.split(',').map(Number))]
    .filter(
      (value) =>
        Number.isInteger(value) && value >= 0 && value < env.AUTOMATIC_RENEWAL_FIRST_ATTEMPT_DAYS,
    )
    .sort((left, right) => right - left)
  return {
    balanceReminderLimit: env.AUTOMATIC_RENEWAL_BALANCE_REMINDER_LIMIT,
    firstAttemptDays: env.AUTOMATIC_RENEWAL_FIRST_ATTEMPT_DAYS,
    mandateMaxFen: BigInt(env.AUTOMATIC_RENEWAL_MANDATE_MAX_FEN),
    retryDays,
    version: AUTOMATIC_RENEWAL_RULES_VERSION,
  }
}

export function automaticRenewalAttemptSlot(
  expiresAt: string,
  now: Date,
  rules: AutomaticRenewalRules,
): number | undefined {
  const remainingMs = Date.parse(expiresAt) - now.getTime()
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return undefined
  const remainingDays = Math.ceil(remainingMs / 86_400_000)
  const slots = [rules.firstAttemptDays, ...rules.retryDays]
  return slots.filter((slot) => remainingDays <= slot).at(-1)
}

export function automaticRenewalDaysRemaining(expiresAt: string, now: Date): number {
  const remainingMs = Date.parse(expiresAt) - now.getTime()
  if (!Number.isFinite(remainingMs)) return 0
  return Math.max(0, Math.min(3_650, Math.ceil(remainingMs / 86_400_000)))
}
