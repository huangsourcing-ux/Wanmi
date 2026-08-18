import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integration = 'tests/integration/d9c2-automatic-renewals.integration.test.ts'
const routes = 'tests/unit/d9c2-renewal-mandate-routes.test.ts'
const rules = 'tests/unit/d9c2-automatic-renewal-rules.test.ts'
const provider = 'tests/unit/westdigital-write.test.ts'

const files = {
  automatic: 'src/services/domains/automatic-renewals.ts',
  collections: 'src/collections/fulfillment.ts',
  fulfillment: 'src/services/commerce/fulfillment.ts',
  mandate: 'src/services/domains/renewal-mandates.ts',
  provider: 'src/providers/westdigital-write.ts',
  rules: 'src/services/domains/automatic-renewal-rules.ts',
  schema: 'src/schemas/domains.ts',
}

const mutations = []
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })
const add = (file, group, id, predicate, testFile, test, edits) =>
  mutations.push({ edits, file, group, id, predicate, test, testFile })

const boundary =
  'requires a finite positive maximum, bounded validity, and literal second confirmation'
for (const [id, search, replacement, predicate] of [
  [
    'schema-max-positive',
    'maxDebitFen: z.number().int().positive(),',
    'maxDebitFen: z.number().int().nonnegative(),',
    'authorization maximum is strictly positive',
  ],
  [
    'schema-max-safe-integer',
    'maxDebitFen: z.number().int().positive(),',
    'maxDebitFen: z.number().positive(),',
    'authorization maximum is a safe integer number of fen',
  ],
  [
    'schema-scope-literal',
    "export const renewalMandateScopeSchema = z.literal('renew_one_year')",
    'export const renewalMandateScopeSchema = z.string()',
    'authorization scope is exactly one-year renewal',
  ],
  [
    'schema-validity-required',
    '    validUntil: z.iso.datetime(),\n',
    '    validUntil: z.iso.datetime().optional(),\n',
    'authorization validity is mandatory',
  ],
  [
    'schema-confirmed-literal',
    '  confirmed: z.literal(true),\n',
    '  confirmed: z.boolean(),\n',
    'the second confirmation must be literal true',
  ],
  [
    'schema-device-min',
    'const renewalMandateStepUpSchema = z.strictObject({\n  confirmed: z.literal(true),\n  deviceId: z.string().min(16).max(128),\n',
    'const renewalMandateStepUpSchema = z.strictObject({\n  confirmed: z.literal(true),\n  deviceId: z.string().min(1).max(128),\n',
    'step-up device binding has a minimum length',
  ],
  [
    'schema-preview-min',
    '  previewToken: z.string().min(80).max(4_096),\n',
    '  previewToken: z.string().min(1).max(4_096),\n',
    'bound preview token has a minimum length',
  ],
  [
    'schema-preview-max',
    '  previewToken: z.string().min(80).max(4_096),\n',
    '  previewToken: z.string().min(80).max(4_097),\n',
    'bound preview token has a maximum length',
  ],
  [
    'schema-stepup-format',
    '  previewToken: z.string().min(80).max(4_096),\n  stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n})\n',
    '  previewToken: z.string().min(80).max(4_096),\n  stepUpToken: z.string().min(1),\n})\n',
    'step-up token has the opaque-token format',
  ],
]) {
  const options = id === 'schema-confirmed-literal' ? { expectedOccurrences: 2, occurrence: 1 } : {}
  add(files.schema, 'request-boundary', id, predicate, routes, boundary, [
    edit(search, replacement, options),
  ])
}

for (const [id, search, replacement, predicate] of [
  [
    'attempt-negative-expiry',
    '  if (!Number.isFinite(remainingMs) || remainingMs < 0) return undefined\n',
    '  if (!Number.isFinite(remainingMs) || false) return undefined\n',
    'an already expired date has no ordinary renewal slot',
  ],
  [
    'attempt-ceiling-day',
    '  const remainingDays = Math.ceil(remainingMs / 86_400_000)\n',
    '  const remainingDays = Math.floor(remainingMs / 86_400_000)\n',
    'attempt windows do not start early because partial days round up',
  ],
  [
    'attempt-most-recent-slot',
    '  return slots.filter((slot) => remainingDays <= slot).at(-1)\n',
    '  return slots.filter((slot) => remainingDays <= slot).at(0)\n',
    'the first and retry slots remain distinct',
  ],
]) {
  add(
    files.rules,
    'attempt-rules',
    id,
    predicate,
    rules,
    'defines the first attempt and each retry as explicit date slots',
    [edit(search, replacement)],
  )
}

