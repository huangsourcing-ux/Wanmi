import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9c1-domain-center.integration.test.ts'
const contractTest = 'tests/unit/d9c1-domain-center-routes.test.ts'
const routeTest = 'tests/unit/domain-assets-route.test.ts'
const schemaFile = 'src/schemas/domains.ts'
const assetsFile = 'src/services/domains/domain-assets.ts'
const preferencesFile = 'src/services/domains/domain-preferences.ts'
const managementFile = 'src/services/domains/domain-management.ts'
const remindersFile = 'src/services/domains/expiry-reminders.ts'
const operationsFile = 'src/services/providers/westdigital-operations.ts'
const adapterFile = 'src/providers/westdigital-write.ts'
const guardFile = 'src/lib/provider-write-guardrails.ts'
const eventsFile = 'src/collections/domain-management.ts'

const mutations = []
const add = (mutation) => mutations.push(mutation)
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })

const boundaryTest = 'enforces every public list, tag, reminder and lock input boundary'
for (const mutation of [
  {
    id: 'tag-trim',
    search: 'const domainTagSchema = z\n  .string()\n  .trim()\n  .max(32)',
    replacement: 'const domainTagSchema = z\n  .string()\n  .max(32)',
  },
  { id: 'tag-max', search: '  .max(32)\n  .regex', replacement: '  .max(33)\n  .regex' },
  {
    id: 'tag-control-character',
    search: '  .regex(/^[^\\u0000-\\u001f\\u007f]+$/u)',
    replacement: '  .regex(/^.+$/u)',
  },
  {
    id: 'tags-max-count',
    search: '  .max(20)\n  .superRefine',
    replacement: '  .max(21)\n  .superRefine',
  },
  {
    id: 'tags-unique',
    search: '    if (new Set(tags).size !== tags.length) {',
    replacement: '    if (false) {',
  },
  {
    id: 'reminder-channels-min',
    search: '  .array(domainExpiryReminderChannelSchema)\n  .min(1)',
    replacement: '  .array(domainExpiryReminderChannelSchema)\n  .min(0)',
  },
  {
    id: 'reminder-channels-unique',
    search: '    if (new Set(channels).size !== channels.length) {',
    replacement: '    if (false) {',
  },
  {
    id: 'reminder-days-integer',
    search: '  .array(z.number().int().min(0).max(365))',
    replacement: '  .array(z.number().min(0).max(365))',
  },
  {
    id: 'reminder-days-lower-bound',
    search: '  .array(z.number().int().min(0).max(365))',
    replacement: '  .array(z.number().int().min(-1).max(365))',
  },
  {
    id: 'reminder-days-upper-bound',
    search: '  .array(z.number().int().min(0).max(365))',
    replacement: '  .array(z.number().int().min(0).max(366))',
  },
  {
    id: 'reminder-days-min-count',
    search: '  .array(z.number().int().min(0).max(365))\n  .min(1)',
    replacement: '  .array(z.number().int().min(0).max(365))\n  .min(0)',
  },
  {
    id: 'reminder-days-max-count',
    search: '  .max(12)\n  .superRefine',
    replacement: '  .max(13)\n  .superRefine',
  },
  {
    id: 'reminder-days-unique',
    search: '    if (new Set(days).size !== days.length) {',
    replacement: '    if (false) {',
  },
  {
    id: 'batch-asset-positive',
    search: '    .array(z.coerce.number().int().positive())',
    replacement: '    .array(z.coerce.number().int().nonnegative())',
  },
  {
    id: 'batch-asset-min-count',
    search: '    .min(1)\n    .max(200)',
    replacement: '    .min(0)\n    .max(200)',
  },
  {
    id: 'batch-asset-max-count',
    search: '    .max(200)\n    .superRefine',
    replacement: '    .max(201)\n    .superRefine',
  },
  {
    id: 'batch-asset-unique',
    search: '      if (new Set(assetIds).size !== assetIds.length) {',
    replacement: '      if (false) {',
  },
  {
    id: 'list-expiry-lower-bound',
    search: 'expiresWithinDays: z.coerce.number().int().min(0).max(3_650).optional()',
    replacement: 'expiresWithinDays: z.coerce.number().int().min(-1).max(3_650).optional()',
  },
  {
    id: 'list-expiry-upper-bound',
    search: 'expiresWithinDays: z.coerce.number().int().min(0).max(3_650).optional()',
    replacement: 'expiresWithinDays: z.coerce.number().int().min(0).max(3_651).optional()',
  },
  {
    id: 'list-page-positive',
    search: 'page: z.coerce.number().int().positive().default(1)',
    replacement: 'page: z.coerce.number().int().nonnegative().default(1)',
  },
  {
    id: 'list-page-size-lower',
    search: 'pageSize: z.coerce.number().int().min(1).max(100).default(20)',
    replacement: 'pageSize: z.coerce.number().int().min(0).max(100).default(20)',
  },
  {
    id: 'list-page-size-upper',
    search: 'pageSize: z.coerce.number().int().min(1).max(100).default(20)',
    replacement: 'pageSize: z.coerce.number().int().min(1).max(101).default(20)',
  },
  {
    id: 'list-query-max',
    search: 'query: z.string().trim().max(253).optional()',
    replacement: 'query: z.string().trim().max(254).optional()',
  },
  {
    id: 'lock-disable-device-required',
    search: '    deviceId: z.string().min(16).max(128),',
    replacement: '    deviceId: z.string().min(16).max(128).optional(),',
  },
  {
    id: 'lock-disable-grant-required',
    search: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),',
    replacement: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),',
  },
]) {
  add({
    file: schemaFile,
    group: 'request-boundary',
    edits: [edit(mutation.search, mutation.replacement)],
    testFile: contractTest,
    test: boundaryTest,
    ...mutation,
  })
}

