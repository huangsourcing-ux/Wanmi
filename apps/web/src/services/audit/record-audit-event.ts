import type { PayloadRequest } from 'payload'

import { isAdminUser, isCustomerUser } from '@/access/roles'
import { getTraceId } from '@/lib/request-id'

export const AUDIT_REDACTED_VALUE = '[REDACTED]'

export type AuditActorType = 'admin' | 'anonymous' | 'customer' | 'provider' | 'system'

export const auditEventDefinitions = {
  'admin.account.changed': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.account.deleted': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.login_failed': { actorTypes: ['anonymous'], targetType: 'admin-auth' },
  'admin.auth.login_succeeded': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.mfa_failed': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.mfa_locked': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.mfa_locked_rejected': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.recovery_code_used': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.invitation.accepted': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.invitation.created': { actorTypes: ['admin'], targetType: 'admin-invitation' },
  'admin.invitation.revoked': { actorTypes: ['admin'], targetType: 'admin-invitation' },
  'admin.mfa.reset_completed': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.session.revoked': { actorTypes: ['admin'], targetType: 'admin-session' },
  'admin.sessions.revoked_all': { actorTypes: ['admin'], targetType: 'admin-session' },
  'redirect.create': { actorTypes: ['admin'], targetType: 'redirect' },
  'redirect.delete': { actorTypes: ['admin'], targetType: 'redirect' },
  'redirect.update': { actorTypes: ['admin'], targetType: 'redirect' },
  'system.local_api.read': { actorTypes: ['system'], targetType: 'payload-collection' },
} as const satisfies Record<string, { actorTypes: readonly AuditActorType[]; targetType: string }>

export type AuditAction = keyof typeof auditEventDefinitions
export type AuditActor =
  | { id: number | string; type: 'admin' | 'customer' | 'provider' }
  | { type: 'anonymous' | 'system' }

export type AuditEventInput = {
  action: AuditAction
  actor?: AuditActor
  metadata?: Record<string, unknown>
  targetId?: number | string
}

const safeDerivedKey = /(?:digest|hash|hashed|last4|masked|sha256)$/i
const sensitiveKey =
  /(?:apikey|authorization|certificateno|certificatenumber|cookie|credential|documentno|documentnumber|encryptionkey|idcard|idnumber|identitycard|identityno|identitynumber|mobile|onetimepassword|otp|passphrase|passportno|passportnumber|password|paymentkey|phone|privatekey|recoverycode|secret|sessionid|sessiontoken|setcookie|signingkey|smscode|telephone|token|totp|verificationcode)/i
const chineseMobile = /(?:\+?86[-\s]?)?1[3-9]\d{9}/g
const chineseIdentityNumber = /(?<![0-9A-Za-z])\d{17}[0-9Xx](?![0-9A-Za-z])/g
const credentialHeader = /(?:authorization\s*:|cookie\s*:|set-cookie\s*:|bearer\s+)/i

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '')
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return !safeDerivedKey.test(normalized) && sensitiveKey.test(normalized)
}

function sanitizeString(value: string): string {
  if (/^\d{6}$/.test(value) || credentialHeader.test(value)) return AUDIT_REDACTED_VALUE
  return value
    .replace(chineseIdentityNumber, AUDIT_REDACTED_VALUE)
    .replace(chineseMobile, AUDIT_REDACTED_VALUE)
}

function sanitizeAuditValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return AUDIT_REDACTED_VALUE
  seen.add(value)
  const sanitized = Array.isArray(value)
    ? value.map((item) => sanitizeAuditValue(item, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          shouldRedactKey(key) ? AUDIT_REDACTED_VALUE : sanitizeAuditValue(nested, seen),
        ]),
      )
  seen.delete(value)
  return sanitized
}

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  return sanitizeAuditValue(metadata, new WeakSet()) as Record<string, unknown>
}

function requestActor(req: PayloadRequest): AuditActor {
  if (isAdminUser(req.user)) return { id: req.user.id, type: 'admin' }
  if (isCustomerUser(req.user)) return { id: req.user.id, type: 'customer' }
  if (req.user) throw new Error('Unsupported authenticated audit actor')
  return { type: 'anonymous' }
}

function actorData(actor: AuditActor): { actorId?: string; actorType: AuditActorType } {
  return 'id' in actor
    ? { actorId: String(actor.id), actorType: actor.type }
    : { actorType: actor.type }
}

export async function recordAuditEvent(req: PayloadRequest, input: AuditEventInput): Promise<void> {
  const definition = auditEventDefinitions[input.action]
  const resolvedActor = input.actor ?? requestActor(req)
  if (!(definition.actorTypes as readonly AuditActorType[]).includes(resolvedActor.type)) {
    throw new Error(`Audit action ${input.action} does not allow actor type ${resolvedActor.type}`)
  }
  await req.payload.create({
    collection: 'auditLogs',
    data: {
      action: input.action,
      ...actorData(resolvedActor),
      metadata: sanitizeAuditMetadata(input.metadata),
      targetId: input.targetId === undefined ? undefined : String(input.targetId),
      targetType: definition.targetType,
      traceId: getTraceId(req.headers),
    },
    overrideAccess: true,
    req,
  })
}
