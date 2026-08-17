import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9d1-dns-records.integration.test.ts'
const contractTest = 'tests/unit/d9d1-dns-management-contract.test.ts'
const routesTest = 'tests/unit/d9d1-dns-routes.test.ts'
const adapterTest = 'tests/unit/westdigital-write.test.ts'
const serviceFile = 'src/services/domains/dns-records.ts'
const operationsFile = 'src/services/providers/westdigital-operations.ts'
const adapterFile = 'src/providers/westdigital-write.ts'
const lineFile = 'src/providers/westdigital-dns.ts'
const schemaFile = 'src/schemas/dns-management.ts'
const collectionFile = 'src/collections/dns-management.ts'
const nameserverFile = 'src/services/domains/nameserver-changes.ts'

const mutations = []
const add = (mutation) => mutations.push(mutation)

const capabilityCall =
  "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n"
for (let occurrence = 1; occurrence <= 6; occurrence += 1) {
  add({
    file: serviceFile,
    group: 'a3-callpoint',
    id: `a3-domain-write-${occurrence}`,
    search: capabilityCall,
    replacement: '  await Promise.resolve()\n',
    occurrence,
    expectedOccurrences: 6,
    test: 'applies the A3 domain-write capability gate at every DNS mutation entry point',
  })
}

const ownershipCall =
  '  const asset = (await findOwnedDomainAsset(req, assetId, options.customer)) as AssetRecord\n'
for (let occurrence = 1; occurrence <= 8; occurrence += 1) {
  add({
    file: serviceFile,
    group: 'ownership-callpoint',
    id: `owned-domain-asset-${occurrence}`,
    search: ownershipCall,
    replacement:
      "  const asset = (await req.payload.findByID({ collection: 'domainAssets', id: assetId, overrideAccess: true, req })) as unknown as AssetRecord\n",
    occurrence,
    expectedOccurrences: 8,
    test: 'enforces asset ownership independently at every DNS read and mutation call point',
  })
}

for (const mutation of [
  {
    id: 'provider-query-failure-preflight',
    search: '  if (!queried.ok) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'provider-query-failure-list',
    search:
      '  if (!queried.ok) return dnsRecordListResultSchema.parse(queryFailure(queried, options.traceId))\n',
    replacement: '  if (false) return undefined as never\n',
  },
  {
    id: 'provider-query-failure-detail',
    search:
      '  if (!queried.ok) return dnsRecordDetailResultSchema.parse(queryFailure(queried, options.traceId))\n',
    replacement: '  if (false) return undefined as never\n',
  },
  {
    id: 'provider-query-rate-limited-state',
    search: "  return result.error.code === 'WESTDIGITAL_RATE_LIMITED'\n",
    replacement: '  return false\n',
  },
]) {
  add({
    file: serviceFile,
    group: 'provider-query-failure-decision',
    test: 'returns bounded query failures and never converts them into a local DNS fact',
    ...mutation,
  })
}
add({
  file: serviceFile,
  group: 'record-existence-decision',
  id: 'record-existence-preflight',
  search:
    "  if (!record) throw new AppError('DNS_RECORD_NOT_FOUND', '未找到指定 DNS 解析记录', 404)\n",
  replacement: '  if (false) throw new Error()\n',
  occurrence: 1,
  expectedOccurrences: 2,
  test: 'rejects an absent provider record at the modify preflight call point',
})
add({
  file: serviceFile,
  group: 'record-existence-decision',
  id: 'record-existence-detail',
  search:
    "  if (!record) throw new AppError('DNS_RECORD_NOT_FOUND', '未找到指定 DNS 解析记录', 404)\n",
  replacement: '  if (false) throw new Error()\n',
  occurrence: 2,
  expectedOccurrences: 2,
  test: 'returns not-found for a provider record id that is absent from the owned domain',
})