const routeParsingTest = 'returns only the safe six-state list contract with no-store'
for (const [id, field] of [
  ['expires-within', 'expiresWithinDays'],
  ['lock-status', 'lockStatus'],
  ['page', 'page'],
  ['page-size', 'pageSize'],
  ['query', 'query'],
  ['sort', 'sort'],
  ['status', 'status'],
  ['tag', 'tag'],
]) {
  add({
    file: 'src/app/api/v1/domains/route.ts',
    group: 'list-route-callpoint',
    id: `list-route-${id}`,
    edits: [edit(`        ${field}: search.get('${field}') ?? undefined,\n`, '')],
    testFile: routeTest,
    test: routeParsingTest,
  })
}

const isolationTest =
  'keeps list, search, filters and mixed-owner batch preferences isolated to the authenticated owner'
add({
  file: assetsFile,
  group: 'list-authentication',
  id: 'list-customer-principal-callpoint',
  edits: [
    edit('  assertCustomer(req, customer)\n', '  void customer\n', {
      expectedOccurrences: 2,
      occurrence: 2,
    }),
  ],
  test: isolationTest,
})
add({
  file: assetsFile,
  group: 'list-source',
  id: 'list-access-controlled-owner-source-replacement',
  edits: [
    edit(
      '  const filters: Where[] = [{ customer: { equals: customer.id } }]\n',
      '  const filters: Where[] = []\n',
    ),
    edit('    overrideAccess: false,\n', '    overrideAccess: true,\n', {
      expectedOccurrences: 4,
      occurrence: 2,
    }),
    edit('    user: req.user,\n', '', { expectedOccurrences: 4, occurrence: 2 }),
    edit(
      '  const items = found.docs.map((document) => publicAsset(document as unknown as AssetRecord))\n',
      '  const items = found.docs\n    .filter((document) =>\n      String(relationId((document as unknown as AssetRecord).customer)) === String(customer.id),\n    )\n    .map((document) => publicAsset(document as unknown as AssetRecord))\n',
    ),
  ],
  test: 'uses the access-controlled Local API source and explicit owner predicates for list and batch reads',
})
for (const [id, line] of [
  ['query', '  if (input.query) filters.push({ domainAscii: { contains: input.query } })\n'],
  ['status', '  if (input.status) filters.push({ status: { equals: input.status } })\n'],
  [
    'lock-status',
    '  if (input.lockStatus) filters.push({ domainLockStatus: { equals: input.lockStatus } })\n',
  ],
  ['tag', '  if (input.tag) filters.push({ tags: { contains: input.tag } })\n'],
  ['expiry-branch', '  if (input.expiresWithinDays !== undefined) {\n'],
]) {
  add({
    file: assetsFile,
    group: 'list-filter-callpoint',
    id: `list-filter-${id}`,
    edits: id === 'expiry-branch' ? [edit(line, '  if (false) {\n')] : [edit(line, '')],
    test: isolationTest,
  })
}
for (const [id, search, replacement] of [
  ['expiry-lower', '      { expiresAt: { greater_than_equal: now.toISOString() } },\n', ''],
  [
    'expiry-upper',
    '          less_than_equal: new Date(\n            now.getTime() + input.expiresWithinDays * 86_400_000,\n          ).toISOString(),\n',
    '          less_than_equal: new Date(now.getTime() + 3_650 * 86_400_000).toISOString(),\n',
  ],
]) {
  add({
    file: assetsFile,
    group: 'list-filter-decision',
    id: `list-${id}`,
    edits: [edit(search, replacement)],
    test: isolationTest,
  })
}
for (const [id, search, replacement, options] of [
  ['explicit-limit', '    limit: input.pageSize,\n', ''],
  [
    'explicit-page',
    '    page: input.page,\n',
    '    page: 1,\n',
    { expectedOccurrences: 2, occurrence: 1 },
  ],
  ['explicit-sort', '    sort: input.sort,\n', "    sort: '-createdAt',\n"],
  ['returned-total', '      total: found.totalDocs,\n', '      total: items.length,\n'],
  ['returned-total-pages', '      totalPages: found.totalPages,\n', '      totalPages: 1,\n'],
]) {
  add({
    file: assetsFile,
    group: 'list-pagination-decision',
    id: `list-${id}`,
    edits: [edit(search, replacement, options)],
    test: 'returns and updates every one of more than ten explicitly selected owner assets',
  })
}

