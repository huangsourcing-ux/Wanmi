export const ADMIN_ROLES = ['content_editor', 'ad_operator', 'analyst', 'system_admin'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'fulfilling',
  'succeeded',
  'refund_pending',
  'refunding',
  'refunded',
  'manual_review',
  'cancelled',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const REALNAME_STATUSES = [
  'draft',
  'pending_review',
  'verified',
  'rejected',
  'manual_review',
  'disabled',
] as const

export type RealnameStatus = (typeof REALNAME_STATUSES)[number]

export type ProviderError = {
  code: string
  message: string
  retryable: boolean
  statusKnown: boolean
}

export type ProviderResult<T> =
  | { data: T; observedAt: string; ok: true; requestId: string }
  | { error: ProviderError; observedAt: string; ok: false; requestId: string }
