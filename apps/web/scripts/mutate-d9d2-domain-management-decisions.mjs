import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9d2-domain-management.integration.test.ts'
const contractTest = 'tests/unit/d9d2-domain-management-contract.test.ts'
const routesTest = 'tests/unit/d9d2-domain-management-routes.test.ts'
const managementFile = 'src/services/domains/domain-management.ts'
const assetsFile = 'src/services/domains/domain-assets.ts'
const operationsFile = 'src/services/providers/westdigital-operations.ts'
const adapterFile = 'src/providers/westdigital-write.ts'

const mutations = []
const add = (mutation) => mutations.push(mutation)
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })

for (const [capability, id] of [
  ['management_password_read', 'password-read'],
  ['management_password_write', 'password-write'],
  ['contact_information_update', 'contact-update'],
  ['template_transfer', 'template-transfer'],
  ['certificate_download', 'certificate'],
]) {
  add({
    file: managementFile,
    group: 'capability-callpoint',
    id: `capability-${id}`,
    edits: [
      edit(
        `  assertDomainCapability(\n    '${capability}',\n    options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES,\n  )\n`,
        '  void options.capabilities\n',
      ),
    ],
    test: 'returns dedicated capability errors at every implemented capability call point',
  })
}
add({
  file: assetsFile,
  group: 'capability-callpoint',
  id: 'capability-customer-sync',
  edits: [
    edit(
      "  assertDomainCapability('asset_sync', options.capabilities ?? WESTDIGITAL_DOMAIN_CAPABILITIES)\n",
      '  void options.capabilities\n',
    ),
  ],
  test: 'returns dedicated capability errors at every implemented capability call point',
})
add({
  file: assetsFile,
  group: 'capability-callpoint',
  id: 'capability-system-sync',
  edits: [edit("  assertDomainCapability('asset_sync', capabilities)\n", '  void capabilities\n')],
  testFile: contractTest,
  test: 'keeps the synchronization runner system-only and capability-gated before database access',
})

const a3Call = "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n"
for (let occurrence = 1; occurrence <= 5; occurrence += 1) {
  add({
    file: managementFile,
    group: 'a3-callpoint',
    id: `a3-domain-write-${occurrence}`,
    edits: [edit(a3Call, '  await Promise.resolve()\n', { expectedOccurrences: 5, occurrence })],
    test: 'applies A3 domain-write restrictions at every management operation call point',
  })
}

const managementOwnerCall =
  '  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord\n'
for (let occurrence = 1; occurrence <= 5; occurrence += 1) {
  add({
    file: managementFile,
    group: 'local-ownership-callpoint',
    id: `owned-management-asset-${occurrence}`,
    edits: [
      edit(
        managementOwnerCall,
        "  const asset = (await req.payload.findByID({ collection: 'domainAssets', id: assetId, overrideAccess: true, req })) as unknown as AssetRecord\n",
        { expectedOccurrences: 5, occurrence },
      ),
    ],
    test: 'enforces local asset ownership at every management, synchronization, and declaration call point',
  })
}
add({
  file: assetsFile,
  group: 'local-ownership-callpoint',
  id: 'owned-customer-sync-asset',
  edits: [
    edit(
      '  const asset = await findOwnedDomainAsset(req, assetId, options.customer)\n',
      "  const asset = (await req.payload.findByID({ collection: 'domainAssets', id: assetId, overrideAccess: true, req })) as unknown as AssetRecord\n",
    ),
  ],
  test: 'enforces local asset ownership at every management, synchronization, and declaration call point',
})
add({
  file: managementFile,
  group: 'local-ownership-callpoint',
  id: 'owned-capability-declaration-asset',
  edits: [
    edit(
      '  await findOwnedDomainAsset(req, assetId, options.customer)\n',
      '  await Promise.resolve()\n',
    ),
  ],
  test: 'enforces local asset ownership at every management, synchronization, and declaration call point',
})

const passwordRiskCall =
  '  const identities = await authorizePasswordRisk(req, options.customer, input)\n'