const a3Test = 'applies A3 and local ownership at every D9-C-1 write call point'
for (const [file, id, call, expectedOccurrences, occurrence] of [
  [
    preferencesFile,
    'tags-a3',
    "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n",
    2,
    1,
  ],
  [
    preferencesFile,
    'batch-a3',
    "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n",
    2,
    2,
  ],
  [
    managementFile,
    'lock-a3',
    "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n",
    6,
    3,
  ],
]) {
  add({
    file,
    group: 'a3-callpoint',
    id,
    edits: [edit(call, '  await Promise.resolve()\n', { expectedOccurrences, occurrence })],
    test: a3Test,
  })
}
for (const [file, id, call, expectedOccurrences, occurrence] of [
  [preferencesFile, 'tags-owned-asset', '  const asset = (await findOwnedDomainAsset(\n', 1, 1],
  [
    managementFile,
    'lock-owned-asset',
    '  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord\n',
    6,
    3,
  ],
]) {
  add({
    file,
    group: 'local-owner-callpoint',
    id,
    edits:
      file === preferencesFile
        ? [
            edit(
              '  const asset = (await findOwnedDomainAsset(\n    req,\n    assetId,\n    options.customer,\n  )) as DomainManagedAssetRecord & { tags?: null | string[] }\n',
              "  const asset = (await req.payload.findByID({ collection: 'domainAssets', id: assetId, overrideAccess: true, req })) as unknown as DomainManagedAssetRecord & { tags?: null | string[] }\n",
            ),
          ]
        : [
            edit(
              call,
              "  const asset = (await req.payload.findByID({ collection: 'domainAssets', id: assetId, overrideAccess: true, req })) as unknown as AssetRecord\n",
              { expectedOccurrences, occurrence },
            ),
          ],
    test: a3Test,
  })
}
add({
  file: preferencesFile,
  group: 'batch-principal',
  id: 'batch-customer-principal',
  edits: [edit('  assertCustomerPrincipal(req, options.customer)\n', '  void options.customer\n')],
  test: 'uses the access-controlled Local API source and explicit owner predicates for list and batch reads',
})
for (const [id, search, replacement, test] of [
  [
    'configured-tiers-present',
    '  if (!configured.length) {\n',
    '  if (false) {\n',
    'rejects unsupported reminder tiers and an unusable configured tier set',
  ],
  [
    'configured-tier-membership',
    '  if (input.thresholdDays.some((value) => !configured.includes(value))) {\n',
    '  if (false) {\n',
    'rejects unsupported reminder tiers and an unusable configured tier set',
  ],
  [
    'final-tier-required',
    '  if (!input.thresholdDays.includes(finalThreshold)) {\n',
    '  if (false) {\n',
    'cannot disable the final reminder tier and the existing reminder chain honors valid channel preferences',
  ],
  [
    'batch-complete-owner-set',
    '  if (visible.docs.length !== input.assetIds.length) {\n',
    '  if (false) {\n',
    isolationTest,
  ],
]) {
  add({
    file: preferencesFile,
    group: 'reminder-preference-decision',
    id,
    edits: [edit(search, replacement)],
    test,
  })
}
add({
  file: preferencesFile,
  group: 'batch-source',
  id: 'batch-access-controlled-owner-source-replacement',
  edits: [
    edit(
      '  const visible = await req.payload.find({\n',
      '  const unscoped = await req.payload.find({\n',
    ),
    edit('    overrideAccess: false,\n', '    overrideAccess: true,\n'),
    edit('    user: req.user,\n', ''),
    edit(
      '      and: [{ customer: { equals: options.customer.id } }, { id: { in: input.assetIds } }],\n',
      '      and: [{ id: { in: input.assetIds } }],\n',
    ),
    edit(
      '  if (visible.docs.length !== input.assetIds.length) {\n',
      "  const visible = {\n    ...unscoped,\n    docs: unscoped.docs.filter((asset) =>\n      String(typeof asset.customer === 'object' ? asset.customer.id : asset.customer) ===\n      String(options.customer.id),\n    ),\n  }\n  if (visible.docs.length !== input.assetIds.length) {\n",
    ),
  ],
  test: 'uses the access-controlled Local API source and explicit owner predicates for list and batch reads',
})
for (const [id, search, replacement, test] of [
  [
    'batch-explicit-pagination',
    '    pagination: false,\n',
    '',
    'returns and updates every one of more than ten explicitly selected owner assets',
  ],
  [
    'batch-selected-ids',
    '      and: [{ customer: { equals: options.customer.id } }, { id: { in: input.assetIds } }],\n',
    '      and: [{ customer: { equals: options.customer.id } }],\n',
    'uses the access-controlled Local API source and explicit owner predicates for list and batch reads',
  ],
  [
    'batch-transaction',
    '  await transaction(req, async () => {\n',
    '  await (async () => {\n',
    'rolls back preference facts and append-only evidence together on partial failures',
  ],
  [
    'tags-transaction',
    '  await transaction(req, async () => {\n',
    '  await (async () => {\n',
    'rolls back preference facts and append-only evidence together on partial failures',
  ],
]) {
  add({
    file: preferencesFile,
    group: 'preference-write-decision',
    id,
    edits: [
      edit(search, replacement, {
        ...(id === 'batch-transaction' ? { expectedOccurrences: 2, occurrence: 2 } : {}),
        ...(id === 'tags-transaction' ? { expectedOccurrences: 2, occurrence: 1 } : {}),
      }),
    ],
    test,
  })
}
for (const [id, operation, test] of [
  [
    'tags-event',
    'tags_update',
    'updates tags on the owned asset and exposes them to owner-scoped filtering',
  ],
  [
    'batch-event',
    'expiry_reminder_preferences_update',
    'returns and updates every one of more than ten explicitly selected owner assets',
  ],
]) {
  add({
    file: preferencesFile,
    group: 'append-event-callpoint',
    id,
    edits: [
      edit(`    await appendManagementEvent(req, {\n`, `    await Promise.resolve({\n`, {
        expectedOccurrences: 2,
        occurrence: operation === 'tags_update' ? 1 : 2,
      }),
    ],
    test,
  })
}

