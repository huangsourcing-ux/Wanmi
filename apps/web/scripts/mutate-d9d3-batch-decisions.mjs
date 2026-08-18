import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const dnsTest = 'tests/integration/d9d1-dns-records.integration.test.ts'
const nsTest = 'tests/integration/d9d3-nameserver-batch.integration.test.ts'
const providerTest = 'tests/unit/westdigital-write.test.ts'
const httpTest = 'tests/unit/westdigital-offline-http.test.ts'

const files = {
  dns: 'src/services/domains/dns-records.ts',
  ns: 'src/services/domains/nameserver-changes.ts',
  operations: 'src/services/providers/westdigital-operations.ts',
  preview: 'src/services/domains/change-preview.ts',
  provider: 'src/providers/westdigital-write.ts',
  http: 'src/providers/westdigital-offline-http.ts',
  collection: 'src/collections/domain-management.ts',
}

const mutations = []
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })
const add = (group, id, file, edits, testFile, test) =>
  mutations.push({ edits, file, group, id, test, testFile })

add(
  'provider-contract',
  'submit-documented-act',
  files.provider,
  [
    edit(
      "body: { act: 'dodelreall', data: values.join('|') },",
      "body: { act: 'mutated', data: values.join('|') },",
    ),
  ],
  providerTest,
  'maps documented V2 offline DNS deletion submission',
)
add(
  'provider-contract',
  'submit-line-label',
  files.provider,
  [edit('      westDigitalDnsLineLabel(record.lineCode),\n', '      record.lineCode,\n')],
  providerTest,
  'maps documented V2 offline DNS deletion submission',
)
add(
  'provider-contract',
  'acceptance-not-success',
  files.provider,
  [
    edit("        state: 'accepted' as const,", "        state: 'succeeded' as const,", {
      occurrence: 3,
      expectedOccurrences: 3,
    }),
  ],
  providerTest,
  'without treating acceptance as success',
)
add(
  'provider-contract',
  'task-key-required',
  files.provider,
  [
    edit(
      'providerTaskKey: offlineTaskKeyDataSchema.parse(envelope.data).task_sku,',
      "providerTaskKey: 'MISSING',",
    ),
  ],
  providerTest,
  'without task_sku status-unknown',
)
add(
  'provider-identity',
  'task-act-match',
  files.provider,
  [edit("tasks[0]?.task_act !== 'dodelreall' ||", 'false ||')],
  providerTest,
  'rejects mismatched offline task identity',
)
add(
  'provider-identity',
  'task-type-match',
  files.provider,
  [edit("tasks[0]?.task_type !== 'dns_record'", 'false')],
  providerTest,
  'rejects mismatched offline task identity',
)
add(
  'provider-identity',
  'record-domain-match',
  files.provider,
  [
    edit(
      "item.record_ident === domainAscii && item.act === 'dodelreall'",
      "item.act === 'dodelreall'",
    ),
  ],
  providerTest,
  'rejects mismatched offline task identity',
)
add(
  'provider-state',
  'record-success-state-3',
  files.provider,
  [edit('record.data.record_state === 3', 'false')],
  providerTest,
  'maps documented offline task_state',
)
add(
  'provider-state',
  'task-failure-state-3',
  files.provider,
  [edit('task.data.task_state === 3 ||', 'false ||')],
  providerTest,
  'maps documented offline task_state',
)
add(
  'provider-state',
  'record-failure-state-4',
  files.provider,
  [edit('record.data.record_state === 4 ||', 'false ||')],
  providerTest,
  'maps documented offline task_state',
)
add(
  'provider-state',
  'record-exception-state-5',
  files.provider,
  [edit('record.data.record_state === 5', 'false')],
  providerTest,
  'maps documented offline task_state',
)
add(
  'transport-auth',
  'auth-field-injection',
  files.http,
  [
    edit(
      "  if ('username' in request.body || 'time' in request.body || 'token' in request.body) {",
      '  if (false) {',
    ),
  ],
  httpTest,
  'rejects caller-supplied authentication fields',
)
add(
  'transport-contract',
  'submit-method-post',
  files.http,
  [
    edit(
      "const method = request.path === '/v2/offline-task/add-dns-record-task' ? 'POST' : 'GET'",
      "const method = 'GET' as const",
    ),
  ],
  httpTest,
  'POSTs task creation',
)
add(
  'transport-contract',
  'fixed-offline-origin',
  files.http,
  [edit("const HOSTNAME = 'newapi.west.cn'", "const HOSTNAME = 'example.invalid'")],
  httpTest,
  'POSTs task creation',
)
add(
  'd6-routing',
  'offline-submit-dispatch',
  files.operations,
  [
    edit(
      '    return dnsProvider.submitOfflineDnsRecordDelete(input)',
      '    return dnsProvider.deleteDnsRecord(input)',
    ),
  ],
  dnsTest,
  'keeps accepted offline deletions pending until queried',
)
add(
  'd6-state',
  'no-query-on-acceptance',
  files.operations,
  [edit("    if (input.operation === 'dns_record_batch_delete') {", '    if (false) {')],
  dnsTest,
  'keeps accepted offline deletions pending until queried',
)
add(
  'd6-routing',
  'offline-query-dispatch',
  files.operations,
  [
    edit("  if (input.operation === 'dns_record_batch_delete') {", '  if (false) {', {
      occurrence: 1,
      expectedOccurrences: 3,
    }),
  ],
  dnsTest,
  'six-state partial',
)
add(
  'd6-state',
  'offline-confirmed-terminal',
  files.operations,
  [
    edit(
      "  if (input.operation === 'dns_record_batch_delete') {\n    return 'state' in result.data && result.data.state === 'succeeded'\n  }",
      "  if (input.operation === 'dns_record_batch_delete') return false",
    ),
  ],
  dnsTest,
  'replays completed batch items',
)
add(
  'd6-state',
  'offline-explicit-failure-terminal',
  files.operations,
  [edit("    input.operation === 'dns_record_batch_delete' &&", '    false &&')],
  dnsTest,
  'six-state partial',
)
add(
  'd6-safety',
  'offline-upstream-ownership-callpoint',
  files.operations,
  [
    edit(
      "    if (input.operation !== 'realname' && input.operation !== 'register') {",
      "    if (input.operation !== 'realname' && input.operation !== 'register' && input.operation !== 'dns_record_batch_delete') {",
    ),
  ],
  dnsTest,
  'upstream ownership blocking',
)
add(
  'preview-signature',
  'hmac-equality',
  files.preview,
  [edit('    !safeEqualHex(hmac(encoded, getEnv().SESSION_PEPPER), signature)', '    false')],
  dnsTest,
  'binds batch preview signatures',
)