for (let occurrence = 1; occurrence <= 2; occurrence += 1) {
  add({
    file: managementFile,
    group: 'password-risk-callpoint',
    id: `password-risk-${occurrence}`,
    edits: [
      edit(
        passwordRiskCall,
        '  const identities = await activeCustomerIdentities(req, customerNumber(options.customer))\n',
        { expectedOccurrences: 2, occurrence },
      ),
    ],
    test: 'rejects password read and write independently without step-up or an active bound channel',
  })
}
add({
  file: managementFile,
  group: 'password-risk-decision',
  id: 'password-step-up-authorizer',
  edits: [
    edit('  await authorizeStepUpGrant(req, {\n', '  await Promise.resolve({\n', {
      expectedOccurrences: 2,
      occurrence: 1,
    }),
  ],
  test: 'rejects password read and write independently without step-up or an active bound channel',
})
add({
  file: managementFile,
  group: 'password-risk-decision',
  id: 'password-active-channel-required',
  edits: [edit('  if (!identities.length) {\n', '  if (false) {\n')],
  test: 'rejects password read and write independently without step-up or an active bound channel',
})
const notifyCall = '  await notifyFormerCustomerIdentities(\n'
for (let occurrence = 1; occurrence <= 2; occurrence += 1) {
  add({
    file: managementFile,
    group: 'bound-channel-notification-callpoint',
    id: `bound-channel-notification-${occurrence}`,
    edits: [edit(notifyCall, '  await Promise.resolve(\n', { expectedOccurrences: 2, occurrence })],
    test: 'returns password plaintext once, notifies every active provider, and never persists or logs the value',
  })
}

const realnameRiskCall = '  await authorizeRealnameChange(req, options.customer, input)\n'
for (let occurrence = 1; occurrence <= 2; occurrence += 1) {
  add({
    file: managementFile,
    group: 'realname-risk-callpoint',
    id: `realname-risk-${occurrence}`,
    edits: [
      edit(realnameRiskCall, '  await Promise.resolve()\n', {
        expectedOccurrences: 2,
        occurrence,
      }),
    ],
    test: 'rejects contact and transfer independently for foreign, unapproved, missing-step-up, and unconfirmed targets',
  })
}
add({
  file: managementFile,
  group: 'realname-risk-decision',
  id: 'realname-secondary-confirmation',
  edits: [edit('  if (input.confirmed !== true) {\n', '  if (false) {\n')],
  test: 'rejects contact and transfer independently for foreign, unapproved, missing-step-up, and unconfirmed targets',
})
add({
  file: managementFile,
  group: 'realname-risk-decision',
  id: 'realname-step-up-authorizer',
  edits: [
    edit('  await authorizeStepUpGrant(req, {\n', '  await Promise.resolve({\n', {
      expectedOccurrences: 2,
      occurrence: 2,
    }),
  ],
  test: 'rejects contact and transfer independently for foreign, unapproved, missing-step-up, and unconfirmed targets',
})
add({
  file: managementFile,
  group: 'template-owner-decision',
  id: 'template-current-customer',
  edits: [
    edit('    overrideAccess: false,\n', '    overrideAccess: true,\n'),
    edit(
      '      and: [{ id: { equals: templateId } }, { customer: { equals: customer.id } }],\n',
      '      and: [{ id: { equals: templateId } }],\n',
    ),
  ],
  test: 'rejects contact and transfer independently for foreign, unapproved, missing-step-up, and unconfirmed targets',
})
for (const mutation of [
  {
    id: 'template-status-approved',
    search: "    template.status !== 'approved' ||\n",
    replacement: '    false ||\n',
  },
  {
    id: 'template-provider-review-approved',
    search: "    template.providerReviewState !== 'approved' ||\n",
    replacement: '    false ||\n',
  },
  {
    id: 'template-provider-confirmed-at',
    search: "    typeof template.providerConfirmedAt !== 'string' ||\n",
    replacement: '    false ||\n',
  },
  {
    id: 'template-provider-id-documented-format',
    search: '    !/^\\d+$/u.test(template.providerTemplateId)\n',
    replacement: '    false\n',
  },
]) {
  add({
    file: managementFile,
    group: 'template-approval-coupling',
    edits: [edit(mutation.search, mutation.replacement)],
    test: 'requires every coupled approval fact before a realname template can change a domain',
    ...mutation,
  })
}