const lockDecisionTest =
  'fails closed for unsupported and unchanged lock-state decisions before provider access'
for (const [id, search, replacement, test, options] of [
  [
    'lock-capability-callpoint',
    "  assertDomainCapability(\n    'domain_lock_status',\n    options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,\n  )\n",
    '  void options.capabilities\n',
    lockDecisionTest,
  ],
  [
    'lock-unchanged-rejection',
    "  if ((asset.domainLockStatus ?? 'unknown') === requestedStatus) {\n",
    '  if (false) {\n',
    lockDecisionTest,
  ],
  [
    'unlock-risk-branch',
    '  if (!input.locked) {\n',
    '  if (false) {\n',
    'rejects disabling the domain lock without step-up and notifies every active provider after success',
  ],
  [
    'unlock-step-up-callpoint',
    '    await authorizeStepUpGrant(req, {\n',
    '    await Promise.resolve({\n',
    'rejects disabling the domain lock without step-up and notifies every active provider after success',
  ],
  [
    'unlock-step-up-purpose',
    "      purpose: 'domain_lock_change',\n",
    "      purpose: 'nameserver_change',\n",
    'rejects disabling the domain lock without step-up and notifies every active provider after success',
  ],
  [
    'unlock-active-channel-callpoint',
    '    identities = await activeCustomerIdentities(req, customerNumber(options.customer))\n',
    '    identities = []\n',
    'rejects disabling the domain lock without step-up and notifies every active provider after success',
  ],
  [
    'unlock-active-channel-required',
    '    if (!identities.length) {\n',
    '    if (false) {\n',
    'rejects lock disable when no active notification channel remains',
  ],
  [
    'lock-direction-business-key',
    '    businessKey: `${input.idempotencyKey}:${requestedStatus}`,\n',
    '    businessKey: input.idempotencyKey,\n',
    'binds one reused client idempotency key to each lock direction independently',
  ],
  [
    'lock-management-lease-callpoint',
    '  return withManagementLease(req, asset, operationKey, async () => {\n',
    '  return (async () => {\n',
    'enables the domain lock with the current session and audit but no step-up or bound channel',
    { expectedOccurrences: 4, occurrence: 2 },
  ],
  [
    'lock-provider-executor-callpoint',
    '      await executeWestDigitalWriteOperation(req, writeInput, options.provider),\n',
    "      Promise.resolve({ problem: { code: 'MUTATED' }, state: 'error' } as never),\n",
    'enables the domain lock with the current session and audit but no step-up or bound channel',
    { expectedOccurrences: 4, occurrence: 2 },
  ],
  [
    'lock-local-fact-only-on-success',
    "    if ('data' in operationResult && operationResult.data.status === 'succeeded') {\n",
    "    if ('data' in operationResult) {\n",
    'does not confirm local lock state or notify channels when the provider result is unknown',
  ],
  [
    'unlock-notify-only-on-success',
    "    if (!input.locked && 'data' in operationResult && operationResult.data.status === 'succeeded') {\n",
    "    if (!input.locked && 'data' in operationResult) {\n",
    'does not confirm local lock state or notify channels when the provider result is unknown',
  ],
]) {
  add({
    file: managementFile,
    group: 'lock-decision',
    id,
    edits: [edit(search, replacement, options)],
    testFile: undefined,
    test,
  })
}
for (const [id, search] of [
  [
    'lock-requested-event-callpoint',
    "    await appendManagementEvent(req, {\n      asset,\n      customerId: options.customer.id,\n      event: 'requested',\n      eventRoot: operationKey,\n      operation: 'domain_lock_change',\n",
  ],
  [
    'lock-outcome-event-callpoint',
    "    await appendManagementEvent(req, {\n      asset,\n      customerId: options.customer.id,\n      errorCode: 'problem' in operationResult ? operationResult.problem.code : undefined,\n      event: resultEvent(operationResult),\n      eventRoot: operationKey,\n      operation: 'domain_lock_change',\n",
  ],
]) {
  add({
    file: managementFile,
    group: 'lock-event-callpoint',
    id,
    edits: [
      edit(search, search.replace('await appendManagementEvent(req, {', 'await Promise.resolve({')),
    ],
    test: 'enables the domain lock with the current session and audit but no step-up or bound channel',
  })
}
add({
  file: managementFile,
  group: 'lock-notification-callpoint',
  id: 'unlock-notification-callpoint',
  edits: [
    edit('      await notifyFormerCustomerIdentities(\n', '      await Promise.resolve(\n', {
      expectedOccurrences: 1,
    }),
  ],
  test: 'rejects disabling the domain lock without step-up and notifies every active provider after success',
})
add({
  file: managementFile,
  group: 'audit-callpoint',
  id: 'management-event-audit-callpoint',
  edits: [
    edit('      await recordAuditEvent(req, {\n', '      await Promise.resolve({\n', {
      expectedOccurrences: 1,
    }),
  ],
  test: 'enables the domain lock with the current session and audit but no step-up or bound channel',
})