for (const route of [
  { file: 'src/app/api/v1/domains/[assetId]/dns-records/route.ts', count: 2, prefix: 'collection' },
  {
    file: 'src/app/api/v1/domains/[assetId]/dns-records/[recordId]/route.ts',
    count: 3,
    prefix: 'item',
  },
  {
    file: 'src/app/api/v1/domains/[assetId]/dns-records/[recordId]/status/route.ts',
    count: 1,
    prefix: 'status',
  },
  {
    file: 'src/app/api/v1/domains/[assetId]/dns-records/batch-delete/preview/route.ts',
    count: 1,
    prefix: 'preview',
  },
  {
    file: 'src/app/api/v1/domains/[assetId]/dns-records/batch-delete/route.ts',
    count: 1,
    prefix: 'batch-delete',
  },
]) {
  for (let occurrence = 1; occurrence <= route.count; occurrence += 1) {
    add({
      file: route.file,
      group: 'route-auth-callpoint',
      id: `route-auth-${route.prefix}-${occurrence}`,
      search: '      const authenticated = await dependencies.resolveContext(request)\n',
      replacement:
        "      const authenticated = { customer: { collection: 'customers', id: 1, status: 'active' }, req: {} } as never\n",
      occurrence,
      expectedOccurrences: route.count,
      testFile: routesTest,
      test: 'fails closed at the authenticated-customer gate for every DNS route call point',
    })
  }
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
    replacement: "    throw new Error('mutated invalid JSON')\n",
  },
]) {
  add({
    file: 'src/app/api/v1/domains/_dns-request.ts',
    group: 'route-request-decision',
    testFile: routesTest,
    test: 'rejects unknown query fields, invalid ids, unexpected body fields, wrong media, and oversized bodies',
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'risk-mx-type',
    search: "    record.type === 'MX' ||\n",
    replacement: '    false ||\n',
    test: 'rejects MX without its purpose-bound step-up grant',
  },
  {
    id: 'risk-txt-type',
    search: "    record.type === 'TXT' ||\n",
    replacement: '    false ||\n',
    test: 'rejects root TXT without its purpose-bound step-up grant',
  },
  {
    id: 'risk-txt-root-only',
    search: "    record.type === 'TXT' ||\n",
    replacement: "    (record.host === '@' && record.type === 'TXT') ||\n",
    test: 'rejects _acme-challenge TXT without its purpose-bound step-up grant',
  },
  {
    id: 'risk-root-aaaa-type',
    search: "    (record.host === '@' && ['A', 'AAAA', 'CNAME'].includes(record.type))\n",
    replacement: "    (record.host === '@' && ['A', 'CNAME'].includes(record.type))\n",
    test: 'rejects root AAAA without its purpose-bound step-up grant',
  },
  {
    id: 'risk-root-host',
    search: "    (record.host === '@' && ['A', 'AAAA', 'CNAME'].includes(record.type))\n",
    replacement: "    (false && ['A', 'AAAA', 'CNAME'].includes(record.type))\n",
    test: 'rejects root A without its purpose-bound step-up grant',
  },
  {
    id: 'risk-root-record-types',
    search: "    (record.host === '@' && ['A', 'AAAA', 'CNAME'].includes(record.type))\n",
    replacement: "    (record.host === '@' && false)\n",
    test: 'rejects root CNAME without its purpose-bound step-up grant',
  },
  {
    id: 'risk-secondary-confirmation',
    search: '  if (input.confirmed !== true) {\n',
    replacement: '  if (false) {\n',
    test: 'requires secondary confirmation independently from a valid root-record step-up grant',
  },
  {
    id: 'risk-device-required',
    search: '  if (!input.deviceId || !input.stepUpToken) {\n',
    replacement: '  if (false || !input.stepUpToken) {\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'requires the high-risk deviceId even when the other step-up field is present',
  },
  {
    id: 'risk-token-required',
    search: '  if (!input.deviceId || !input.stepUpToken) {\n',
    replacement: '  if (!input.deviceId || false) {\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'requires the high-risk stepUpToken even when the other step-up field is present',
  },
  {
    id: 'risk-purpose-mx',
    search: "    purpose: record.type === 'MX' ? 'mx_record_change' : 'dns_record_change',\n",
    replacement: "    purpose: 'dns_record_change',\n",
    test: 'accepts confirmed root A and MX changes with their distinct step-up purposes',
  },
  {
    id: 'risk-step-up-authorizer',
    search: '  await authorizeStepUpGrant(req, {\n',
    replacement: '  await Promise.resolve({\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'rejects a purpose-mismatched high-risk grant before a provider write',
  },
]) {
  add({ file: serviceFile, group: 'record-risk-decision', ...mutation })
}

const recordRiskCall =
  '    await authorizeRecordRisk(req, options.customer.id, replay.change.requestedRecord!, input)\n'