const access = 'requires the authenticated owner and the shared domain-write capability'
add(
  files.mandate,
  'mandate-preview',
  'preview-principal-callpoint',
  'preview requires the authenticated customer at its own callpoint',
  integration,
  access,
  [
    edit('  assertCustomer(req, options.customer)\n', '  void options.customer\n', {
      expectedOccurrences: 3,
      occurrence: 2,
    }),
  ],
)
add(
  files.mandate,
  'mandate-preview',
  'preview-a3-callpoint',
  'preview requires the shared domain-write capability',
  integration,
  access,
  [
    edit(
      "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n",
      '',
      { expectedOccurrences: 2, occurrence: 1 },
    ),
  ],
)
add(
  files.mandate,
  'mandate-preview',
  'preview-owned-source-replacement',
  'asset lookup uses access-controlled Local API plus explicit owner predicate',
  integration,
  access,
  [
    edit('    overrideAccess: false,\n', '    overrideAccess: true,\n'),
    edit('    user: customer,\n', ''),
    edit(
      '    where: { and: [{ id: { equals: assetId } }, { customer: { equals: customer.id } }] },\n',
      '    where: { id: { equals: assetId } },\n',
    ),
  ],
)
add(
  files.mandate,
  'mandate-source',
  'current-mandate-revision-source',
  'current mandate reads the highest immutable revision',
  integration,
  'revoked mandate independently skips without any debit',
  [edit("    sort: '-revision',\n", "    sort: 'revision',\n")],
)

const invalidMax = 'rejects empty, zero, negative, infinite, and deployment-unbounded debit limits'
add(
  files.mandate,
  'mandate-preview',
  'preview-deployment-max',
  'preview compares the requested maximum with the configured finite ceiling',
  integration,
  invalidMax,
  [
    edit(
      '    if (amount <= 0n || amount > rules.mandateMaxFen) {\n',
      '    if (amount <= 0n || false) {\n',
    ),
  ],
)
const invalidValidity =
  'rejects expired or overlong validity, inactive enablement, and revoke without an active mandate'
for (const [id, search, replacement, predicate] of [
  [
    'preview-validity-future',
    '      validUntilMs <= now.getTime() ||\n',
    '      false ||\n',
    'preview validity must end in the future',
  ],
  [
    'preview-validity-bounded',
    '      validUntilMs - now.getTime() > AUTOMATIC_RENEWAL_MANDATE_MAX_VALIDITY_MS\n',
    '      false\n',
    'preview validity cannot be unbounded',
  ],
  [
    'preview-active-asset',
    "    if (asset.status !== 'active') {\n",
    '    if (false) {\n',
    'enablement requires an active asset',
  ],
  [
    'preview-revoke-existence',
    "  } else if (!current || current.eventType !== 'authorized') {\n",
    "  } else if (current && current.eventType !== 'authorized') {\n",
    'revoke requires an existing mandate',
  ],
  [
    'preview-revoke-event-source',
    "  } else if (!current || current.eventType !== 'authorized') {\n",
    '  } else if (!current) {\n',
    'revoke reads the latest event type instead of inferring validity from existence',
  ],
]) {
  const options = id.startsWith('preview-validity-')
    ? { expectedOccurrences: 2, occurrence: 1 }
    : {}
  add(files.mandate, 'mandate-preview', id, predicate, integration, invalidValidity, [
    edit(search, replacement, options),
  ])
}

const binding =
  'binds preview to customer, asset, action, rules and expiry before consuming step-up'
for (const [id, search, replacement, predicate] of [
  [
    'change-bound-asset',
    '    String(decoded.assetId) !== String(assetId) ||\n',
    '    false ||\n',
    'change preview is bound to the requested asset',
  ],
  [
    'change-bound-customer',
    '    String(decoded.customerId) !== String(options.customer.id) ||\n',
    '    false ||\n',
    'change preview is bound to the customer',
  ],
  [
    'change-bound-action',
    '    decoded.action !== options.expectedAction ||\n',
    '    false ||\n',
    'PUT and DELETE cannot exchange preview actions',
  ],
  [
    'change-bound-rules',
    '    decoded.rulesVersion !== rules.version ||\n',
    '    false ||\n',
    'change preview is bound to the current rules version',
  ],
  [
    'change-bound-expiry',
    '    Date.parse(decoded.expiresAt) <= now.getTime()\n',
    '    false\n',
    'change rejects an expired bound preview',
  ],
]) {
  add(files.mandate, 'mandate-change-binding', id, predicate, integration, binding, [
    edit(search, replacement),
  ])
}