const upstreamReadCall =
  '  await assertUpstreamOwnership(req, asset, options.customer, options.provider, options.traceId)\n'
for (let occurrence = 1; occurrence <= 5; occurrence += 1) {
  add({
    file: managementFile,
    group: 'upstream-read-ownership-callpoint',
    id: `upstream-read-ownership-${occurrence}`,
    edits: [
      edit(upstreamReadCall, '  await Promise.resolve()\n', {
        expectedOccurrences: 5,
        occurrence,
      }),
    ],
    test:
      occurrence === 1 || occurrence === 5
        ? 'blocks every slice operation and an existing DNS write when upstream ownership is absent'
        : 'rechecks ownership before each management lease and rejects a concurrent sync-version change',
  })
}
add({
  file: operationsFile,
  group: 'upstream-write-ownership-callpoint',
  id: 'all-westdigital-domain-writes-preflight',
  edits: [
    edit(
      "    if (input.operation !== 'realname' && input.operation !== 'register') {\n",
      '    if (false) {\n',
    ),
  ],
  test: 'blocks every slice operation and an existing DNS write when upstream ownership is absent',
})
add({
  file: operationsFile,
  group: 'upstream-ownership-decision',
  id: 'upstream-query-must-be-ready',
  edits: [
    edit(
      "  if (queried.state === 'ready') return queried.data\n",
      '  if (false) return queried.data\n',
    ),
  ],
  test: 'updates one documented contact role and transfers only to an owned approved template',
})
add({
  file: operationsFile,
  group: 'upstream-ownership-decision',
  id: 'upstream-not-owned-code',
  edits: [
    edit(
      "    'problem' in queried && queried.problem.code === 'WESTDIGITAL_ASSET_NOT_IN_ACCOUNT'\n",
      '    false\n',
    ),
  ],
  test: 'blocks every slice operation and an existing DNS write when upstream ownership is absent',
})

add({
  file: operationsFile,
  group: 'password-secret-boundary',
  id: 'password-operation-key-excludes-secret',
  edits: [edit("      input.operation === 'domain_management_password' ||\n", '      false ||\n')],
  testFile: contractTest,
  test: 'does not bind a password operation key to the plaintext, its length, or a hash',
})

for (const field of ['expiresAt', 'nameservers', 'registeredAt', 'registrar', 'status']) {
  add({
    file: assetsFile,
    group: 'sync-fact-decision',
    id: `sync-fact-${field}`,
    edits: [edit(`    '${field}',\n`, '')],
    test: 'detects every synchronized fact independently and never replaces the local fact',
  })
}
add({
  file: assetsFile,
  group: 'sync-outcome-decision',
  id: 'sync-difference-not-matched',
  edits: [
    edit(
      "  const outcome = differences.length ? ('difference' as const) : ('matched' as const)\n",
      "  const outcome = 'matched' as const\n",
    ),
  ],
  test: 'detects every synchronized fact independently and never replaces the local fact',
})
add({
  file: assetsFile,
  group: 'sync-outcome-decision',
  id: 'sync-provider-not-owned',
  edits: [
    edit(
      "      providerErrorCode === 'WESTDIGITAL_ASSET_NOT_IN_ACCOUNT' ? 'not_owned' : 'ownership_unknown'\n",
      "      false ? 'not_owned' : 'ownership_unknown'\n",
    ),
  ],
  test: 'records not-owned synchronization state without overwriting local asset facts',
})
add({
  file: assetsFile,
  group: 'sync-state-decision',
  id: 'sync-ownership-not-owned-marker',
  edits: [edit("        : input.outcome === 'not_owned'\n", '        : false\n')],
  test: 'records not-owned synchronization state without overwriting local asset facts',
})
add({
  file: assetsFile,
  group: 'sync-state-decision',
  id: 'sync-review-pending-marker',
  edits: [
    edit(
      "    const review = input.outcome === 'matched' ? 'matched' : 'pending'\n",
      "    const review = 'matched'\n",
    ),
  ],
  test: 'records not-owned synchronization state without overwriting local asset facts',
})
add({
  file: assetsFile,
  group: 'sync-state-decision',
  id: 'sync-block-reason-not-owned',
  edits: [edit("      ownership === 'not_owned'\n", '      false\n')],
  test: 'records not-owned synchronization state without overwriting local asset facts',
})
add({
  file: assetsFile,
  group: 'sync-job-decision',
  id: 'sync-job-system-only',
  edits: [edit('  if (req.user) {\n', '  if (false) {\n')],
  testFile: contractTest,
  test: 'keeps the synchronization runner system-only and capability-gated before database access',
})