for (const [occurrence, operation] of ['add', 'modify', 'delete', 'pause'].entries()) {
  add({
    file: serviceFile,
    group: 'record-risk-replay-callpoint',
    id: `record-risk-replay-${operation}`,
    search: recordRiskCall,
    replacement: '    await Promise.resolve()\n',
    occurrence: occurrence + 1,
    expectedOccurrences: 4,
    test: `rechecks high-risk authorization at the ${operation} idempotent-replay call point`,
  })
}

const normalRiskCalls = [
  {
    id: 'record-risk-add-callpoint',
    search: '  await authorizeRecordRisk(req, options.customer.id, requestedRecord, input)\n',
    replacement: '  await Promise.resolve()\n',
    test: 'rejects root A without its purpose-bound step-up grant',
  },
  ...['modify', 'delete', 'pause'].map((operation, index) => ({
    id: `record-risk-${operation}-callpoint`,
    search: '    await authorizeRecordRisk(req, options.customer.id, before, input)\n',
    replacement: '    await Promise.resolve()\n',
    occurrence: index + 1,
    expectedOccurrences: 3,
    test: `rejects high-risk root A ${operation} at its own call point without step-up`,
  })),
]
for (const mutation of normalRiskCalls) {
  add({ file: serviceFile, group: 'record-risk-callpoint', ...mutation })
}

for (const [occurrence, operation, test] of [
  [
    1,
    'add',
    'replays one stable business key without writing and permits a later re-add with a new key',
  ],
  [2, 'modify', 'modifies, pauses with val 1, resumes with val 0, and deletes one record'],
  [3, 'delete', 'modifies, pauses with val 1, resumes with val 0, and deletes one record'],
  [4, 'pause', 'modifies, pauses with val 1, resumes with val 0, and deletes one record'],
]) {
  add({
    file: serviceFile,
    group: 'idempotent-replay-callpoint',
    id: `idempotent-replay-${operation}`,
    search: '  if (replay) {\n',
    replacement: '  if (false) {\n',
    occurrence,
    expectedOccurrences: 4,
    test,
  })
}
for (const [occurrence, operation] of ['modify', 'delete', 'pause'].entries()) {
  add({
    file: serviceFile,
    group: 'idempotent-replay-intent',
    id: `replay-provider-record-id-${operation}`,
    search: '    const replayRecordId = requireReplayProviderRecordId(replay.change)\n',
    replacement: '    const replayRecordId = providerRecordId\n',
    occurrence: occurrence + 1,
    expectedOccurrences: 3,
    test: 'modifies, pauses with val 1, resumes with val 0, and deletes one record',
  })
}

for (const mutation of [
  {
    id: 'batch-device-required',
    search: '  if (!input.deviceId || !input.stepUpToken) {\n',
    replacement: '  if (false || !input.stepUpToken) {\n',
    occurrence: 2,
    expectedOccurrences: 2,
  },
  {
    id: 'batch-token-required',
    search: '  if (!input.deviceId || !input.stepUpToken) {\n',
    replacement: '  if (!input.deviceId || false) {\n',
    occurrence: 2,
    expectedOccurrences: 2,
  },
  {
    id: 'batch-step-up-authorizer',
    search: '  await authorizeStepUpGrant(req, {\n',
    replacement: '  await Promise.resolve({\n',
    occurrence: 2,
    expectedOccurrences: 2,
  },
]) {
  add({
    file: serviceFile,
    group: 'batch-step-up',
    test: 'requires step-up and a bound preview before batch deletion, then deletes exactly previewed records',
    ...mutation,
  })
}

