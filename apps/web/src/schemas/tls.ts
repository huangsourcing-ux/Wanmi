import { z } from 'zod'

import { createResultSchema, resultCacheStatusSchema } from '@/schemas/api'

export const TLS_PORT = 443 as const
export const TLS_MAX_ADDRESSES = 8
export const TLS_MAX_ATTEMPTS = 4
export const TLS_MAX_CHAIN_DEPTH = 10
export const TLS_MAX_SAN_ENTRIES = 128

export const sslCheckRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(253),
})

const domainRiskSchema = z.strictObject({
  code: z.literal('DOMAIN_MIXED_SCRIPT_RISK'),
  labelAscii: z.string().min(1),
  message: z.string().min(1),
  scripts: z.array(z.string().min(1)),
})

export const tlsFindingCodeSchema = z.enum([
  'TLS_CERT_EXPIRED',
  'TLS_CERT_NOT_YET_VALID',
  'TLS_HOSTNAME_MISMATCH',
  'TLS_CERT_SELF_SIGNED',
  'TLS_CERT_CHAIN_INVALID',
])

export const tlsFindingSchema = z.strictObject({
  code: tlsFindingCodeSchema,
  message: z.string().min(1),
  severity: z.enum(['error', 'warning']),
})

const certificateNameSchema = z.strictObject({
  commonName: z.string().max(1_024).nullable(),
  organization: z.string().max(1_024).nullable(),
})

const chainCertificateSchema = z.strictObject({
  fingerprint256: z.string().max(256).nullable(),
  issuer: certificateNameSchema,
  subject: certificateNameSchema,
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
})

export const tlsCertificateSchema = z.strictObject({
  chain: z.strictObject({
    certificates: z.array(chainCertificateSchema).max(TLS_MAX_CHAIN_DEPTH),
    depth: z.number().int().positive().max(64),
    status: z.enum(['trusted', 'self_signed', 'invalid']),
    truncated: z.boolean(),
  }),
  daysRemaining: z.number().int(),
  hostnameMatch: z.boolean(),
  issuer: certificateNameSchema,
  sanCount: z.number().int().nonnegative(),
  sanTruncated: z.boolean(),
  subject: certificateNameSchema,
  subjectAlternativeNames: z.array(z.string().min(1).max(1_024)).max(TLS_MAX_SAN_ENTRIES),
  validFrom: z.iso.datetime(),
  validityStatus: z.enum(['valid', 'expired', 'not_yet_valid']),
  validTo: z.iso.datetime(),
})

const componentSourceSchema = z.strictObject({
  cacheStatus: resultCacheStatusSchema,
  dataSource: z.string().min(1),
  observedAt: z.iso.datetime(),
})

const componentIssueSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1),
  retryable: z.boolean(),
})

export const tlsInspectionSchema = z
  .strictObject({
    certificate: tlsCertificateSchema.nullable(),
    cipherSuite: z.string().min(1).max(512).nullable(),
    findings: z.array(tlsFindingSchema).max(8),
    issue: componentIssueSchema.optional(),
    port: z.literal(TLS_PORT),
    protocol: z.string().min(1).max(64).nullable(),
    source: componentSourceSchema,
    status: z.enum([
      'connected',
      'no_address',
      'connection_failed',
      'timeout',
      'handshake_failed',
      'handshake_too_large',
      'rate_limited',
    ]),
  })
  .superRefine((value, context) => {
    if (
      value.status === 'connected' &&
      (!value.certificate || !value.protocol || !value.cipherSuite)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'connected TLS result requires certificate details',
      })
    }
    if (value.status !== 'connected' && !value.issue && value.status !== 'no_address') {
      context.addIssue({ code: 'custom', message: 'failed TLS result requires an issue' })
    }
  })

export const caaPolicyRecordSchema = z.strictObject({
  critical: z.boolean(),
  explanation: z.string().min(1),
  flags: z.number().int().nonnegative().max(255),
  ownerName: z.string().min(1).max(253),
  tag: z.enum(['issue', 'issuewild', 'iodef']),
  ttl: z.number().int().nonnegative().max(4_294_967_295),
  value: z.string().max(4_096),
})

export const caaInspectionSchema = z.strictObject({
  effectiveOwnerName: z.string().min(1).max(253).nullable(),
  inherited: z.boolean(),
  issue: componentIssueSchema.optional(),
  records: z.array(caaPolicyRecordSchema).max(32),
  source: componentSourceSchema,
  status: z.enum([
    'records',
    'no_record',
    'nxdomain',
    'servfail',
    'timeout',
    'failed',
    'rate_limited',
    'limit_exceeded',
  ]),
})

export const sslCheckDataSchema = z.strictObject({
  caa: caaInspectionSchema,
  normalizedQueryAscii: z.string().min(1).max(253),
  normalizedQueryUnicode: z.string().min(1).max(253),
  risks: z.array(domainRiskSchema),
  tls: tlsInspectionSchema,
})

export const sslCheckResultSchema = createResultSchema(sslCheckDataSchema)

export type CaaInspection = z.infer<typeof caaInspectionSchema>
export type SslCheckData = z.infer<typeof sslCheckDataSchema>
export type SslCheckRequest = z.infer<typeof sslCheckRequestSchema>
export type SslCheckResult = z.infer<typeof sslCheckResultSchema>
export type TlsCertificate = z.infer<typeof tlsCertificateSchema>
export type TlsFinding = z.infer<typeof tlsFindingSchema>
export type TlsInspection = z.infer<typeof tlsInspectionSchema>