for (const [id, search, replacement, test] of [
  [
    'reminder-final-tier-injection',
    '    .concat(finalThreshold === undefined ? [] : [finalThreshold])\n',
    '    .concat([])\n',
    'cannot disable the final reminder tier and the existing reminder chain honors valid channel preferences',
  ],
  [
    'reminder-channel-fallback',
    "    channels: channels.length ? channels : ['in_app'],\n",
    '    channels,\n',
    'cannot disable the final reminder tier and the existing reminder chain honors valid channel preferences',
  ],
  [
    'reminder-configured-membership',
    '    .filter((value) => configured.includes(value))\n',
    '    .filter(() => true)\n',
    'cannot disable the final reminder tier and the existing reminder chain honors valid channel preferences',
  ],
]) {
  add({
    file: remindersFile,
    group: 'reminder-delivery-decision',
    id,
    edits: [edit(search, replacement)],
    test,
  })
}

for (const [id, search, replacement, test] of [
  [
    'executor-domain-lock-submit',
    "  if (input.operation === 'domain_lock')\n    return requireDomainManagementProvider(provider).setDomainLock(input)\n",
    "  if (input.operation === 'domain_lock') return provider.changeNameservers(input as never)\n",
    'enables the domain lock with the current session and audit but no step-up or bound channel',
  ],
  [
    'executor-domain-lock-no-query',
    "  if (input.operation === 'domain_lock') return undefined\n",
    '',
    'does not confirm local lock state or notify channels when the provider result is unknown',
  ],
  [
    'executor-upstream-owner-preflight',
    "    if (input.operation !== 'realname' && input.operation !== 'register') {\n",
    "    if (input.operation !== 'domain_lock' && input.operation !== 'realname' && input.operation !== 'register') {\n",
    'blocks lock changes through D6-01 when the asset is not in the current upstream account',
  ],
  [
    'operation-key-domain-lock-classification',
    "      input.operation === 'domain_lock' ||\n",
    '      false ||\n',
    'binds lock idempotency to the requested direction without exposing mutable input',
  ],
]) {
  add({
    file: operationsFile,
    group: 'd6-write-callpoint',
    id,
    edits: [edit(search, replacement)],
    testFile: test.includes('idempotency') ? contractTest : undefined,
    test,
  })
}