for (const mutation of [
  { id: 'preview-token-extra-part', search: '    extra ||\n', replacement: '    false ||\n' },
  {
    id: 'preview-token-signature-format',
    search: '    !/^[a-f0-9]{64}$/iu.test(signature) ||\n',
    replacement: '    false ||\n',
  },
  {
    id: 'preview-token-signature-value',
    search: '    !safeEqualHex(hmac(encoded, getEnv().SESSION_PEPPER), signature)\n',
    replacement: '    false\n',
  },
  {
    id: 'preview-version',
    search: '    payload.version !== 1 ||\n',
    replacement: '    false ||\n',
  },
  {
    id: 'preview-asset',
    search: '    payload.assetId !== String(input.assetId) ||\n',
    replacement: '    false ||\n',
  },
  {
    id: 'preview-expiry-present',
    search: '    !payload.expiresAt ||\n',
    replacement: '    false ||\n',
  },
  {
    id: 'preview-expiry-fresh',
    search: '    new Date(payload.expiresAt).getTime() <= Date.now() ||\n',
    replacement: '    false ||\n',
  },
  {
    id: 'preview-record-ids-exact',
    search: '    JSON.stringify(payload.recordIds) !== JSON.stringify(input.recordIds) ||\n',
    replacement: '    false ||\n',
  },
  {
    id: 'preview-record-digest-present',
    search: "    typeof payload.recordDigest !== 'string'\n",
    replacement: '    false\n',
  },
]) {
  add({
    file: serviceFile,
    group: 'preview-binding-decision',
    test: 'binds batch preview signatures, version, asset, expiry, ids, and record digest',
    ...mutation,
  })
}
add({
  file: serviceFile,
  group: 'preview-binding-decision',
  id: 'preview-json-parse',
  search:
    "    throw new AppError('DNS_RECORD_PREVIEW_INVALID', '批量删除预览无效或已被修改', 409)\n",
  replacement: "    throw new Error('mutated preview parse failure')\n",
  occurrence: 2,
  expectedOccurrences: 2,
  test: 'binds batch preview signatures, version, asset, expiry, ids, and record digest',
})
add({
  file: serviceFile,
  group: 'batch-decision',
  id: 'batch-duplicate-record-id',
  search: '  if (unique.length !== recordIds.length) {\n',
  replacement: '  if (false) {\n',
  test: 'requires step-up and a bound preview before batch deletion, then deletes exactly previewed records',
})
add({
  file: serviceFile,
  group: 'batch-decision',
  id: 'batch-preview-stale-digest',
  search: '    if (recordsDigest(records) !== preview.recordDigest) {\n',
  replacement: '    if (false) {\n',
  test: 'rejects a stale batch preview before any provider write',
})

for (const mutation of [
  {
    id: 'rate-batch-delta-ceiling',
    search: '  if (changeDelta > limit) {\n',
    replacement: '  if (false) {\n',
    test: 'rejects a batch whose change count alone exceeds the configured per-minute limit',
  },
  {
    id: 'lease-claim-returned-row',
    search: '    if (claimed.rows?.[0]?.id !== undefined) return\n',
    replacement: '    if (false) return\n',
    test: 'adds an ordinary subdomain without step-up and records scoped append-only audit history',
  },
]) {
  add({ file: serviceFile, group: 'mutation-admission-decision', ...mutation })
}

for (const mutation of [
  {
    id: 'add-record-count-ceiling',
    search: '    if (records.total >= getEnv().DNS_RECORD_MAX_PER_DOMAIN) {\n',
    replacement: '    if (false) {\n',
  },
  {
    id: 'add-duplicate-host',
    search: '          record.host === requestedRecord.host &&\n',
    replacement: '          true &&\n',
    test: 'does not collapse distinct DNS records that differ by host',
  },
  {
    id: 'add-duplicate-line',
    search: '          record.lineCode === requestedRecord.lineCode &&\n',
    replacement: '          true &&\n',
    test: 'does not collapse distinct DNS records that differ by line',
  },
  {
    id: 'add-duplicate-type',
    search: '          record.type === requestedRecord.type &&\n',
    replacement: '          true &&\n',
    test: 'does not collapse distinct DNS records that differ by type',
  },
  {
    id: 'add-duplicate-value',
    search: '          record.value === requestedRecord.value,\n',
    replacement: '          true,\n',
    test: 'does not collapse distinct DNS records that differ by value',
  },
]) {
  add({
    file: serviceFile,
    group: 'add-correctness-decision',
    test: mutation.test ?? 'rejects duplicate and over-limit adds before a provider write',
    ...mutation,
  })
}