const signedFacts = 'revalidates signed maximum and validity facts at the change callpoint'
for (const [id, search, replacement, predicate] of [
  [
    'change-deployment-max',
    '      amount > rules.mandateMaxFen ||\n',
    '      false ||\n',
    'change rechecks the signed maximum against the deployment ceiling',
  ],
  [
    'change-validity-future',
    '      validUntilMs <= now.getTime() ||\n',
    '      false ||\n',
    'change rechecks that signed validity remains in the future',
  ],
  [
    'change-validity-bounded',
    '      validUntilMs - now.getTime() > AUTOMATIC_RENEWAL_MANDATE_MAX_VALIDITY_MS\n',
    '      false\n',
    'change rechecks that signed validity is bounded',
  ],
]) {
  add(files.mandate, 'mandate-change-facts', id, predicate, integration, signedFacts, [
    edit(
      search,
      replacement,
      id.startsWith('change-validity-') ? { expectedOccurrences: 2, occurrence: 2 } : {},
    ),
  ])
}

const authorized =
  'requires bound second confirmation and one-time step-up, records the authorization, and sends the enable reminder'
add(
  files.mandate,
  'mandate-change',
  'change-principal-callpoint',
  'change independently requires the authenticated customer',
  integration,
  access,
  [
    edit('  assertCustomer(req, options.customer)\n', '  void options.customer\n', {
      expectedOccurrences: 3,
      occurrence: 3,
    }),
  ],
)
add(
  files.mandate,
  'mandate-change',
  'change-a3-callpoint',
  'change independently requires the shared domain-write capability',
  integration,
  access,
  [
    edit(
      "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n",
      '',
      { expectedOccurrences: 2, occurrence: 2 },
    ),
  ],
)
add(
  files.mandate,
  'mandate-change',
  'change-stepup-callpoint',
  'change consumes a purpose-bound one-time step-up grant',
  integration,
  authorized,
  [
    edit(
      "    const grant = await authorizeStepUpGrant(req, {\n      customerId: options.customer.id,\n      deviceId: command.deviceId,\n      headers: req.headers,\n      purpose: 'renewal_mandate_change',\n      stepUpToken: command.stepUpToken,\n    })\n",
      "    const grant = { grantId: 'mutation-skipped-step-up' }\n",
    ),
  ],
)
add(
  files.mandate,
  'mandate-change',
  'change-domain-snapshot',
  'locked asset domain must still match the confirmed preview',
  integration,
  'rechecks the asset snapshot under lock after step-up and refuses changed domain data',
  [edit('    if (asset.domainAscii !== decoded.domainAscii) {\n', '    if (false) {\n')],
)
add(
  files.mandate,
  'mandate-change',
  'change-active-under-lock',
  'enablement rechecks active status under the asset lock',
  integration,
  'rechecks active asset status under lock after the preview',
  [
    edit(
      "    if (decoded.action === 'authorize' && asset.status !== 'active') {\n",
      '    if (false) {\n',
    ),
  ],
)
add(
  files.mandate,
  'mandate-change-sql',
  'change-lock-owner-predicate',
  'asset row lock is scoped to the authorizing customer',
  integration,
  'locks the requested asset only while it still belongs to the authorizing customer',
  [edit('      AND customer_id = ${customerId}\n', '      AND TRUE\n')],
)
add(
  files.mandate,
  'mandate-change-sql',
  'change-lock-returned-row',
  'absence of a locked owned row rejects the change',
  integration,
  'locks the requested asset only while it still belongs to the authorizing customer',
  [
    edit(
      "  if (!row) throw new AppError('DOMAIN_ASSET_NOT_FOUND', '未找到域名资产', 404)\n",
      "  if (false) throw new AppError('DOMAIN_ASSET_NOT_FOUND', '未找到域名资产', 404)\n",
    ),
  ],
)
add(
  files.mandate,
  'mandate-change-sql',
  'change-lock-for-update',
  'mandate revisions serialize on the owned asset row',
  integration,
  'serializes concurrent mandate authorizations into unique immutable revisions',
  [
    edit(
      '    UPDATE domain_assets\n    SET updated_at = NOW()\n    WHERE id = ${assetId}\n      AND customer_id = ${customerId}\n    RETURNING id, customer_id, domain_ascii, expires_at, status\n',
      '    SELECT id, customer_id, domain_ascii, expires_at, status\n    FROM domain_assets\n    WHERE id = ${assetId}\n      AND customer_id = ${customerId}\n',
    ),
  ],
)
for (const [id, search, replacement, predicate] of [
  [
    'change-created-max',
    "        maxDebitFen: decoded.action === 'authorize' ? decoded.maxDebitFen! : current!.maxDebitFen,\n",
    "        maxDebitFen: decoded.action === 'authorize' ? 1 : current!.maxDebitFen,\n",
    'stored maximum is the confirmed maximum',
  ],
  [
    'change-created-rules',
    '        rulesVersion: rules.version,\n',
    "        rulesVersion: 'mutation-rules',\n",
    'stored rules version advances with the authorization',
  ],
  [
    'change-created-validity',
    "        validUntil: decoded.action === 'authorize' ? decoded.validUntil! : current!.validUntil,\n",
    "        validUntil: decoded.action === 'authorize' ? '2029-08-01T12:00:00.000Z' : current!.validUntil,\n",
    'stored validity is the confirmed validity',
  ],
  [
    'change-audit-callpoint',
    '    await recordAuditEvent(req, {\n',
    '    await Promise.resolve({\n',
    'authorization emits its audit fact',
  ],
  [
    'change-enable-reminder-callpoint',
    '    await sendAutomaticRenewalReminder(req, {\n',
    '    await Promise.resolve({\n',
    'enablement uses the existing reminder delivery chain',
  ],
]) {
  add(files.mandate, 'mandate-created-facts', id, predicate, integration, authorized, [
    edit(search, replacement),
  ])
}