for (const [id, condition, test] of [
  ['dns-preview-version', '    payload.version !== 1 ||\n', 'binds batch preview signatures'],
  [
    'dns-preview-asset',
    '    payload.assetId !== String(input.assetId) ||\n',
    'binds batch preview signatures',
  ],
  [
    'dns-preview-customer',
    '    payload.customerId !== String(input.customerId) ||\n',
    'binds batch preview signatures',
  ],
  [
    'dns-preview-domain',
    '    payload.domainAscii !== input.domainAscii ||\n',
    'binds batch preview signatures',
  ],
  [
    'dns-preview-expiry',
    '    new Date(payload.expiresAt).getTime() <= Date.now() ||\n',
    'binds batch preview signatures',
  ],
]) {
  add('dns-preview-binding', id, files.dns, [edit(condition, '')], dnsTest, test)
}
add(
  'dns-preview-binding',
  'dns-preview-record-ids',
  files.dns,
  [
    edit(
      '    JSON.stringify(payload.recordIds) !== JSON.stringify(input.recordIds)\n',
      '    false\n',
    ),
  ],
  dnsTest,
  'execution target set adds one record',
)
add(
  'dns-preview-binding',
  'dns-preview-record-digest-current',
  files.dns,
  [edit('    if (recordsDigest(records) !== preview.recordDigest) {', '    if (false) {')],
  dnsTest,
  'one selected record is modified',
)
add(
  'dns-idempotency',
  'dns-replay-before-record',
  files.dns,
  [
    edit(
      '          ? replay.beforeRecord!',
      '          ? requireProviderRecord(asset, recordId, options.provider, `${options.traceId}-mutated`)',
    ),
  ],
  dnsTest,
  'replays completed batch items',
)
add(
  'dns-result',
  'dns-all-items-must-succeed',
  files.dns,
  [edit("    if (results.every((result) => result.status === 'succeeded')) {", '    if (true) {')],
  dnsTest,
  'keeps accepted offline deletions pending until queried',
)

