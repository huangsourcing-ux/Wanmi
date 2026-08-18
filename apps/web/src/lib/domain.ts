export const ADMIN_ROLES = ['content_editor', 'ad_operator', 'analyst', 'system_admin'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

export const CONSENT_TYPES = [
  'service_terms',
  'privacy_policy',
  'sensitive_personal_information',
  'wechat_profile',
  'commercial_sms',
  'automatic_renewal',
  'invitation_attribution',
  'device_identifier_notice',
] as const

export type ConsentType = (typeof CONSENT_TYPES)[number]

export const CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES = [
  'sensitive_personal_information',
  'wechat_profile',
  'commercial_sms',
  'invitation_attribution',
  'device_identifier_notice',
] as const satisfies readonly ConsentType[]

export type CustomerManagedOptionalConsentType =
  (typeof CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES)[number]

export const CUSTOMER_ACCOUNT_STATUSES = [
  'pending_registration',
  'active',
  'restricted',
  'suspended',
  'closing',
  'closed',
] as const

export type CustomerAccountStatus = (typeof CUSTOMER_ACCOUNT_STATUSES)[number]

export const CUSTOMER_CAPABILITY_RESTRICTIONS = [
  'login_disabled',
  'purchase_disabled',
  'balance_spend_disabled',
  'domain_write_disabled',
  'identity_change_disabled',
  'refund_review',
] as const

export type CustomerCapabilityRestriction = (typeof CUSTOMER_CAPABILITY_RESTRICTIONS)[number]

export const CUSTOMER_ACCOUNT_TRANSITIONS = {
  pending_registration: ['active'],
  active: ['restricted', 'suspended', 'closing'],
  restricted: ['active', 'suspended', 'closing'],
  suspended: ['active', 'restricted', 'closing'],
  closing: ['active', 'closed'],
  closed: [],
} as const satisfies Record<CustomerAccountStatus, readonly CustomerAccountStatus[]>

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
  'approved',
  'rejected',
  'manual_review',
  'disabled',
] as const

export type RealnameStatus = (typeof REALNAME_STATUSES)[number]

export const STEP_UP_PURPOSES = [
  'dns_record_change',
  'nameserver_change',
  'mx_record_change',
  'dns_bulk_delete',
  'domain_lock_change',
  'realname_change',
  'domain_management_password',
  'balance_spend',
  'renewal_mandate_change',
  'account_deletion',
] as const

export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number]

export const ONE_TIME_STEP_UP_PURPOSES = [
  'realname_change',
  'renewal_mandate_change',
  'account_deletion',
] as const

export const ACCOUNT_CLOSURE_BLOCKERS = [
  'closure_cooldown_active',
  'domains_held',
  'unfinished_orders',
  'pending_automatic_renewals',
  'refund_or_reconciliation_issue',
  'invoice_processing',
  'security_freeze_or_dispute',
  'positive_balance',
  'domains_held_check_unavailable',
  'unfinished_orders_check_unavailable',
  'pending_automatic_renewals_check_unavailable',
  'refund_or_reconciliation_issue_check_unavailable',
  'invoice_processing_check_unavailable',
  'security_freeze_or_dispute_check_unavailable',
  'positive_balance_check_unavailable',
] as const

export type AccountClosureBlocker = (typeof ACCOUNT_CLOSURE_BLOCKERS)[number]

export type ProviderError = {
  code: string
  message: string
  retryAfterSeconds?: number
  retryable: boolean
  statusKnown: boolean
}

export type ProviderCacheMetadata = {
  expiresAt?: string
  status: 'hit' | 'miss'
}

export type ProviderResult<T> =
  | {
      cache?: ProviderCacheMetadata
      data: T
      observedAt: string
      ok: true
      requestId: string
    }
  | {
      cache?: ProviderCacheMetadata
      error: ProviderError
      observedAt: string
      ok: false
      requestId: string
    }