add({
  file: managementFile,
  group: 'transfer-state-decision',
  id: 'transfer-success-updates-local-fact',
  edits: [
    edit(
      "    if ('data' in result && result.data.status === 'succeeded') {\n",
      '    if (false) {\n',
    ),
  ],
  test: 'updates one documented contact role and transfers only to an owned approved template',
})
add({
  file: managementFile,
  group: 'certificate-decision',
  id: 'certificate-strict-base64',
  edits: [
    edit(
      '  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {\n',
      '  if (false) {\n',
    ),
  ],
  test: 'rejects a non-base64 certificate body before returning or confirming it',
})

for (const [name, code] of [
  ['asset_sync', 'DOMAIN_CAPABILITY_ASSET_SYNC_UNSUPPORTED'],
  ['certificate_download', 'DOMAIN_CAPABILITY_CERTIFICATE_DOWNLOAD_UNSUPPORTED'],
  ['contact_information_update', 'DOMAIN_CAPABILITY_CONTACT_INFORMATION_UPDATE_UNSUPPORTED'],
  ['management_password_read', 'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_READ_UNSUPPORTED'],
  ['management_password_write', 'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_WRITE_UNSUPPORTED'],
  ['realtime_transfer', 'DOMAIN_CAPABILITY_REALTIME_TRANSFER_UNSUPPORTED'],
  ['template_transfer', 'DOMAIN_CAPABILITY_TEMPLATE_TRANSFER_UNSUPPORTED'],
]) {
  add({
    file: 'src/services/domains/capabilities.ts',
    group: 'capability-code-decision',
    id: `capability-code-${name}`,
    edits: [
      edit(
        `unsupportedCode: '${code}',`,
        "unsupportedCode: 'DOMAIN_CAPABILITY_GENERIC_UNSUPPORTED',",
      ),
    ],
    testFile: contractTest,
    test: 'declares every slice capability explicitly and returns a dedicated code for each unsupported item',
  })
}
add({
  file: 'src/services/domains/capabilities.ts',
  group: 'capability-support-decision',
  id: 'realtime-transfer-explicitly-unsupported',
  edits: [
    edit(
      '  realtime_transfer: {\n    supported: false,\n',
      '  realtime_transfer: {\n    supported: true,\n',
    ),
  ],
  testFile: contractTest,
  test: 'declares every slice capability explicitly and returns a dedicated code for each unsupported item',
})
add({
  file: 'src/services/domains/capabilities.ts',
  group: 'capability-enforcement-decision',
  id: 'unsupported-capability-throws',
  edits: [edit('  if (value.supported) return\n', '  if (true) return\n')],
  testFile: contractTest,
  test: 'declares every slice capability explicitly and returns a dedicated code for each unsupported item',
})