const a3Call = "  await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n"
for (const [id, occurrence, test] of [
  ['dns-a3-preview', 5, 'applies the A3 domain-write capability gate'],
  ['dns-a3-execute', 6, 'applies the A3 domain-write capability gate'],
  ['dns-a3-query', 7, 'applies the A3 domain-write capability gate'],
]) {
  add(
    'a3-callpoint',
    id,
    files.dns,
    [edit(a3Call, '  await Promise.resolve()\n', { occurrence, expectedOccurrences: 7 })],
    dnsTest,
    test,
  )
}
add(
  'dns-risk',
  'dns-batch-step-fields',
  files.dns,
  [
    edit('  if (!input.deviceId || !input.stepUpToken) {', '  if (false) {', {
      occurrence: 2,
      expectedOccurrences: 2,
    }),
  ],
  dnsTest,
  'requires step-up and a bound preview',
)
add(
  'dns-risk',
  'dns-batch-step-authorizer',
  files.dns,
  [
    edit('  await authorizeStepUpGrant(req, {', '  await Promise.resolve({', {
      occurrence: 2,
      expectedOccurrences: 2,
    }),
  ],
  dnsTest,
  'requires step-up and a bound preview',
)

add(
  'ns-input',
  'ns-unique-assets',
  files.ns,
  [edit('  if (unique.length !== assetIds.length) {', '  if (false) {')],
  nsTest,
  'rejects duplicate assets',
)
add(
  'ns-input',
  'ns-unique-nameservers',
  files.ns,
  [edit('  if (new Set(normalized).size !== normalized.length) {', '  if (false) {')],
  nsTest,
  'rejects duplicate assets',
)
for (const [id, condition, test] of [
  [
    'ns-preview-version',
    '    parsed.version !== 1 ||\n',
    'binds every NS preview token field independently',
  ],
  [
    'ns-preview-kind',
    "    parsed.kind !== 'nameserver_batch_change' ||\n",
    'binds every NS preview token field independently',
  ],
  [
    'ns-preview-customer',
    '    parsed.customerId !== String(input.customerId) ||\n',
    'binds every NS preview token field independently',
  ],
  [
    'ns-preview-batch',
    '    parsed.batchKey !== input.batchKey ||\n',
    'binds every NS preview token field independently',
  ],
  [
    'ns-preview-expiry',
    '    new Date(parsed.expiresAt).getTime() <= Date.now() ||\n',
    'binds every NS preview token field independently',
  ],
  [
    'ns-preview-assets',
    '    JSON.stringify(parsed.assetIds) !== JSON.stringify(input.assetIds.map(String)) ||\n',
    'binds every NS preview token field independently',
  ],
]) {
  add('ns-preview-binding', id, files.ns, [edit(condition, '')], nsTest, test)
}
add(
  'ns-preview-binding',
  'ns-preview-nameservers',
  files.ns,
  [
    edit(
      '    JSON.stringify(parsed.nameservers) !== JSON.stringify(input.nameservers)\n',
      '    false\n',
    ),
  ],
  nsTest,
  'binds every NS preview token field independently',
)
add(
  'ns-preview-binding',
  'ns-current-asset-digest',
  files.ns,
  [
    edit(
      '  if (batchAssetDigest(assets, nameservers) !== preview.assetDigest) {',
      '  if (false) {',
    ),
  ],
  nsTest,
  'one asset versioned fact is modified',
)
for (const [id, search, test] of [
  ['ns-preview-required', '  if (!input.previewToken) {', 'without a dry-run preview'],
  [
    'ns-confirmation-required',
    '  if (input.confirmed !== true) {',
    'without secondary confirmation',
  ],
  ['ns-step-fields-required', '  if (!input.deviceId || !input.stepUpToken) {', 'without step-up'],
]) {
  add(
    'ns-risk',
    id,
    files.ns,
    [
      edit(search, '  if (false) {', {
        occurrence: id === 'ns-confirmation-required' ? 2 : 1,
        expectedOccurrences: id === 'ns-confirmation-required' ? 2 : 1,
      }),
    ],
    nsTest,
    test,
  )
}
add(
  'ns-idempotency',
  'ns-item-key-excludes-batch-trace',
  files.ns,
  [
    edit(
      '  const key = changeKey(input.asset.id, input.nameservers)',
      '  const key = changeKey(`${input.asset.id}:${input.traceId}`, input.nameservers)',
    ),
  ],
  nsTest,
  'concurrent different batches sharing items',
)
add(
  'ns-idempotency',
  'ns-job-row-id-predicate',
  files.ns,
  [
    edit(
      "      WHERE id = ${change.id}\n        AND status = 'pending'\n        AND job_queued_at IS NULL\n",
      "      WHERE status = 'pending'\n        AND job_queued_at IS NULL\n",
    ),
  ],
  nsTest,
  'unrelated pending item queued',
)
add(
  'ns-idempotency',
  'ns-job-pending-status-predicate',
  files.ns,
  [
    edit(
      "        AND status = 'pending'\n        AND job_queued_at IS NULL\n",
      '        AND job_queued_at IS NULL\n',
    ),
  ],
  nsTest,
  'terminal failed item',
)
add(
  'ns-idempotency',
  'ns-job-not-queued-predicate',
  files.ns,
  [edit('        AND job_queued_at IS NULL\n', '')],
  nsTest,
  'sequential batch retry',
)
add(
  'ns-idempotency',
  'ns-job-queued-returning',
  files.ns,
  [
    edit(
      '    if (claimed.rows?.[0]?.id === undefined) return { idempotentReplay: true }',
      '    if (false) return { idempotentReplay: true }',
    ),
  ],
  nsTest,
  'sequential batch retry',
)
add(
  'ns-failure-visibility',
  'ns-admission-failure-persisted',
  files.ns,
  [
    edit(
      '        const failed = await completeFailure(req, change, asset.id, {',
      '        const failed = change\n        await Promise.resolve({',
    ),
  ],
  nsTest,
  'persists an admission failure reason',
)
add(
  'd6-safety',
  'ns-upstream-ownership-terminal',
  files.ns,
  [
    edit(
      "'DOMAIN_UPSTREAM_ASSET_NOT_OWNED'",
      "'DOMAIN_UPSTREAM_ASSET_NOT_OWNED_MUTATED'",
    ),
  ],
  nsTest,
  'keeps every NS batch item behind D6 ownership blocking',
)
add(
  'ns-result',
  'ns-all-items-must-succeed',
  files.ns,
  [edit("  if (items.every((item) => item.status === 'succeeded')) {", '  if (true) {')],
  nsTest,
  'exposes pending_query',
)
for (const [id, occurrence] of [
  ['ns-a3-preview', 2],
  ['ns-a3-execute', 3],
  ['ns-a3-query', 4],
]) {
  add(
    'a3-callpoint',
    id,
    files.ns,
    [edit(a3Call, '  await Promise.resolve()\n', { occurrence, expectedOccurrences: 4 })],
    nsTest,
    'applies A3 capability',
  )
}
add(
  'ns-append-only',
  'ns-batch-event-update-hook',
  files.collection,
  [
    edit(
      "        if (operation === 'update') throw new AppError(code, message, 409)",
      '        if (false) throw new AppError(code, message, 409)',
    ),
  ],
  nsTest,
  'exposes pending_query',
)
add(
  'ns-append-only',
  'ns-batch-event-delete-hook',
  files.collection,
  [
    edit('        throw new AppError(code, message, 409)', '        return undefined', {
      occurrence: 1,
      expectedOccurrences: 1,
    }),
  ],
  nsTest,
  'exposes pending_query',
)

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
      `${mutation.group}\t${mutation.id}\t${mutation.testFile}\t${mutation.test}\n`,
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
  process.stderr.write(`No D9-D-3 mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  let result
  try {
    writeFileSync(path, applyMutation(original, mutation), 'utf8')
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
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } catch (error) {
    process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    failed = true
    continue
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.testFile} :: ${mutation.test}\n`)
  process.stdout.write(`RAW_FAILURE ${failure}\n`)
  if (result?.status !== 0 && output.includes('AssertionError:')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`RAW_OUTPUT ${output.split('\n').slice(-25).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(
  `\nD9D3_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