const appendOnly = 'makes mandate and execution facts append-only even with system access'
for (const [id, search, replacement, predicate] of [
  [
    'mandate-update-hook',
    "  hooks: appendOnly('RENEWAL_MANDATE_APPEND_ONLY', '自动续费授权记录只允许追加'),\n",
    "  hooks: { beforeDelete: appendOnly('RENEWAL_MANDATE_APPEND_ONLY', '自动续费授权记录只允许追加').beforeDelete },\n",
    'mandate revisions reject update even with system override',
  ],
  [
    'mandate-delete-hook',
    "  hooks: appendOnly('RENEWAL_MANDATE_APPEND_ONLY', '自动续费授权记录只允许追加'),\n",
    "  hooks: { beforeChange: appendOnly('RENEWAL_MANDATE_APPEND_ONLY', '自动续费授权记录只允许追加').beforeChange },\n",
    'mandate revisions reject delete even with system override',
  ],
  [
    'event-update-hook',
    "  hooks: appendOnly('AUTOMATIC_RENEWAL_EVENT_APPEND_ONLY', '自动续费执行记录只允许追加'),\n",
    "  hooks: { beforeDelete: appendOnly('AUTOMATIC_RENEWAL_EVENT_APPEND_ONLY', '自动续费执行记录只允许追加').beforeDelete },\n",
    'execution facts reject update even with system override',
  ],
  [
    'event-delete-hook',
    "  hooks: appendOnly('AUTOMATIC_RENEWAL_EVENT_APPEND_ONLY', '自动续费执行记录只允许追加'),\n",
    "  hooks: { beforeChange: appendOnly('AUTOMATIC_RENEWAL_EVENT_APPEND_ONLY', '自动续费执行记录只允许追加').beforeChange },\n",
    'execution facts reject delete even with system override',
  ],
]) {
  add(files.collections, 'append-only', id, predicate, integration, appendOnly, [
    edit(search, replacement),
  ])
}

const factAccess = 'isolates mandate and execution facts to their owning customer'
for (const [id, predicate, collection, slug] of [
  [
    'mandate-owner-read-callpoint',
    'mandate facts retain their customer ownership filter',
    'RenewalMandates',
    'renewalMandates',
  ],
  [
    'execution-owner-read-callpoint',
    'automatic renewal execution facts retain their customer ownership filter',
    'AutomaticRenewalEvents',
    'automaticRenewalEvents',
  ],
]) {
  add(files.collections, 'fact-access', id, predicate, integration, factAccess, [
    edit(
      `export const ${collection}: CollectionConfig = {\n  slug: '${slug}',\n  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },\n`,
      `export const ${collection}: CollectionConfig = {\n  slug: '${slug}',\n  access: { create: deny, delete: deny, read: () => true, update: deny },\n`,
    ),
  ])
}