add({
  file: serviceFile,
  group: 'audit-callpoint',
  id: 'change-event-audit-callpoint',
  search: '      await recordAuditEvent(req, {\n',
  replacement: '      await Promise.resolve({\n',
  test: 'adds an ordinary subdomain without step-up and records scoped append-only audit history',
})
add({
  file: serviceFile,
  group: 'provider-executor-callpoint',
  id: 'd6-executor-callpoint',
  search:
    '  const executed = await executeWestDigitalWriteOperation(req, input.writeInput, input.provider)\n',
  replacement:
    "  const executed = { meta: { dataSource: 'mutated', traceId: input.traceId }, state: 'degraded' } as never\n",
  test: 'adds an ordinary subdomain without step-up and records scoped append-only audit history',
})
for (const mutation of [
  {
    id: 'operation-status-succeeded',
    search: "  if (operation.status === 'succeeded') return 'succeeded'\n",
    replacement: "  if (false) return 'succeeded'\n",
    test: 'adds an ordinary subdomain without step-up and records scoped append-only audit history',
  },
  {
    id: 'operation-status-failed',
    search: "  if (operation.status === 'failed') return 'failed'\n",
    replacement: "  if (false) return 'failed'\n",
    test: 'records an explicit upstream rejection as failed without a local DNS fact',
  },
]) {
  add({ file: serviceFile, group: 'operation-status-decision', ...mutation })
}
add({
  file: serviceFile,
  group: 'local-fact-decision',
  id: 'confirmed-record-excludes-delete',
  search: "    status === 'succeeded' && input.operation !== 'delete'\n",
  replacement: "    status === 'succeeded' && true\n",
  test: 'modifies, pauses with val 1, resumes with val 0, and deletes one record',
})

for (const [field, testField] of [
  ['actual.host === expected.host &&\n', 'host'],
  ['actual.lineCode === expected.lineCode &&\n', 'line'],
  ['actual.priority === expected.priority &&\n', 'priority'],
  ['actual.ttl === expected.ttl &&\n', 'ttl'],
  ['actual.type === expected.type &&\n', 'type'],
  ['actual.value === expected.value\n', 'value'],
]) {
  add({
    file: operationsFile,
    group: 'provider-confirmation-dimension',
    id: `confirmation-${testField}`,
    search: `    ${field}`,
    replacement: field.endsWith('&&\n') ? '    true &&\n' : '    true\n',
    test: `does not confirm an add when the queried ${testField} differs from the requested record`,
  })
}
add({
  file: adapterFile,
  group: 'provider-confirmation-dimension',
  id: 'confirmation-record-id-filter',
  search: '          .filter((record) => !expectedRecordId || record.id === expectedRecordId)\n',
  replacement: '          .filter(() => true)\n',
  test: 'does not confirm an add when the queried record id differs from the requested record',
})
add({
  file: operationsFile,
  group: 'provider-confirmation-decision',
  id: 'confirmation-delete-absence',
  search:
    '      return !result.data.items.some((record) => record.id === input.providerRecordId)\n',
  replacement: '      return false\n',
  test: 'modifies, pauses with val 1, resumes with val 0, and deletes one record',
})
add({
  file: operationsFile,
  group: 'provider-confirmation-decision',
  id: 'confirmation-pause-state',
  search: '      return matching.length === 1 && matching[0]?.paused === input.paused\n',
  replacement: '      return matching.length === 1 && true\n',
  test: 'does not confirm pause when the provider keeps the record enabled',
})
add({
  file: operationsFile,
  group: 'provider-query-only-decision',
  id: 'unknown-replay-query-only',
  search: "  if (operation.status === 'submitted' || operation.status === 'unknown') {\n",
  replacement: '  if (false) {\n',
  test: 'keeps an unknown upstream write pending-query and replays only status queries',
})
add({
  file: operationsFile,
  group: 'provider-query-only-decision',
  id: 'add-query-provider-record-id',
  search:
    "      input.operation === 'dns_record_add' ? providerRecordId(operation) : input.providerRecordId\n",
  replacement: "      input.operation === 'dns_record_add' ? undefined : input.providerRecordId\n",
  test: 'does not confirm an add when the queried record id differs from the requested record',
})

add({
  file: operationsFile,
  group: 'provider-business-key-callpoint',
  id: 'operation-key-dns-business-path',
  search: '  if (dnsOperation(input) && input.businessKey) {\n',
  replacement: '  if (false) {\n',
  test: 'replays one stable business key without writing and permits a later re-add with a new key',
})
for (const mutation of [
  {
    id: 'operation-key-business-key',
    search: '        businessKey: input.businessKey,\n',
    replacement: "        businessKey: 'mutated',\n",
  },
  {
    id: 'operation-key-operation',
    search: '  return `westdigital:${input.operation}:${String(input.targetId)}:${digest}`\n',
    replacement: '  return `westdigital:dns_record_add:${String(input.targetId)}:${digest}`\n',
    occurrence: 1,
    expectedOccurrences: 2,
  },
  {
    id: 'operation-key-target-id',
    search: '  return `westdigital:${input.operation}:${String(input.targetId)}:${digest}`\n',
    replacement: '  return `westdigital:${input.operation}:1:${digest}`\n',
    occurrence: 1,
    expectedOccurrences: 2,
  },
]) {
  add({
    file: operationsFile,
    group: 'provider-business-key-dimension',
    testFile: contractTest,
    test: 'binds DNS provider-operation keys to business key, operation, and domain asset',
    ...mutation,
  })
}