for (const operation of [
  'domain_contact_update',
  'domain_management_password',
  'domain_template_transfer',
]) {
  add({
    file: 'src/lib/provider-write-guardrails.ts',
    group: 'real-write-gate-decision',
    id: `real-write-gate-${operation}`,
    edits: [edit(`    operation === '${operation}'`, '    false')],
    testFile: contractTest,
    test: 'keeps all real domain-management writes behind their dedicated disabled-by-default gate',
  })
}

add({
  file: 'src/collections/domain-management.ts',
  group: 'append-only-decision',
  id: 'append-only-update',
  edits: [edit("        if (operation === 'update') throw new AppError(code, message, 409)\n", '')],
  testFile: contractTest,
  test: 'keeps management and synchronization evidence append-only under system override',
})
add({
  file: 'src/collections/domain-management.ts',
  group: 'append-only-decision',
  id: 'append-only-delete',
  edits: [edit('        throw new AppError(code, message, 409)\n', '        return undefined\n')],
  testFile: contractTest,
  test: 'keeps management and synchronization evidence append-only under system override',
})

for (const mutation of [
  {
    id: 'job-exclusive',
    search: '    exclusive: true,\n',
    replacement: '    exclusive: false,\n',
    occurrence: 10,
    expectedOccurrences: 12,
  },
  {
    id: 'job-supersedes',
    search: '    supersedes: true,\n',
    replacement: '    supersedes: false,\n',
    occurrence: 10,
    expectedOccurrences: 12,
  },
  {
    id: 'job-no-retries',
    search: '  retries: 0,\n',
    replacement: '  retries: 1,\n',
    occurrence: 11,
    expectedOccurrences: 14,
  },
  {
    id: 'job-background-queue',
    search: "  queue: 'background',\n",
    replacement: "  queue: 'commerce',\n",
    occurrence: 7,
    expectedOccurrences: 8,
  },
  {
    id: 'job-daily-schedule',
    search: "  schedule: [{ cron: '0 15 1 * * *', queue: 'background' }],\n",
    replacement: '  schedule: [],\n',
  },
]) {
  add({
    file: 'src/jobs/config.ts',
    group: 'sync-job-contract',
    edits: [edit(mutation.search, mutation.replacement, mutation)],
    testFile: contractTest,
    test: 'runs upstream asset synchronization as one exclusive background schedule with no retries',
    ...mutation,
  })
}

for (let occurrence = 1; occurrence <= 4; occurrence += 1) {
  add({
    file: 'src/schemas/domain-management.ts',
    group: 'request-schema-decision',
    id: `request-strict-object-${occurrence}`,
    edits: [edit('z.strictObject({', 'z.object({', { expectedOccurrences: 8, occurrence })],
    testFile: contractTest,
    test: 'uses strict risk inputs without accepting a client-asserted bound-channel outcome',
  })
}
add({
  file: 'src/schemas/domain-management.ts',
  group: 'request-schema-decision',
  id: 'password-minimum-length',
  edits: [
    edit(
      'managementPassword: z.string().min(8).max(128),',
      'managementPassword: z.string().min(1).max(128),',
    ),
  ],
  testFile: contractTest,
  test: 'uses strict risk inputs without accepting a client-asserted bound-channel outcome',
})
add({
  file: 'src/schemas/domain-management.ts',
  group: 'request-schema-decision',
  id: 'secondary-confirmation-literal',
  edits: [edit('  confirmed: z.literal(true),\n', '  confirmed: z.boolean(),\n')],
  testFile: contractTest,
  test: 'uses strict risk inputs without accepting a client-asserted bound-channel outcome',
})

