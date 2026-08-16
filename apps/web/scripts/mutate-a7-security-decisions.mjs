import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9a-consent-personal-information.integration.test.ts'
const schemaTest = 'tests/unit/a7-privacy-schemas.test.ts'
const routeTest = 'tests/unit/a7-privacy-routes.test.ts'
const consentLocalApiTest = 'tests/unit/a7-consent-local-api.test.ts'
const personalInformationTest = 'tests/unit/a7-personal-information-service.test.ts'
const auditTest = 'tests/unit/a7-audit-permissions.test.ts'
const registrationTest = 'tests/integration/d9a-identity-registration.integration.test.ts'

const mutations = [
  {
    group: 'access',
    id: 'phone-field-system-admin-role',
    file: 'src/access/roles.ts',
    search: "  if (hasRole(req.user, ['system_admin'])) return true\n",
    replacement: '  if (false) return true\n',
    occurrence: 2,
    expectedOccurrences: 5,
    testFile: schemaTest,
    test: 'reveals a customer phone only to that customer or a system administrator',
  },
  {
    group: 'access',
    id: 'phone-field-customer-principal',
    file: 'src/access/roles.ts',
    search: '  if (!isCustomerUser(req.user)) return false\n',
    replacement: '  if (false) return false\n',
    occurrence: 1,
    expectedOccurrences: 3,
    testFile: schemaTest,
    test: 'reveals a customer phone only to that customer or a system administrator',
  },
  {
    group: 'access',
    id: 'phone-field-customer-id-match',
    file: 'src/access/roles.ts',
    search: '  return String(targetId) === String(req.user.id)\n',
    replacement: '  return true\n',
    testFile: schemaTest,
    test: 'reveals a customer phone only to that customer or a system administrator',
  },
  {
    group: 'access',
    id: 'customer-phone-uses-self-or-system-field-access',
    file: 'src/collections/identity.ts',
    search: '      access: { read: customerSelfOrSystemFieldRead },\n',
    replacement: '      access: { read: sensitiveFieldRead },\n',
    test: 'isolates personal-information reads, excludes internal identity secrets, and audits customer/admin access',
  },
  {
    group: 'append-only',
    id: 'consent-update-hook-blocks-mutation',
    file: 'src/collections/identity.ts',
    search: "        if (operation === 'update') {\n",
    replacement: '        if (false) {\n',
    test: 'keeps consent records append-only even for overrideAccess system calls',
  },
  {
    group: 'append-only',
    id: 'consent-delete-hook-blocks-deletion',
    file: 'src/collections/identity.ts',
    search:
      "      () => {\n        throw new AppError('CONSENT_RECORD_APPEND_ONLY', '同意记录只允许追加', 409)\n      },\n",
    replacement: '      () => undefined,\n',
    test: 'keeps consent records append-only even for overrideAccess system calls',
  },
  {
    group: 'schema',
    id: 'consent-types-exact-eight',
    file: 'src/lib/domain.ts',
    search: "  'automatic_renewal',\n",
    replacement: '',
    test: 'defines exactly eight independently versioned and hashed consent documents',
  },
  {
    group: 'schema',
    id: 'optional-consent-types-exclude-mandatory-and-renewal',
    file: 'src/lib/domain.ts',
    search: 'export const CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES = [\n',
    replacement: "export const CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES = [\n  'service_terms',\n",
    testFile: schemaTest,
    test: 'limits privacy-center decisions to the five optional customer-managed types',
  },
  {
    group: 'schema',
    id: 'registration-requires-device-notice',
    file: 'src/schemas/auth.ts',
    search: '    acceptedDeviceIdentifierNotice: z.literal(true),\n',
    replacement: '    acceptedDeviceIdentifierNotice: z.literal(true).optional(),\n',
    testFile: schemaTest,
    test: 'requires the device-identifier notice and rejects unexpected registration fields',
  },
  {
    group: 'schema',
    id: 'registration-commercial-sms-default-off',
    file: 'src/schemas/auth.ts',
    search: '    commercialSmsOptIn: z.boolean().default(false),\n',
    replacement: '    commercialSmsOptIn: z.boolean().default(true),\n',
    testFile: schemaTest,
    test: 'defaults commercial SMS to false and accepts an explicit opt-in',
  },
  {
    group: 'schema',
    id: 'invitation-code-requires-attribution-consent',
    file: 'src/schemas/auth.ts',
    search: '    if (input.invitationCode && input.acceptedInvitationAttribution !== true) {\n',
    replacement: '    if (false) {\n',
    testFile: schemaTest,
    test: 'requires invitation-attribution consent exactly when an invitation code is present',
  },
  {
    group: 'schema',
    id: 'attribution-consent-requires-invitation-code',
    file: 'src/schemas/auth.ts',
    search:
      '    if (!input.invitationCode && input.acceptedInvitationAttribution !== undefined) {\n',
    replacement: '    if (false) {\n',
    testFile: schemaTest,
    test: 'requires invitation-attribution consent exactly when an invitation code is present',
  },
  {
    group: 'schema',
    id: 'registration-schema-remains-strict',
    file: 'src/schemas/auth.ts',
    search: '  .strict()\n  .superRefine((input, context) => {\n',
    replacement: '  .superRefine((input, context) => {\n',
    testFile: schemaTest,
    test: 'requires the device-identifier notice and rejects unexpected registration fields',
  },
  {
    group: 'schema',
    id: 'consent-decision-schema-remains-strict',
    file: 'src/schemas/privacy.ts',
    search: "    decision: z.enum(['accept', 'revoke']),\n  })\n  .strict()\n",
    replacement: "    decision: z.enum(['accept', 'revoke']),\n  })\n",
    testFile: schemaTest,
    test: 'limits privacy-center decisions to the five optional customer-managed types',
  },
  ...[
    'acceptedPrivacyPolicy',
    'acceptedServiceTerms',
    'confirmsAdultOrAuthorizedRepresentative',
  ].map((field) => ({
    group: 'schema',
    id: `legacy-completion-requires-${field}`,
    file: 'src/schemas/privacy.ts',
    search: `    ${field}: z.literal(true),\n`,
    replacement: `    ${field}: z.literal(true).optional(),\n`,
    testFile: schemaTest,
    test: 'requires real terms, privacy, eligibility declarations, and a default type for legacy completion',
  })),
  {
    group: 'schema',
    id: 'legacy-completion-requires-default-type',
    file: 'src/schemas/privacy.ts',
    search: "    defaultCustomerProfileType: z.enum(['individual', 'organization']),\n",
    replacement:
      "    defaultCustomerProfileType: z.enum(['individual', 'organization']).optional(),\n",
    expectedOccurrences: 1,
    testFile: schemaTest,
    test: 'requires real terms, privacy, eligibility declarations, and a default type for legacy completion',
  },
  {
    group: 'schema',
    id: 'admin-purpose-trims-whitespace',
    file: 'src/schemas/privacy.ts',
    search: '  purpose: z.string().trim().min(3).max(256),\n',
    replacement: '  purpose: z.string().min(3).max(256),\n',
    testFile: schemaTest,
    test: 'requires a bounded, non-blank purpose for admin personal-information access',
  },
  {
    group: 'schema',
    id: 'admin-purpose-minimum-length',
    file: 'src/schemas/privacy.ts',
    search: '  purpose: z.string().trim().min(3).max(256),\n',
    replacement: '  purpose: z.string().trim().max(256),\n',
    testFile: schemaTest,
    test: 'requires a bounded, non-blank purpose for admin personal-information access',
  },
  {
    group: 'schema',
    id: 'admin-purpose-maximum-length',
    file: 'src/schemas/privacy.ts',
    search: '  purpose: z.string().trim().min(3).max(256),\n',
    replacement: '  purpose: z.string().trim().min(3),\n',
    testFile: schemaTest,
    test: 'requires a bounded, non-blank purpose for admin personal-information access',
  },
  {
    group: 'document',
    id: 'privacy-document-slug-mapping',
    file: 'src/services/auth/registration-consents.ts',
    search: "  return type === 'privacy_policy' ? 'privacy' : 'terms'\n",
    replacement: "  return 'terms'\n",
    test: 'defines exactly eight independently versioned and hashed consent documents',
  },
  {
    group: 'document',
    id: 'legal-document-missing-fails-closed',
    file: 'src/services/auth/registration-consents.ts',
    search:
      '    if (!document) throw new Error(`Registration legal document is missing: ${type}`)\n',
    replacement: "    if (!document) throw new Error('wrong missing-document error')\n",
    testFile: schemaTest,
    test: 'fails closed with the missing legal document named in the error',
  },
  {
    group: 'document',
    id: 'document-hash-binds-content',
    file: 'src/services/auth/registration-consents.ts',
    search:
      "    documentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),\n",
    replacement: "    documentHash: createHash('sha256').update('{}').digest('hex'),\n",
    test: 'defines exactly eight independently versioned and hashed consent documents',
  },
  {
    group: 'document',
    id: 'document-version-binds-type',
    file: 'src/services/auth/registration-consents.ts',
    search: '    documentVersion: versions[type],\n',
    replacement: '    documentVersion: versions.service_terms,\n',
    test: 'defines exactly eight independently versioned and hashed consent documents',
  },
  {
    group: 'registration',
    id: 'login-computes-legacy-profile-flag',
    file: 'src/services/auth/customer-identities.ts',
    search:
      '  const profileCompletionRequired = await customerNeedsLegacyProfileCompletion(req, customer)\n',
    replacement: '  const profileCompletionRequired = false\n',
    test: 'flags a legacy account at login without inventing consent records',
  },
  {
    group: 'registration',
    id: 'registration-records-device-notice',
    file: 'src/services/auth/customer-identities.ts',
    search:
      "  const consentTypes = ['service_terms', 'privacy_policy', 'device_identifier_notice'] as const\n",
    replacement: "  const consentTypes = ['service_terms', 'privacy_policy'] as const\n",
    testFile: registrationTest,
    test: 'does not create an account at OTP verification and records explicit registration consents',
  },
  {
    group: 'registration',
    id: 'registration-invitation-consent-branch',
    file: 'src/services/auth/customer-identities.ts',
    search: '      if (input.invitationCode) {\n',
    replacement: '      if (false) {\n',
    testFile: registrationTest,
    test: 'does not create an account at OTP verification and records explicit registration consents',
  },
  {
    group: 'registration',
    id: 'registration-commercial-opt-in-branch',
    file: 'src/services/auth/customer-identities.ts',
    search: '      if (input.commercialSmsOptIn) {\n',
    replacement: '      if (false) {\n',
    testFile: registrationTest,
    test: 'records commercial SMS consent only after explicit registration opt-in',
  },
  {
    group: 'resolution',
    id: 'current-consent-matches-type',
    file: 'src/services/privacy/customer-consents.ts',
    search: '  return records.find((record) => record.consentType === consentType)\n',
    replacement: '  return records.find(() => true)\n',
    test: 'never reuses another customer or another consent type when resolving current consent',
  },
  {
    group: 'resolution',
    id: 'current-document-hash-matches',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    record.documentHash === current.documentHash &&\n',
    replacement: '    true &&\n',
    test: 'fails closed for wrong document hash when checking a required separate consent',
  },
  {
    group: 'resolution',
    id: 'current-document-version-matches',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    record.documentVersion === current.documentVersion\n',
    replacement: '    true\n',
    test: 'fails closed for wrong document version when checking a required separate consent',
  },
  {
    group: 'resolution',
    id: 'active-consent-requires-record',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  return Boolean(record && !record.revokedAt && consentMatchesCurrentDocument(record))\n',
    replacement:
      '  return Boolean(true && !record?.revokedAt && (record ? consentMatchesCurrentDocument(record) : true))\n',
    test: 'fails closed for missing record when checking a required separate consent',
  },
  {
    group: 'resolution',
    id: 'active-consent-rejects-revocation',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  return Boolean(record && !record.revokedAt && consentMatchesCurrentDocument(record))\n',
    replacement: '  return Boolean(record && true && consentMatchesCurrentDocument(record))\n',
    test: 'fails closed for revoked record when checking a required separate consent',
  },
  {
    group: 'resolution',
    id: 'active-consent-requires-current-document',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  return Boolean(record && !record.revokedAt && consentMatchesCurrentDocument(record))\n',
    replacement: '  return Boolean(record && !record.revokedAt && true)\n',
    test: 'fails closed for wrong document hash when checking a required separate consent',
  },
  {
    group: 'local-api',
    id: 'consent-history-customer-path-does-not-bypass-access',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    overrideAccess: user ? false : true,\n',
    replacement: '    overrideAccess: true,\n',
    testFile: consentLocalApiTest,
    test: 'uses owner access, stable newest-first ordering, and a customer-scoped where clause',
  },
  {
    group: 'local-api',
    id: 'consent-history-passes-user',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    ...(user ? { user } : {}),\n',
    replacement: '    ...(user ? {} : {}),\n',
    testFile: consentLocalApiTest,
    test: 'uses owner access, stable newest-first ordering, and a customer-scoped where clause',
  },
  {
    group: 'local-api',
    id: 'consent-history-is-customer-scoped',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    where: { customer: { equals: customerIdValue } },\n',
    replacement: '',
    testFile: consentLocalApiTest,
    test: 'uses owner access, stable newest-first ordering, and a customer-scoped where clause',
  },
  {
    group: 'local-api',
    id: 'consent-history-newest-record-first',
    file: 'src/services/privacy/customer-consents.ts',
    search: "    sort: '-id',\n",
    replacement: "    sort: 'id',\n",
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'actor',
    id: 'consent-change-requires-customer-principal',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  if (isCustomerUser(req.user) && String(req.user.id) === String(customer.id)) return\n',
    replacement: '  if (true && String(req.user?.id) === String(customer.id)) return\n',
    test: 'rejects anonymous, cross-customer, non-managed, and malformed-version consent changes',
  },
  {
    group: 'actor',
    id: 'consent-change-requires-customer-id-match',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  if (isCustomerUser(req.user) && String(req.user.id) === String(customer.id)) return\n',
    replacement: '  if (isCustomerUser(req.user) && true) return\n',
    test: 'rejects anonymous, cross-customer, non-managed, and malformed-version consent changes',
  },
  {
    group: 'version',
    id: 'consent-version-requires-safe-integer',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  if (Number.isSafeInteger(customer.consentStateVersion) && version >= 0) return version\n',
    replacement: '  if (true && version >= 0) return version\n',
    test: 'rejects anonymous, cross-customer, non-managed, and malformed-version consent changes',
  },
  {
    group: 'version',
    id: 'consent-version-requires-nonnegative',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  if (Number.isSafeInteger(customer.consentStateVersion) && version >= 0) return version\n',
    replacement:
      '  if (Number.isSafeInteger(customer.consentStateVersion) && true) return version\n',
    test: 'rejects anonymous, cross-customer, non-managed, and malformed-version consent changes',
  },
  {
    group: 'version',
    id: 'consent-cas-miss-throws-conflict',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      "  if (claimed.rows?.[0]?.id === undefined) {\n    throw new AppError('CONSENT_STATE_CONFLICT', '同意状态已变化，请刷新后重试', 409)\n  }\n",
    replacement: '',
    test: 'CAS consent writes constrain customer id, expected version, allowed status, and returned claim',
  },
  {
    group: 'version',
    id: 'consent-noop-stale-read-throws-conflict',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      "  if (current.rows?.[0]?.id === undefined) {\n    throw new AppError('CONSENT_STATE_CONFLICT', '同意状态已变化，请刷新后重试', 409)\n  }\n",
    replacement: '',
    test: 'validates no-op consent reads against the same customer id, version, and allowed status',
  },
  {
    group: 'legacy',
    id: 'nonlegacy-account-never-needs-backfill',
    file: 'src/services/privacy/customer-consents.ts',
    search: "  if (customer.accountType !== 'legacy_unknown') return false\n",
    replacement: '  if (false) return false\n',
    test: 'allows registration after legacy completion has current terms and privacy evidence',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-requires-default-profile',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  if (!customer.defaultCustomerProfileType || !customer.legacyProfileCompletedAt) return true\n',
    replacement: '  if (false || !customer.legacyProfileCompletedAt) return true\n',
    test: 'keeps legacy completion required when only default customer type is missing',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-requires-completion-time',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  if (!customer.defaultCustomerProfileType || !customer.legacyProfileCompletedAt) return true\n',
    replacement: '  if (!customer.defaultCustomerProfileType || false) return true\n',
    test: 'keeps legacy completion required when only completion timestamp is missing',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-requires-current-service-terms',
    file: 'src/services/privacy/customer-consents.ts',
    search: "const REQUIRED_CONSENT_TYPES = ['service_terms', 'privacy_policy'] as const\n",
    replacement: "const REQUIRED_CONSENT_TYPES = ['privacy_policy'] as const\n",
    test: 'keeps legacy completion required when only current service-terms evidence is missing',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-requires-current-privacy-policy',
    file: 'src/services/privacy/customer-consents.ts',
    search: "const REQUIRED_CONSENT_TYPES = ['service_terms', 'privacy_policy'] as const\n",
    replacement: "const REQUIRED_CONSENT_TYPES = ['service_terms'] as const\n",
    test: 'keeps legacy completion required when only current privacy-policy evidence is missing',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-checks-required-consents',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  return REQUIRED_CONSENT_TYPES.some(\n    (consentType) => !consentIsActive(currentConsent(records, consentType)),\n  )\n',
    replacement: '  return false\n',
    test: 'keeps legacy completion required when only current service-terms evidence is missing',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-invokes-actor-guard',
    file: 'src/services/privacy/customer-consents.ts',
    search: '  assertCustomerActor(req, customer)\n',
    replacement: '',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'rejects legacy completion for the wrong actor, non-legacy provenance, and completed snapshots',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-requires-legacy-account-type',
    file: 'src/services/privacy/customer-consents.ts',
    search: "    customer.accountType !== 'legacy_unknown' ||\n",
    replacement: '    false ||\n',
    test: 'rejects legacy completion for the wrong actor, non-legacy provenance, and completed snapshots',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-requires-legacy-registration-source',
    file: 'src/services/privacy/customer-consents.ts',
    search: "    customer.registrationSource !== 'legacy_unknown'\n",
    replacement: '    false\n',
    test: 'rejects legacy completion for the wrong actor, non-legacy provenance, and completed snapshots',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-rejects-already-completed-snapshot',
    file: 'src/services/privacy/customer-consents.ts',
    search: '  if (customer.legacyProfileCompletedAt) {\n',
    replacement: '  if (false) {\n',
    test: 'rejects legacy completion for the wrong actor, non-legacy provenance, and completed snapshots',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-cas-miss-throws-conflict',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      "    if (claimed.rows?.[0]?.id === undefined) {\n      throw new AppError(\n        'LEGACY_PROFILE_COMPLETION_CONFLICT',\n        '历史资料状态已变化，请刷新后重试',\n        409,\n      )\n    }\n",
    replacement: '',
    test: 'completion CAS rejects a stale consent version database predicate',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-appends-both-required-consents',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    for (const consentType of REQUIRED_CONSENT_TYPES) {\n',
    replacement: "    for (const consentType of ['service_terms'] as const) {\n",
    test: 'allows exactly one of 8 legacy completions and records real evidence without rewriting provenance',
  },
  {
    group: 'legacy',
    id: 'legacy-completion-records-audit',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      "    await recordAuditEvent(req, {\n      action: 'customer.legacy_profile.completed',\n",
    replacement:
      "    if (false) await recordAuditEvent(req, {\n      action: 'customer.legacy_profile.completed',\n",
    test: 'allows exactly one of 8 legacy completions and records real evidence without rewriting provenance',
  },
  {
    group: 'decision',
    id: 'privacy-center-rejects-nonmanaged-type',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '  if (!(CUSTOMER_MANAGED_OPTIONAL_CONSENT_TYPES as readonly string[]).includes(input.consentType)) {\n',
    replacement: '  if (false) {\n',
    test: 'rejects anonymous, cross-customer, non-managed, and malformed-version consent changes',
  },
  {
    group: 'decision',
    id: 'consent-decision-invokes-actor-guard',
    file: 'src/services/privacy/customer-consents.ts',
    search: '  assertCustomerActor(req, customer)\n',
    replacement: '',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'rejects anonymous, cross-customer, non-managed, and malformed-version consent changes',
  },
  {
    group: 'decision',
    id: 'active-acceptance-is-noop-only-for-accept',
    file: 'src/services/privacy/customer-consents.ts',
    search: "  if (input.decision === 'accept' && active) {\n",
    replacement: '  if (true && active) {\n',
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'decision',
    id: 'active-acceptance-noop-requires-active',
    file: 'src/services/privacy/customer-consents.ts',
    search: "  if (input.decision === 'accept' && active) {\n",
    replacement: "  if (input.decision === 'accept' && true) {\n",
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'decision',
    id: 'inactive-revocation-is-noop-only-for-revoke',
    file: 'src/services/privacy/customer-consents.ts',
    search: "  if (input.decision === 'revoke' && !active) {\n",
    replacement: '  if (true && !active) {\n',
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'decision',
    id: 'inactive-revocation-noop-requires-inactive',
    file: 'src/services/privacy/customer-consents.ts',
    search: "  if (input.decision === 'revoke' && !active) {\n",
    replacement: "  if (input.decision === 'revoke' && true) {\n",
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'decision',
    id: 'changed-consent-claims-version',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      '    await claimConsentStateVersion(req, { customerId: customer.id, expectedVersion })\n',
    replacement: '',
    test: 'allows exactly one of 8 concurrent consent writes',
  },
  {
    group: 'decision',
    id: 'acceptance-and-revocation-use-correct-write-branch',
    file: 'src/services/privacy/customer-consents.ts',
    search: "    if (input.decision === 'accept') {\n",
    replacement: "    if (input.decision === 'revoke') {\n",
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'decision',
    id: 'consent-decision-records-audit',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    await recordAuditEvent(req, {\n      action:\n',
    replacement: '    if (false) await recordAuditEvent(req, {\n      action:\n',
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'decision',
    id: 'consent-audit-action-matches-decision',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      "        input.decision === 'accept' ? 'customer.consent.accepted' : 'customer.consent.revoked',\n",
    replacement: "        true ? 'customer.consent.accepted' : 'customer.consent.revoked',\n",
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'decision',
    id: 'consent-response-active-matches-decision',
    file: 'src/services/privacy/customer-consents.ts',
    search: "      active: input.decision === 'accept',\n",
    replacement: '      active: true,\n',
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'surface',
    id: 'realname-create-requires-sensitive-consent',
    file: 'src/services/realname/templates.ts',
    search:
      "  await assertCustomerConsentActive(req, customer.id, 'sensitive_personal_information')\n",
    replacement: '',
    test: 'requires sensitive-personal-information consent before creating a real-name template',
  },
  {
    group: 'surface',
    id: 'assert-consent-active-fails-closed',
    file: 'src/services/privacy/customer-consents.ts',
    search: '  if (consentIsActive(currentConsent(records, consentType))) return\n',
    replacement: '  return\n',
    test: 'requires sensitive-personal-information consent before creating a real-name template',
  },
  {
    group: 'surface',
    id: 'commercial-opt-in-reads-commercial-type',
    file: 'src/services/privacy/customer-consents.ts',
    search: "  return consentIsActive(currentConsent(records, 'commercial_sms'))\n",
    replacement: "  return consentIsActive(currentConsent(records, 'wechat_profile'))\n",
    test: 'defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately',
  },
  {
    group: 'surface',
    id: 'legacy-purchase-load-does-not-bypass-access',
    file: 'src/services/privacy/customer-consents.ts',
    search:
      "    collection: 'customers',\n    depth: 0,\n    id: customerId,\n    overrideAccess: false,\n",
    replacement:
      "    collection: 'customers',\n    depth: 0,\n    id: customerId,\n    overrideAccess: true,\n",
    testFile: consentLocalApiTest,
    test: 'passes user, req, and overrideAccess false when loading a legacy purchase customer',
  },
  {
    group: 'surface',
    id: 'legacy-purchase-load-passes-user',
    file: 'src/services/privacy/customer-consents.ts',
    search: '    user: req.user,\n',
    replacement: '',
    testFile: consentLocalApiTest,
    test: 'passes user, req, and overrideAccess false when loading a legacy purchase customer',
  },
  {
    group: 'surface',
    id: 'incomplete-legacy-purchase-rejected',
    file: 'src/services/privacy/customer-consents.ts',
    search: '  if (!(await customerNeedsLegacyProfileCompletion(req, customer))) return\n',
    replacement: '  return\n',
    test: 'blocks only new registration orders while a legacy profile is incomplete',
  },
  {
    group: 'surface',
    id: 'order-gate-applies-only-to-registration',
    file: 'src/services/commerce/order-creation.ts',
    search:
      "    if (quote.operation === 'registration') {\n      await assertLegacyRegistrationPurchaseAllowed(req, options.customer.id)\n    }\n",
    replacement: '    await assertLegacyRegistrationPurchaseAllowed(req, options.customer.id)\n',
    test: 'blocks only new registration orders while a legacy profile is incomplete',
  },
  {
    group: 'surface',
    id: 'registration-order-invokes-legacy-gate',
    file: 'src/services/commerce/order-creation.ts',
    search: '      await assertLegacyRegistrationPurchaseAllowed(req, options.customer.id)\n',
    replacement: '',
    test: 'blocks only new registration orders while a legacy profile is incomplete',
  },
  {
    group: 'personal-access',
    id: 'personal-access-requires-customer-or-admin-customer-branch',
    file: 'src/services/privacy/personal-information.ts',
    search: '  if (!isCustomerUser(req.user) && !isAdminUser(req.user)) {\n',
    replacement: '  if (false && !isAdminUser(req.user)) {\n',
    test: 'isolates personal-information reads, excludes internal identity secrets, and audits customer/admin access',
  },
  {
    group: 'personal-access',
    id: 'personal-access-requires-customer-or-admin-admin-branch',
    file: 'src/services/privacy/personal-information.ts',
    search: '  if (!isCustomerUser(req.user) && !isAdminUser(req.user)) {\n',
    replacement: '  if (!isCustomerUser(req.user) && false) {\n',
    test: 'isolates personal-information reads, excludes internal identity secrets, and audits customer/admin access',
  },
  ...[
    ['customers', 'findByID'],
    ['customerIdentities', 'find'],
    ['consentRecords', 'find'],
    ['realnameTemplates', 'find'],
    ['realnameDocuments', 'find'],
    ['orders', 'find'],
    ['domainAssets', 'find'],
  ].flatMap(([collection, method], index) => [
    {
      group: 'personal-local-api',
      id: `${collection}-read-does-not-bypass-access`,
      file: 'src/services/privacy/personal-information.ts',
      search: 'overrideAccess: false,\n',
      replacement: 'overrideAccess: true,\n',
      occurrence: index + 1,
      expectedOccurrences: 7,
      testFile: personalInformationTest,
      test: 'passes user, req, overrideAccess false, and an owner where clause to every personal-data read',
    },
    {
      group: 'personal-local-api',
      id: `${collection}-read-passes-user`,
      file: 'src/services/privacy/personal-information.ts',
      search: 'user,\n',
      replacement: '',
      occurrence: index + 1,
      expectedOccurrences: 7,
      testFile: personalInformationTest,
      test: 'passes user, req, overrideAccess false, and an owner where clause to every personal-data read',
    },
    ...(method === 'find'
      ? [
          {
            group: 'personal-local-api',
            id: `${collection}-read-is-customer-scoped`,
            file: 'src/services/privacy/personal-information.ts',
            search: '        where,\n',
            replacement: '',
            occurrence: index,
            expectedOccurrences: 6,
            testFile: personalInformationTest,
            test: 'passes user, req, overrideAccess false, and an owner where clause to every personal-data read',
          },
        ]
      : []),
  ]),
  {
    group: 'personal-audit',
    id: 'personal-audit-action-matches-mode',
    file: 'src/services/privacy/personal-information.ts',
    search: "      input.mode === 'export'\n",
    replacement: '      false\n',
    testFile: personalInformationTest,
    test: 'records the selected view/export action, explicit/default purpose, and bounded result counts',
  },
  {
    group: 'personal-audit',
    id: 'personal-audit-default-purpose',
    file: 'src/services/privacy/personal-information.ts',
    search: "      purpose: input.purpose ?? 'customer_self_service',\n",
    replacement: "      purpose: input.purpose ?? 'wrong-default',\n",
    testFile: personalInformationTest,
    test: 'records the selected view/export action, explicit/default purpose, and bounded result counts',
  },
  {
    group: 'personal-audit',
    id: 'personal-access-records-audit',
    file: 'src/services/privacy/personal-information.ts',
    search: '  await recordAuditEvent(req, {\n',
    replacement: '  if (false) await recordAuditEvent(req, {\n',
    testFile: personalInformationTest,
    test: 'records the selected view/export action, explicit/default purpose, and bounded result counts',
  },
  ...[
    ['customer.consent.accepted', "['customer']", "['customer', 'admin', 'system']"],
    ['customer.consent.revoked', "['customer']", "['customer', 'admin', 'system']"],
    ['customer.legacy_profile.completed', "['customer']", "['customer', 'admin', 'system']"],
    [
      'customer.personal_information.exported',
      "['admin', 'customer']",
      "['admin', 'customer', 'anonymous', 'system']",
    ],
    [
      'customer.personal_information.viewed',
      "['admin', 'customer']",
      "['admin', 'customer', 'anonymous', 'system']",
    ],
  ].map(([action, allowed, weakened]) => ({
    group: 'audit-permission',
    id: `${action}-actor-types`,
    file: 'src/services/audit/record-audit-event.ts',
    search: `  '${action}': {\n    actorTypes: ${allowed},\n`,
    replacement: `  '${action}': {\n    actorTypes: ${weakened},\n`,
    testFile: auditTest,
    test: 'keeps consent/profile actions customer-only and personal-data actions admin-or-customer',
  })),
  {
    group: 'route',
    id: 'admin-customer-id-safe-integer',
    file: 'src/app/api/v1/admin/customers/[customerId]/personal-information/route.ts',
    search: '    if (!Number.isSafeInteger(customerId) || customerId <= 0) {\n',
    replacement: '    if (false || customerId <= 0) {\n',
    testFile: routeTest,
    test: 'rejects invalid admin customer id 1.5 before auth',
  },
  {
    group: 'route',
    id: 'admin-customer-id-positive',
    file: 'src/app/api/v1/admin/customers/[customerId]/personal-information/route.ts',
    search: '    if (!Number.isSafeInteger(customerId) || customerId <= 0) {\n',
    replacement: '    if (!Number.isSafeInteger(customerId) || false) {\n',
    testFile: routeTest,
    test: 'rejects invalid admin customer id 0 before auth',
  },
  {
    group: 'route',
    id: 'admin-route-requires-purpose',
    file: 'src/app/api/v1/admin/customers/[customerId]/personal-information/route.ts',
    search:
      "    const query = adminPersonalInformationQuerySchema.parse({\n      purpose: new URL(request.url).searchParams.get('purpose'),\n    })\n",
    replacement: "    const query = { purpose: 'missing-purpose-bypassed' }\n",
    testFile: routeTest,
    test: 'requires an explicit admin access purpose before authentication',
  },
  {
    group: 'route',
    id: 'admin-route-invokes-system-admin-gate',
    file: 'src/app/api/v1/admin/customers/[customerId]/personal-information/route.ts',
    search: '    const { req } = await systemAdminRequest(payload, request)\n',
    replacement:
      "    const req = { user: { collection: 'admins', id: 7, roles: ['system_admin'], status: 'active' } } as never\n",
    testFile: routeTest,
    test: 'fails closed at the system-admin gate and never reads personal information',
  },
  ...[
    ['src/app/api/v1/account/consents/route.ts', 'recordCustomerConsentDecision'],
    ['src/app/api/v1/account/legacy-profile-completion/route.ts', 'completeLegacyCustomerProfile'],
    ['src/app/api/v1/account/personal-information/route.ts', 'readPersonalInformation'],
    ['src/app/api/v1/account/personal-information/export/route.ts', 'readPersonalInformation'],
  ].map(([file, service]) => ({
    group: 'route',
    id: `${file.split('/').slice(-2, -1)[0]}-${file.includes('/export/') ? 'export-' : ''}customer-auth-gate`,
    file,
    search: '    const { req, user } = await authenticatedCustomerRequest(payload, request)\n',
    replacement:
      "    const req = {} as never\n    const user = { collection: 'customers', id: 42 } as never\n",
    testFile: routeTest,
    test: 'fails closed at the customer-session gate for every self-service A7 route',
    service,
  })),
]

function occurrences(source, search) {
  return source.split(search).length - 1
}

function replaceOccurrence(source, search, replacement, occurrence) {
  let seen = 0
  return source.replaceAll(search, (match) => {
    seen += 1
    return seen === occurrence ? replacement : match
  })
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

function rawFailure(output) {
  const lines = stripAnsi(output).split('\n')
  const index = lines.findIndex((line) => line.includes('AssertionError:'))
  if (index >= 0)
    return lines
      .slice(index, index + 4)
      .join('\n')
      .trim()
  return lines.slice(-12).join('\n').trim()
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.file}\t${mutation.test}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}

const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations

if (!selected.length) {
  process.stderr.write(`No mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
const killedByGroup = new Map()
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  const found = occurrences(original, mutation.search)
  const expected = mutation.expectedOccurrences ?? 1
  if (found !== expected) {
    process.stderr.write(
      `MUTATION SETUP FAILED ${mutation.id}: expected ${expected} occurrences, found ${found}\n`,
    )
    failed = true
    continue
  }

  const mutated = replaceOccurrence(
    original,
    mutation.search,
    mutation.replacement,
    mutation.occurrence ?? 1,
  )
  if (mutated === original) {
    process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: source was unchanged\n`)
    failed = true
    continue
  }

  let result
  try {
    writeFileSync(path, mutated, 'utf8')
    result = spawnSync(
      'pnpm',
      [
        '--filter',
        '@wanmi/web',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.config.mts',
        mutation.testFile ?? integrationTest,
        '-t',
        mutation.test,
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }

  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim()
  const behaviorFailure = stripAnsi(output).includes('AssertionError:')
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.testFile ?? integrationTest} :: ${mutation.test}\n`)
  process.stdout.write(`RAW_FAILURE ${rawFailure(output)}\n`)
  if (result?.status !== 0 && behaviorFailure) {
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
    killedByGroup.set(mutation.group, (killedByGroup.get(mutation.group) ?? 0) + 1)
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write('\nMUTATION_MATRIX_SUMMARY\n')
for (const group of [...new Set(selected.map((mutation) => mutation.group))]) {
  const total = selected.filter((mutation) => mutation.group === group).length
  process.stdout.write(`${group}\t${killedByGroup.get(group) ?? 0}/${total}\n`)
}
process.stdout.write(
  `TOTAL\t${[...killedByGroup.values()].reduce((total, count) => total + count, 0)}/${selected.length}\n`,
)

if (failed) process.exitCode = 1