for (const operation of ['add', 'modify', 'delete']) {
  add({
    file: operationsFile,
    group: 'provider-submit-callpoint',
    id: `provider-submit-${operation}`,
    search: `  if (input.operation === 'dns_record_${operation}') return dnsProvider.${operation === 'add' ? 'addDnsRecord' : operation === 'modify' ? 'modifyDnsRecord' : 'deleteDnsRecord'}(input)\n`,
    replacement:
      "  if (input.operation === 'dns_record_never') return dnsProvider.addDnsRecord(input as never)\n",
    test:
      operation === 'add'
        ? 'adds an ordinary subdomain without step-up and records scoped append-only audit history'
        : 'modifies, pauses with val 1, resumes with val 0, and deletes one record',
  })
}
add({
  file: operationsFile,
  group: 'provider-submit-callpoint',
  id: 'provider-submit-pause',
  search: '  return dnsProvider.setDnsRecordPaused(input)\n',
  replacement: '  return dnsProvider.addDnsRecord(input as never)\n',
  test: 'modifies, pauses with val 1, resumes with val 0, and deletes one record',
})

const dnsDomainLine = '        domain: asciiDomain(input.domainAscii),\n'
for (let occurrence = 1; occurrence <= 4; occurrence += 1) {
  add({
    file: adapterFile,
    group: 'westdigital-request-callpoint',
    id: `adapter-domain-${occurrence}`,
    search: dnsDomainLine,
    replacement: "        domain: 'mutated.example',\n",
    occurrence,
    expectedOccurrences: 4,
    testFile: adapterTest,
    test: 'maps the documented DNS record query and write contracts, including pause 1 and resume 0',
  })
}
for (const [field, count] of [
  ['host', 3],
  ['line', 3],
  ['type', 3],
  ['value', 3],
  ['level', 2],
  ['ttl', 2],
]) {
  const expression =
    field === 'line'
      ? 'record.lineCode'
      : field === 'level'
        ? 'String(record.priority)'
        : field === 'ttl'
          ? 'String(record.ttl)'
          : `record.${field}`
  for (let occurrence = 1; occurrence <= count; occurrence += 1) {
    add({
      file: adapterFile,
      group: 'westdigital-request-callpoint',
      id: `adapter-${field}-${occurrence}`,
      search: `\n        ${field}: ${expression},\n`,
      replacement: `\n        ${field}: 'mutated',\n`,
      occurrence,
      expectedOccurrences: count,
      testFile: adapterTest,
      test: 'maps the documented DNS record query and write contracts, including pause 1 and resume 0',
    })
  }
}
add({
  file: adapterFile,
  group: 'westdigital-request-callpoint',
  id: 'adapter-query-domain',
  search: "      act: 'getdnsrecord',\n      domain: asciiDomain(input.domainAscii),\n",
  replacement: "      act: 'getdnsrecord',\n      domain: 'mutated.example',\n",
  testFile: adapterTest,
  test: 'maps the documented DNS record query and write contracts, including pause 1 and resume 0',
})
for (let occurrence = 1; occurrence <= 3; occurrence += 1) {
  add({
    file: adapterFile,
    group: 'westdigital-request-callpoint',
    id: `adapter-record-id-${occurrence}`,
    search: '\n        id: z.string().regex(/^\\d+$/u).parse(input.providerRecordId),\n',
    replacement: "\n        id: '999999',\n",
    occurrence,
    expectedOccurrences: 3,
    testFile: adapterTest,
    test: 'maps the documented DNS record query and write contracts, including pause 1 and resume 0',
  })
}
for (const [field, expression] of [
  ['host', 'z.string().max(253).parse(input.host)'],
  ['type', 'managedDnsRecordTypeSchema.parse(input.type)'],
  ['value', 'z.string().max(2_048).parse(input.value)'],
]) {
  add({
    file: adapterFile,
    group: 'westdigital-request-callpoint',
    id: `adapter-query-${field}`,
    search: `    if (input.${field} !== undefined) body.${field} = ${expression}\n`,
    replacement: `    if (false) body.${field} = ${expression}\n`,
    testFile: adapterTest,
    test: 'maps the documented DNS record query and write contracts, including pause 1 and resume 0',
  })
}
for (const [id, search, replacement] of [
  ['adapter-act-add', "        act: 'adddnsrecord',\n", "        act: 'mutated',\n"],
  ['adapter-act-modify', "        act: 'moddnsrecord',\n", "        act: 'mutated',\n"],
  ['adapter-act-delete', "        act: 'deldnsrecord',\n", "        act: 'mutated',\n"],
  ['adapter-act-pause', "        act: 'pause',\n", "        act: 'mutated',\n"],
  ['adapter-act-query', "      act: 'getdnsrecord',\n", "      act: 'mutated',\n"],
  [
    'adapter-pause-value',
    "        val: input.paused ? '1' : '0',\n",
    "        val: input.paused ? '0' : '1',\n",
  ],
  [
    'adapter-query-limit',
    '      limit: String(z.number().int().min(1).max(500).parse(input.limit)),\n',
    "      limit: '1',\n",
  ],
  [
    'adapter-query-page',
    '      pageno: String(z.number().int().positive().parse(input.page)),\n',
    "      pageno: '2',\n",
  ],
  [
    'adapter-response-paused',
    '            paused: record.pause === 1,\n',
    '            paused: record.pause === 0,\n',
  ],
  ['adapter-response-host', "            host: record.item || '@',\n", "            host: '@',\n"],
  ['adapter-response-id', '            id: record.id,\n', "            id: '999999',\n"],
  ['adapter-response-line', '            lineCode: record.line,\n', "            lineCode: '',\n"],
  [
    'adapter-response-priority',
    '            priority: record.level,\n',
    '            priority: 99,\n',
  ],
  ['adapter-response-ttl', '            ttl: record.ttl,\n', '            ttl: 60,\n'],
  ['adapter-response-type', '            type: record.type,\n', "            type: 'AAAA',\n"],
  [
    'adapter-response-value',
    '            value: record.value,\n',
    "            value: '192.0.2.199',\n",
  ],
]) {
  add({
    file: adapterFile,
    group: 'westdigital-contract-decision',
    id,
    search,
    replacement,
    testFile: adapterTest,
    test: 'maps the documented DNS record query and write contracts, including pause 1 and resume 0',
  })
}