const providerContractTest =
  'uses only the documented setlock contract and maps lock direction to val'
for (const [id, search, replacement, options] of [
  ['setlock-act', "        act: 'setlock',\n", "        act: 'mutated',\n"],
  [
    'setlock-domain',
    "        act: 'setlock',\n        domain: asciiDomain(input.domainAscii),\n        status: 'update',\n",
    "        act: 'setlock',\n        status: 'update',\n",
  ],
  ['setlock-status', "        status: 'update',\n", "        status: 'mutated',\n"],
  [
    'setlock-lock-val',
    "        val: input.locked ? '1' : '0',\n",
    "        val: input.locked ? '0' : '1',\n",
  ],
  ['setlock-operation', "      operation: 'domain_lock',\n", "      operation: 'nameserver',\n"],
  [
    'setlock-success-state',
    "state: 'succeeded' as const",
    "state: 'accepted' as const",
    { expectedOccurrences: 4, occurrence: 1 },
  ],
  [
    'setlock-path',
    "      path: '/v2/domain/',\n",
    "      path: '/v2/audit/',\n",
    { expectedOccurrences: 12, occurrence: 3 },
  ],
  [
    'setlock-write',
    '      write: true,\n',
    '      write: false,\n',
    { expectedOccurrences: 13, occurrence: 5 },
  ],
]) {
  add({
    file: adapterFile,
    group: 'westdigital-lock-contract',
    id,
    edits: [edit(search, replacement, options)],
    testFile: contractTest,
    test: providerContractTest,
  })
}
add({
  file: guardFile,
  group: 'real-write-gate',
  id: 'domain-lock-existing-management-gate',
  edits: [edit("    operation === 'domain_lock' ||\n", '')],
  testFile: contractTest,
  test: 'keeps real lock writes under the existing disabled-by-default domain-management gate',
})