for (const file of [
  'src/app/api/v1/domains/[assetId]/capabilities/route.ts',
  'src/app/api/v1/domains/[assetId]/certificate/route.ts',
  'src/app/api/v1/domains/[assetId]/contact-information/route.ts',
  'src/app/api/v1/domains/[assetId]/management-password/route.ts',
  'src/app/api/v1/domains/[assetId]/template-transfer/route.ts',
]) {
  const name = file.split('/').at(-2)
  add({
    file,
    group: 'route-auth-callpoint',
    id: `route-auth-${name}`,
    edits: [
      edit(
        '      const authenticated = await dependencies.resolveContext(request)\n',
        "      const authenticated = { customer: { collection: 'customers', id: 42, status: 'active' }, req: {} } as never\n",
      ),
    ],
    testFile: routesTest,
    test: 'fails closed at the authenticated-customer gate for every route call point',
  })
  add({
    file,
    group: 'route-asset-id-callpoint',
    id: `route-asset-id-${name}`,
    edits: [edit('domainManagementAssetIdSchema.parse(assetId)', '7')],
    testFile: routesTest,
    test: 'rejects invalid ids, missing risk fields, unexpected fields, wrong media, and oversized bodies',
  })
}

for (const mutation of [
  {
    id: 'request-content-type',
    search:
      "  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {\n",
    replacement: '  if (false) {\n',
  },
  {
    id: 'request-declared-size',
    search: '  if (declared > MAX_BODY_BYTES) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'request-actual-size',
    search: '  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'request-json-parse',
    search: "    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)\n",
    replacement: "    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'mutated', 415)\n",
  },
]) {
  add({
    file: 'src/app/api/v1/domains/_domain-management-request.ts',
    group: 'route-request-decision',
    edits: [edit(mutation.search, mutation.replacement)],
    testFile: routesTest,
    test: 'rejects invalid ids, missing risk fields, unexpected fields, wrong media, and oversized bodies',
    ...mutation,
  })
}
add({
  file: 'src/lib/errors.ts',
  group: 'response-cache-decision',
  id: 'json-success-no-store',
  edits: [
    edit(
      "  headers.set('cache-control', 'no-store')\n",
      "  headers.set('cache-control', 'public')\n",
    ),
  ],
  testFile: routesTest,
  test: 'returns no-store for password reveal and modification, contact, transfer, certificate, and capabilities',
})
add({
  file: 'src/app/api/v1/domains/[assetId]/certificate/route.ts',
  group: 'response-cache-decision',
  id: 'certificate-no-store',
  edits: [
    edit("          'cache-control': 'no-store',\n", "          'cache-control': 'public',\n"),
  ],
  testFile: routesTest,
  test: 'returns no-store for password reveal and modification, contact, transfer, certificate, and capabilities',
})
add({
  file: 'src/app/api/v1/domains/[assetId]/certificate/route.ts',
  group: 'certificate-response-decision',
  id: 'certificate-attachment-filename',
  edits: [
    edit(
      '          \'content-disposition\': `attachment; filename="${result.domainAscii}.certificate"`,\n',
      "          'content-disposition': 'inline',\n",
    ),
  ],
  testFile: routesTest,
  test: 'returns no-store for password reveal and modification, contact, transfer, certificate, and capabilities',
})

const adapterContractTest =
  'sends only the exact documented West Digital acts, paths, and field names'