for (const [label, code] of Object.entries({
  SEO: 'LSEO',
  境外: 'LFOR',
  搜索引擎: 'LSEO',
  教育: 'LEDU',
  教育网: 'LEDU',
  默认: '',
  电信: 'LTEL',
  移动: 'LMOB',
  联通: 'LCNC',
})) {
  add({
    file: lineFile,
    group: 'line-mapping-dimension',
    id: `line-label-${Buffer.from(label).toString('hex')}`,
    search: `  ${label}: '${code}',\n`,
    replacement: `  ${label}: 'MUTATED',\n`,
    testFile: contractTest,
    test: 'maps every documented Chinese line and alias to the exact internal code',
  })
}
for (const [code, label] of Object.entries({
  "''": '默认',
  LCNC: '联通',
  LEDU: '教育网',
  LFOR: '境外',
  LMOB: '移动',
  LSEO: '搜索引擎',
  LTEL: '电信',
})) {
  add({
    file: lineFile,
    group: 'line-reverse-mapping-dimension',
    id: `line-code-${code.replaceAll("'", 'default')}`,
    search: `  ${code}: '${label}',\n`,
    replacement: `  ${code}: 'MUTATED',\n`,
    testFile: contractTest,
    test: 'maps every documented Chinese line and alias to the exact internal code',
  })
}