for (const [id, search, replacement] of [
  [
    'event-update-rejection',
    "        if (operation === 'update') throw new AppError(code, message, 409)\n",
    '        if (false) throw new AppError(code, message, 409)\n',
  ],
  [
    'event-delete-rejection',
    '        throw new AppError(code, message, 409)\n',
    '        return undefined\n',
  ],
]) {
  add({
    file: eventsFile,
    group: 'append-only-decision',
    id,
    edits: [edit(search, replacement)],
    test: 'keeps user-center change records append-only even with system override',
  })
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

function applyMutation(source, mutation) {
  let mutated = source
  for (const current of mutation.edits) {
    const found = occurrences(mutated, current.search)
    const expected = current.expectedOccurrences ?? 1
    if (found !== expected) throw new Error(`expected ${expected} occurrences, found ${found}`)
    mutated = replaceOccurrence(
      mutated,
      current.search,
      current.replacement,
      current.occurrence ?? 1,
    )
  }
  return mutated
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.group}\t${mutation.id}\t${mutation.testFile ?? integrationTest}\t${mutation.test}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      applyMutation(readFileSync(`${webRoot}/${mutation.file}`, 'utf8'), mutation)
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
  process.stderr.write(`No D9-C-1 decision mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  let mutated
  try {
    mutated = applyMutation(original, mutation)
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
        mutation.testFile ?? integrationTest,
        '-t',
        mutation.test,
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.testFile ?? integrationTest} :: ${mutation.test}\n`)
  process.stdout.write(`RAW_FAILURE ${failure}\n`)
  if (result?.status !== 0 && output.includes('AssertionError:')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`RAW_OUTPUT ${output.split('\n').slice(-30).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(
  `\nD9C1_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