const invalidMandates = {
  event: 'revoked mandate independently skips without any debit',
  expired: 'expired mandate independently skips without any debit',
  missing: 'missing mandate independently skips without any debit',
  sources: 'is read from the mandate fact and blocks debit',
}
for (const [id, search, replacement, predicate, test] of [
  [
    'execute-system-boundary',
    '  if (req.user) {\n',
    '  if (false) {\n',
    'unattended executor rejects an authenticated interactive caller',
    'rejects a customer-authenticated caller at the system executor boundary',
  ],
  [
    'execute-mandate-required',
    '  if (!mandate) {\n',
    '  if (false) {\n',
    'execution requires a current mandate fact',
    invalidMandates.missing,
  ],
  [
    'validity-event-source',
    "    mandate.eventType !== 'authorized' ||\n",
    '    false ||\n',
    'validity reads the latest mandate event type',
    invalidMandates.event,
  ],
  [
    'validity-revoked-at-source',
    '    mandate.revokedAt\n',
    '    false\n',
    'validity reads revokedAt independently from event type',
    invalidMandates.sources,
  ],
  [
    'validity-expiry-source',
    '  if (Date.parse(mandate.validUntil) <= input.now.getTime()) {\n',
    '  if (false) {\n',
    'validity reads the mandate expiry instead of inferring from existence',
    invalidMandates.expired,
  ],
  [
    'validity-rules-source',
    '    mandate.rulesVersion !== input.rules.version ||\n',
    '    false ||\n',
    'validity reads the persisted mandate rules version',
    invalidMandates.sources,
  ],
  [
    'validity-domain-source',
    '    mandate.domainAsciiSnapshot !== asset.domainAscii ||\n',
    '    false ||\n',
    'validity reads the persisted mandate domain snapshot',
    invalidMandates.sources,
  ],
  [
    'validity-customer-source',
    '    String(relationId(mandate.customer)) !== String(customerId) ||\n',
    '    false ||\n',
    'validity does not infer mandate ownership from the asset',
    'does not infer mandate ownership from the asset when the mandate customer fact differs',
  ],
  [
    'validity-max-positive',
    '  if (maxDebitFen <= 0n || maxDebitFen > rules.mandateMaxFen) {\n',
    '  if (false || maxDebitFen > rules.mandateMaxFen) {\n',
    'persisted maximum remains strictly positive at execution',
    invalidMandates.sources,
  ],
  [
    'validity-max-safe-integer',
    '  if (!Number.isSafeInteger(mandate.maxDebitFen)) {\n',
    '  if (false) {\n',
    'persisted maximum remains a safe integer number of fen',
    invalidMandates.sources,
  ],
  [
    'validity-max-bounded',
    '  if (maxDebitFen <= 0n || maxDebitFen > rules.mandateMaxFen) {\n',
    '  if (maxDebitFen <= 0n || false) {\n',
    'persisted maximum remains below the deployment ceiling',
    invalidMandates.sources,
  ],
  [
    'validity-active-asset',
    "    asset.status !== 'active' ||\n",
    '    false ||\n',
    'execution rechecks active local asset state',
    'expired local state never enters the ordinary renewal path',
  ],
  [
    'execute-expired-date',
    '  if (!Number.isFinite(assetExpiresAtMs) || assetExpiresAtMs <= now.getTime()) {\n',
    '  if (false) {\n',
    'cached active status cannot send an expired date through ordinary renewal',
    'records and skips an already-expired date even if the cached asset status still says active',
  ],
]) {
  add(files.automatic, 'execution-validity', id, predicate, integration, test, [
    edit(search, replacement),
  ])
}

const price =
  'uses the mandate maximum as the price source: over-limit skips and equality is allowed'
add(
  files.automatic,
  'price',
  'price-mandate-source-replacement',
  'hard debit ceiling comes from the mandate, not the current price',
  integration,
  price,
  [
    edit(
      '  const maxDebitFen = assertMandateAmount(mandate, rules)\n',
      '  const maxDebitFen = amountFen\n',
    ),
  ],
)
add(
  files.automatic,
  'price',
  'price-strict-greater',
  'price equal to the ceiling is allowed while greater is rejected',
  integration,
  price,
  [edit('  if (amountFen > maxDebitFen) {\n', '  if (amountFen >= maxDebitFen) {\n')],
)
add(
  files.automatic,
  'price',
  'price-change-event-callpoint',
  'over-limit price records one append-only decision fact',
  integration,
  price,
  [
    edit('    await appendEventOnce(req, {\n', '    await Promise.resolve({\n', {
      expectedOccurrences: 2,
      occurrence: 2,
    }),
  ],
)
add(
  files.automatic,
  'price',
  'price-change-notice-callpoint',
  'over-limit price uses the existing reminder chain',
  integration,
  price,
  [
    edit('    await sendAutomaticRenewalReminder(req, {\n', '    await Promise.resolve({\n', {
      expectedOccurrences: 2,
      occurrence: 1,
    }),
  ],
)

const accountTest = 'is re-read independently and blocks automatic debit'
for (const [id, search, replacement, predicate] of [
  [
    'account-status-source',
    "  if (customer.status !== 'active') {\n",
    '  if (false) {\n',
    'execution re-reads account status',
  ],
]) {
  add(files.automatic, 'account', id, predicate, integration, accountTest, [
    edit(search, replacement),
  ])
}
add(
  files.automatic,
  'account',
  'cooldown-callpoint',
  'unattended debit rechecks the identity-risk cooldown',
  integration,
  'blocks automatic debit during identity-risk cooldown',
  [edit('  await assertIdentityRiskCooldownInactive(req, customer.id)\n', '')],
)