for (const mutation of [
  {
    id: 'get-password-act',
    search: "body: { act: 'getpwd', domain: asciiDomain(input.domainAscii) }",
    replacement: "body: { act: 'mutated', domain: asciiDomain(input.domainAscii) }",
  },
  {
    id: 'get-password-domain',
    search: "body: { act: 'getpwd', domain: asciiDomain(input.domainAscii) }",
    replacement: "body: { act: 'getpwd' }",
  },
  {
    id: 'modify-password-act',
    search: "        act: 'modpwd',\n",
    replacement: "        act: 'mutated',\n",
  },
  {
    id: 'modify-password-domain',
    search: '        domain: asciiDomain(input.domainAscii),\n',
    replacement: '',
    occurrence: 5,
    expectedOccurrences: 7,
  },
  {
    id: 'modify-password-value',
    search: '        domainpwd: z.string().min(8).max(128).parse(input.managementPassword),\n',
    replacement: "        domainpwd: 'mutated',\n",
  },
  {
    id: 'contact-profile-fields',
    search: '    const fields = mapWestDigitalRealnameCreateFields(input.profile)\n',
    replacement:
      '    const fields = Object.fromEntries(Object.keys(mapWestDigitalRealnameCreateFields(input.profile)).map((key) => [key, undefined])) as ReturnType<typeof mapWestDigitalRealnameCreateFields>\n',
  },
  {
    id: 'contact-act',
    search: "        act: 'domainmodisub',\n",
    replacement: "        act: 'mutated',\n",
  },
  {
    id: 'contact-domain',
    search: '        domain: asciiDomain(input.domainAscii),\n',
    replacement: '',
    occurrence: 6,
    expectedOccurrences: 7,
  },
  {
    id: 'contact-role',
    search:
      "        eppidtype: z.enum(['dom_id', 'admin_id', 'tech_id', 'bill_id']).parse(input.contactType),\n",
    replacement: "        eppidtype: 'dom_id',\n",
  },
  {
    id: 'template-transfer-act',
    search: "        act: 'auditghsub',\n",
    replacement: "        act: 'mutated',\n",
  },
  {
    id: 'template-transfer-id',
    search: '        c_sysid: z.string().regex(/^\\d+$/u).parse(input.providerTemplateId),\n',
    replacement: "        c_sysid: '999',\n",
    occurrence: 1,
    expectedOccurrences: 2,
  },
  {
    id: 'template-transfer-domain',
    search: '        domain: asciiDomain(input.domainAscii),\n',
    replacement: '',
    occurrence: 7,
    expectedOccurrences: 7,
  },
  {
    id: 'template-transfer-roles',
    search: "        eppidtype: 'dom_id,admin_id,tech_id,bill_id',\n",
    replacement: "        eppidtype: 'dom_id',\n",
  },
  {
    id: 'domain-information-act',
    search: "body: { act: 'domaininfo', domain: expected }",
    replacement: "body: { act: 'mutated', domain: expected }",
  },
  {
    id: 'domain-information-domain',
    search: "body: { act: 'domaininfo', domain: expected }",
    replacement: "body: { act: 'domaininfo' }",
  },
  {
    id: 'certificate-act',
    search: "body: { act: 'cert', domain: asciiDomain(input.domainAscii), img: '1' }",
    replacement: "body: { act: 'mutated', domain: asciiDomain(input.domainAscii), img: '1' }",
  },
  {
    id: 'certificate-domain',
    search: "body: { act: 'cert', domain: asciiDomain(input.domainAscii), img: '1' }",
    replacement: "body: { act: 'cert', img: '1' }",
  },
  {
    id: 'certificate-image-mode',
    search: "body: { act: 'cert', domain: asciiDomain(input.domainAscii), img: '1' }",
    replacement: "body: { act: 'cert', domain: asciiDomain(input.domainAscii) }",
  },
]) {
  add({
    file: adapterFile,
    group: 'westdigital-request-contract',
    edits: [edit(mutation.search, mutation.replacement, mutation)],
    testFile: contractTest,
    test: adapterContractTest,
    ...mutation,
  })
}
for (const [id, search, occurrence, expectedOccurrences] of [
  ['get-password-path', "      path: '/v2/domain/',\n", 9, 11],
  ['modify-password-path', "      path: '/v2/domain/',\n", 10, 11],
  ['contact-path', "      path: '/v2/audit/',\n", 3, 6],
  ['template-transfer-path', "      path: '/v2/audit/',\n", 4, 6],
  ['domain-information-path', "      path: '/v2/audit/',\n", 5, 6],
  ['certificate-path', "      path: '/v2/domain/',\n", 11, 11],
]) {
  add({
    file: adapterFile,
    group: 'westdigital-request-contract',
    id,
    edits: [edit(search, "      path: '/v2/mutated/',\n", { occurrence, expectedOccurrences })],
    testFile: contractTest,
    test: adapterContractTest,
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
    if (found !== expected) {
      throw new Error(`expected ${expected} occurrences, found ${found}`)
    }
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
  process.stderr.write(`No D9-D-2 decision mutations matched: ${selectors.join(', ')}\n`)
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
  `\nD9D2_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