for (const mutation of [
  {
    id: 'schema-record-types',
    search:
      "export const managedDnsRecordTypeSchema = z.enum(['A', 'CNAME', 'MX', 'TXT', 'AAAA', 'SRV'])\n",
    replacement:
      "export const managedDnsRecordTypeSchema = z.enum(['A', 'CNAME', 'MX', 'TXT', 'AAAA'])\n",
    test: 'uses exactly the record types documented for the single-record West Digital API',
  },
  {
    id: 'schema-root-normalization',
    search: "    .transform((value) => value || '@'),\n",
    replacement: '    .transform((value) => value),\n',
    test: 'keeps provider bounds, defaults, root normalization, and strict request fields',
  },
  {
    id: 'schema-add-strict',
    search: 'export const dnsRecordAddRequestSchema = z.strictObject({\n',
    replacement: 'export const dnsRecordAddRequestSchema = z.object({\n',
    test: 'keeps provider bounds, defaults, root normalization, and strict request fields',
  },
  {
    id: 'schema-ttl-minimum',
    search: '  ttl: z.number().int().min(60).max(86_400).default(900),\n',
    replacement: '  ttl: z.number().int().min(1).max(86_400).default(900),\n',
    test: 'keeps provider bounds, defaults, root normalization, and strict request fields',
  },
  {
    id: 'schema-batch-minimum',
    search: '  recordIds: z.array(providerRecordIdSchema).min(2).max(20),\n',
    replacement: '  recordIds: z.array(providerRecordIdSchema).min(1).max(20),\n',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'requires a bound preview token and at least two ids for batch deletion',
  },
  {
    id: 'schema-business-key-required',
    search: '  idempotencyKey: z.uuid(),\n',
    replacement: '  idempotencyKey: z.uuid().optional(),\n',
    test: 'requires a UUID business key independently on every single-record write schema',
  },
  {
    id: 'schema-business-key-uuid',
    search: '  idempotencyKey: z.uuid(),\n',
    replacement: '  idempotencyKey: z.string(),\n',
    test: 'requires a UUID business key independently on every single-record write schema',
  },
]) {
  add({ file: schemaFile, group: 'request-contract-decision', testFile: contractTest, ...mutation })
}

for (const [access, replacement, test] of [
  [
    'create',
    "access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },",
    'keeps append-only change history owner-scoped and rejects every generic mutation',
  ],
  [
    'delete',
    "access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },",
    'keeps append-only change history owner-scoped and rejects every generic mutation',
  ],
  [
    'update',
    "access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },",
    'keeps append-only change history owner-scoped and rejects every generic mutation',
  ],
  [
    'read',
    "access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },",
    'keeps append-only change history owner-scoped and rejects every generic mutation',
  ],
]) {
  const values = {
    create:
      "access: { create: () => true, delete: deny, read: ownOrSystem('customer'), update: deny },",
    delete:
      "access: { create: deny, delete: () => true, read: ownOrSystem('customer'), update: deny },",
    update:
      "access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: () => true },",
    read: 'access: { create: deny, delete: deny, read: () => true, update: deny },',
  }
  add({
    file: collectionFile,
    group: 'collection-access-callpoint',
    id: `collection-${access}-access`,
    search: `  ${replacement}\n`,
    replacement: `  ${values[access]}\n`,
    test,
  })
}

for (const mutation of [
  {
    id: 'append-only-update-hook',
    search: "        if (operation === 'update') {\n",
    replacement: '        if (false) {\n',
  },
  {
    id: 'append-only-delete-hook',
    search:
      "        throw new AppError('DNS_RECORD_CHANGE_APPEND_ONLY', 'DNS 解析变更记录只允许追加', 409)\n",
    replacement: '        return undefined\n',
    occurrence: 2,
    expectedOccurrences: 2,
  },
]) {
  add({
    file: collectionFile,
    group: 'append-only-decision',
    testFile: contractTest,
    test: 'keeps DNS change records append-only even for system override calls',
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'nameserver-secondary-confirmation',
    search: '    if (input.confirmed !== true) {\n',
    replacement: '    if (false) {\n',
    test: 'rejects NS changes without secondary confirmation even with a valid grant',
  },
  {
    id: 'nameserver-step-up-and-cooldown-callpoint',
    search: '    await authorizeStepUpGrant(req, {\n',
    replacement: '    await Promise.resolve({\n',
    test: 'rejects NS changes during the identity-risk cooldown even with a valid grant',
  },
]) {
  add({ file: nameserverFile, group: 'nameserver-risk-decision', ...mutation })
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
    const source = readFileSync(`${webRoot}/${mutation.file}`, 'utf8')
    const found = occurrences(source, mutation.search)
    const expected = mutation.expectedOccurrences ?? 1
    if (found !== expected) {
      invalid += 1
      process.stderr.write(
        `MUTATION SETUP FAILED ${mutation.id}: expected ${expected} occurrences, found ${found}\n`,
      )
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  if (invalid) process.exitCode = 1
  process.exit()
}

const selected = selectors.length
  ? mutations.filter((mutation) => selectors.includes(mutation.id))
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-D-1 decision mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
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
  `\nD9D1_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