const ownership = 'blocks debit through the shared ownership path'
for (const [id, search, replacement, predicate] of [
  [
    'upstream-ownership-callpoint',
    '  const owned = await assertWestDigitalDomainOwnership(\n    req,\n    {\n      actor: input.actor,\n      domainAscii: input.asset.domainAscii,\n      targetId: input.asset.id,\n      traceId: `${input.traceId}:ownership`,\n    },\n    provider,\n  )\n',
    '  const owned = input.asset\n',
    'execution reuses the shared upstream ownership assertion',
  ],
  [
    'upstream-expiry-source',
    '    owned.expiresAt !== input.asset.expiresAt\n',
    '    false\n',
    'upstream expiry must equal the local asset snapshot',
  ],
]) {
  add(files.automatic, 'upstream', id, predicate, integration, ownership, [
    edit(search, replacement),
  ])
}
const domainState = 'independently fails closed before debit'
for (const [id, search, replacement, predicate] of [
  [
    'eligibility-ok',
    '    !eligibility?.ok ||\n',
    '    false ||\n',
    'EPP eligibility failures are fail-closed',
  ],
  [
    'eligibility-domain',
    '    eligibility.data.domainAscii !== input.asset.domainAscii ||\n',
    '    false ||\n',
    'EPP eligibility is bound to the requested domain',
  ],
  [
    'eligibility-state',
    "    eligibility.data.state !== 'eligible'\n",
    '    false\n',
    'redemption and registry restrictions cannot enter ordinary renewal',
  ],
]) {
  add(files.automatic, 'upstream', id, predicate, integration, domainState, [
    edit(search, replacement),
  ])
}

const insufficient =
  'insufficient balance never partially debits or overdrafts and emits a capped reminder'
for (const [id, search, replacement, predicate] of [
  [
    'hold-wallet-callpoint',
    '        hold = await holdWalletBalance(req, {\n',
    "        hold = { status: 'held', transactionId: 'mutation-no-hold' } as never; void ({\n",
    'balance is changed only through the B-1 hold service',
  ],
  [
    'insufficient-error-branch',
    "        if (!(error instanceof AppError) || error.code !== 'WALLET_BALANCE_INSUFFICIENT')\n          throw error\n",
    '        if (true) throw error\n',
    'only the explicit insufficient-balance result becomes a reminder',
  ],
  [
    'reminder-limit-comparison',
    '          remind: previousReminderCount < rules.balanceReminderLimit,\n',
    '          remind: true,\n',
    'balance reminders stop at the configured bounded count',
  ],
  [
    'insufficient-notice-callpoint',
    '    await sendAutomaticRenewalReminder(req, {\n',
    '    await Promise.resolve({\n',
    'an allowed insufficient-balance reminder uses the existing chain',
  ],
]) {
  add(files.automatic, 'wallet', id, predicate, integration, insufficient, [
    edit(
      search,
      replacement,
      id === 'insufficient-notice-callpoint' ? { expectedOccurrences: 2, occurrence: 2 } : {},
    ),
  ])
}

add(
  files.automatic,
  'mutex',
  'unfinished-cycle-callpoint',
  'a later retry slot cannot create a second unfinished cycle order',
  integration,
  'does not create a second hold at a later retry slot while the cycle order is unfinished',
  [edit('      if (await hasUnfinishedCycleOrder(req, asset)) {\n', '      if (false) {\n')],
)
add(
  files.automatic,
  'mutex',
  'attempt-conflict-clause',
  'same-slot attempt claim uses an insert conflict guard',
  integration,
  'atomically claims one same-slot insufficient attempt under concurrent triggers',
  [
    edit(
      '    ON CONFLICT (event_key) DO NOTHING\n',
      '    ON CONFLICT (event_key) DO UPDATE SET updated_at = NOW()\n',
    ),
  ],
)
add(
  files.automatic,
  'mutex',
  'attempt-returning-authorization',
  'only the row returned by the atomic claim authorizes an attempt',
  integration,
  'atomically claims one same-slot insufficient attempt under concurrent triggers',
  [edit('  return claimed.rows?.[0]?.id !== undefined\n', '  return true\n')],
)
add(
  files.automatic,
  'mutex',
  'execution-lock-for-update',
  'hold and mandate revision serialize on the same asset row',
  integration,
  'holds the asset row across final mandate validation and the wallet hold',
  [
    edit(
      "    UPDATE domain_assets\n    SET updated_at = NOW()\n    WHERE id = ${asset.id}\n      AND customer_id = ${relationId(asset.customer)}\n      AND domain_ascii = ${asset.domainAscii}\n      AND expires_at = ${asset.expiresAt}::timestamptz\n      AND status = 'active'\n    RETURNING id\n",
      "    SELECT id\n    FROM domain_assets\n    WHERE id = ${asset.id}\n      AND customer_id = ${relationId(asset.customer)}\n      AND domain_ascii = ${asset.domainAscii}\n      AND expires_at = ${asset.expiresAt}::timestamptz\n      AND status = 'active'\n",
    ),
  ],
)
add(
  files.automatic,
  'mutex',
  'inner-current-mandate-callpoint',
  'the pre-hold callpoint requires the same current mandate revision used for price authorization',
  integration,
  'rechecks the latest mandate revision immediately before placing the wallet hold',
  [edit('        expectedMandateId: mandate.id,\n', '')],
)

const deterministic =
  'sorts every batch deterministically by expiry and then numeric domain asset id'
add(
  files.automatic,
  'priority',
  'priority-expiry',
  'batch priority sorts expiration ascending',
  integration,
  deterministic,
  [
    edit(
      '    const expiryDifference = Date.parse(left.asset.expiresAt) - Date.parse(right.asset.expiresAt)\n',
      '    const expiryDifference = 0\n',
    ),
  ],
)
add(
  files.automatic,
  'priority',
  'priority-id-tiebreak',
  'equal expirations sort by numeric asset id ascending',
  integration,
  deterministic,
  [
    edit(
      '    return expiryDifference || compareIds(left.asset.id, right.asset.id)\n',
      '    return expiryDifference\n',
    ),
  ],
)
add(
  files.automatic,
  'candidates',
  'candidate-latest-revision',
  'scheduler derives state from the latest revision per asset',
  integration,
  'derives scheduler candidates from the latest mandate revision and excludes a closed mandate',
  [
    edit(
      '    if (!latestByAsset.has(assetId)) latestByAsset.set(assetId, document)\n',
      '    latestByAsset.set(assetId, document)\n',
    ),
  ],
)
add(
  files.automatic,
  'candidates',
  'candidate-revision-sort-source',
  'scheduler source orders mandate revisions newest first',
  integration,
  'derives scheduler candidates from the latest mandate revision and excludes a closed mandate',
  [edit("    sort: '-revision',\n", "    sort: 'revision',\n")],
)
add(
  files.automatic,
  'candidates',
  'candidate-authorized-event',
  'scheduler excludes a latest revoked mandate',
  integration,
  'derives scheduler candidates from the latest mandate revision and excludes a closed mandate',
  [edit("    if (mandate.eventType !== 'authorized') continue\n", '')],
)

const concurrent =
  'concurrent triggers produce exactly one wallet charge and one idempotent D6 upstream renewal'
for (const [id, search, replacement, predicate] of [
  [
    'due-notice-callpoint',
    '  await sendAutomaticRenewalReminder(req, {\n',
    '  await Promise.resolve({\n',
    'a due notice is sent before the actual renewal date',
  ],
  [
    'restore-system-context',
    '  req.user = null\n',
    '',
    'system context is restored before the system-only order mutation',
  ],
  [
    'balance-channel-claim',
    '      if (!(await claimBalancePaymentChannel(req, { orderId: created.order.id, paidAt }))) {\n',
    '      if (false) {\n',
    'automatic order atomically claims the balance-only payment channel',
  ],
  [
    'transition-paid-callpoint',
    "      await transitionOrder(req, created.order.id, 'paid', {\n",
    '      await Promise.resolve({\n',
    'held automatic order enters paid only through the shared state machine',
  ],
  [
    'enqueue-d6-callpoint',
    '      await enqueueCommerceFulfillment(req, { orderId: created.order.id, traceId })\n',
    '',
    'automatic renewal queues the existing D6 commerceFulfillment workflow',
  ],
  [
    'queued-event-callpoint',
    '      await appendEvent(req, {\n',
    '      await Promise.resolve({\n',
    'queued order emits one append-only execution fact',
  ],
  [
    'queued-audit-callpoint',
    '      await recordAuditEvent(req, {\n',
    '      await Promise.resolve({\n',
    'queued order emits its audit fact',
  ],
]) {
  const options =
    id === 'due-notice-callpoint'
      ? { expectedOccurrences: 3, occurrence: 2 }
      : id === 'queued-event-callpoint'
        ? { expectedOccurrences: 2, occurrence: 2 }
        : id === 'queued-audit-callpoint'
          ? { expectedOccurrences: 1 }
          : {}
  add(files.automatic, 'queue-reuse', id, predicate, integration, concurrent, [
    edit(search, replacement, options),
  ])
}

for (const [id, search, replacement, predicate, test] of [
  [
    'fulfillment-initial-revalidation',
    "  if (order.status === 'paid' && order.automaticRenewalMandate) {\n",
    '  if (false) {\n',
    'queued mandate is revalidated before generic D6 preflight',
    'checks local expiry state before generic D6 preflight and releases a queued hold',
  ],
  [
    'fulfillment-final-revalidation',
    '        await revalidateAutomaticRenewalOrder(req, order, {\n',
    '        await Promise.resolve({\n',
    'queued mandate is revalidated again immediately before fulfilling',
    'revalidates again after preflight and catches revocation racing the queued job',
  ],
  [
    'fulfillment-release-callpoint',
    '    await requestAutomaticRegistrationFailureRefund(req, {\n',
    '    await Promise.resolve({\n',
    'abandoned queued renewal releases the complete wallet hold through the shared refund path',
    'revalidates a queued task, abandons a revoked mandate, releases the complete hold, and records the skip',
  ],
  [
    'fulfillment-skip-record-callpoint',
    '    await recordAutomaticRenewalOrderSkip(req, order, error, `${input.traceId}:automatic-mandate`)\n',
    '    await Promise.resolve()\n',
    'abandoned queued renewal leaves an append-only skip fact',
    'revalidates a queued task, abandons a revoked mandate, releases the complete hold, and records the skip',
  ],
]) {
  const options =
    id === 'fulfillment-release-callpoint' ? { expectedOccurrences: 4, occurrence: 2 } : {}
  add(files.fulfillment, 'fulfillment-revalidation', id, predicate, integration, test, [
    edit(search, replacement, options),
  ])
}

for (const [id, search, predicate, test] of [
  [
    'fulfillment-current-mandate-callpoint',
    '    expectedMandateId: relationId(order.automaticRenewalMandate),\n',
    'queued fulfillment requires the exact mandate revision recorded on the order',
    'abandons a queued task when a newer same-terms mandate revision replaces its authorization',
  ],
  [
    'fulfillment-amount-callpoint',
    '    amountFen: BigInt(order.amountMinor),\n',
    'queued fulfillment compares the full order amount with the latest mandate maximum',
    'uses the latest reauthorization maximum at fulfillment instead of the queued price snapshot',
  ],
  [
    'fulfillment-rules-callpoint',
    '    expectedRulesVersion: order.automaticRenewalRulesVersion,\n',
    'queued fulfillment binds the order to its recorded mandate rules version',
    'binds a queued automatic order to the rules version recorded at authorization',
  ],
]) {
  add(files.automatic, 'fulfillment-revalidation', id, predicate, integration, test, [
    edit(search, ''),
  ])
}

for (const [id, search, replacement, predicate] of [
  [
    'epp-action-contract',
    "      body: { act: 'geteppstatus', domain: expected },\n",
    "      body: { act: 'getdomaininfo', domain: expected },\n",
    'eligibility uses documented GET geteppstatus action',
  ],
  [
    'epp-domain-contract',
    "      body: { act: 'geteppstatus', domain: expected },\n",
    "      body: { act: 'geteppstatus', domain: 'mutation.example' },\n",
    'eligibility binds the documented request to the normalized domain',
  ],
  [
    'epp-eligible-map',
    '          state: renewalEligibilityState(statusCodes),\n',
    "          state: 'eligible',\n",
    'EPP response state is mapped fail-closed instead of assuming eligible',
  ],
]) {
  add(files.provider, 'provider-contract', id, predicate, provider, 'maps documented EPP status', [
    edit(search, replacement),
  ])
}

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

function mutateSource(source, mutation) {
  let result = source
  for (const change of mutation.edits) {
    const found = occurrences(result, change.search)
    const expected = change.expectedOccurrences ?? 1
    if (found !== expected) {
      throw new Error(
        `expected ${expected} occurrences of ${JSON.stringify(change.search)}, found ${found}`,
      )
    }
    result = replaceOccurrence(result, change.search, change.replacement, change.occurrence ?? 1)
  }
  return result
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.group}/${mutation.id}\t${mutation.predicate}\t${mutation.testFile} :: ${mutation.test}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}

if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      mutateSource(readFileSync(`${webRoot}/${mutation.file}`, 'utf8'), mutation)
    } catch (error) {
      invalid += 1
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  if (invalid) process.exitCode = 1
  process.exit()
}

const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.id) || selectors.includes(mutation.group),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-C-2 mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  let mutated
  try {
    mutated = mutateSource(original, mutation)
  } catch (error) {
    process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
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
        mutation.testFile,
        '-t',
        mutation.test,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_REAL_WECHATPAY: 'false',
          ALLOW_REAL_WESTDIGITAL_READS: 'false',
          ALLOW_REAL_WESTDIGITAL_WRITES: 'false',
        },
      },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(
    `\nMUTATION ${mutation.group}/${mutation.id}\nPREDICATE ${mutation.predicate}\nTEST ${mutation.testFile} :: ${mutation.test}\nRAW_FAILURE ${failure}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError:')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`RAW_OUTPUT ${output.split('\n').slice(-35).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(
  `\nD9C2_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
