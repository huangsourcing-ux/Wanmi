import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const testFile = 'tests/integration/d9d2-domain-management.integration.test.ts'
const managementFile = 'src/services/domains/domain-management.ts'
const assetsFile = 'src/services/domains/domain-assets.ts'

const successTest =
  'updates one documented contact role and transfers only to an owned approved template'
const leaseTest =
  'uses one conditional lease at each password, contact, and transfer write call point'
const expiredLeaseTest =
  'reclaims only an expired management lease and fails closed if lease ownership changes'
const transferTest =
  'keeps every transfer CAS predicate necessary and marks write-after-upstream conflicts pending'
const syncTest = 'keeps synchronization scoped by asset, version, and an inactive management lease'

const mutations = [
  {
    file: managementFile,
    id: 'management-claim-asset-id',
    predicate: 'management lease claim is scoped to the requested domain asset id',
    search: '      WHERE id = ${asset.id}\n',
    replacement: '      WHERE id = -1\n',
    occurrence: 1,
    expectedOccurrences: 3,
    test: successTest,
  },
  {
    file: managementFile,
    id: 'management-claim-sync-version',
    predicate: 'management lease claim requires the observed sync_version',
    search: '        AND sync_version = ${asset.syncVersion ?? 0}\n',
    replacement: '        AND FALSE\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: successTest,
  },
  {
    file: managementFile,
    id: 'management-claim-empty-lease',
    predicate: 'management lease claim accepts an empty lease',
    search: '          domain_management_lease_key IS NULL\n',
    replacement: '          FALSE\n',
    test: successTest,
  },
  {
    file: managementFile,
    id: 'management-claim-mutual-exclusion',
    predicate: 'management lease claim requires the existing lease to be empty or expired',
    search:
      '        AND (\n          domain_management_lease_key IS NULL\n          OR domain_management_lease_expires_at <= NOW()\n        )\n',
    replacement: '        AND TRUE\n',
    test: leaseTest,
  },
  {
    file: managementFile,
    id: 'management-claim-expired-lease',
    predicate: 'management lease claim may reclaim only an expired lease',
    search: '          OR domain_management_lease_expires_at <= NOW()\n',
    replacement: '          OR FALSE\n',
    test: expiredLeaseTest,
  },
  {
    file: managementFile,
    id: 'management-claim-returning-authorization',
    predicate: 'management lease claim authorization is the returned row',
    search: '    if (claimed.rows?.[0]?.id !== undefined) return\n',
    replacement: '    if (true) return\n',
    test: leaseTest,
  },
  {
    file: managementFile,
    id: 'management-release-asset-id',
    predicate: 'management lease release is scoped to the requested domain asset id',
    search: '      WHERE id = ${asset.id}\n',
    replacement: '      WHERE id = -1\n',
    occurrence: 2,
    expectedOccurrences: 3,
    test: successTest,
  },
  {
    file: managementFile,
    id: 'management-release-owned-key',
    predicate: 'management lease release requires the caller-owned lease key',
    search: '        AND domain_management_lease_key = ${leaseKey}\n',
    replacement: '        AND TRUE\n',
    test: expiredLeaseTest,
  },
  {
    file: managementFile,
    id: 'management-release-returning-authorization',
    predicate: 'management lease release is confirmed by a returned row',
    search: '    if (released.rows?.[0]?.id === undefined) {\n',
    replacement: '    if (false) {\n',
    test: expiredLeaseTest,
  },
  {
    file: managementFile,
    id: 'transfer-cas-asset-id',
    predicate: 'template transfer local fact update is scoped to the requested asset id',
    search: '      WHERE id = ${asset.id}\n',
    replacement: '      WHERE id = ${asset.id + 1}\n',
    occurrence: 3,
    expectedOccurrences: 3,
    test: transferTest,
  },
  {
    file: managementFile,
    id: 'transfer-cas-current-template',
    predicate: 'template transfer local fact update requires the observed template',
    search: '        AND realname_template_id = ${currentTemplateId}\n',
    replacement: '        AND TRUE\n',
    test: transferTest,
  },
  {
    file: managementFile,
    id: 'transfer-cas-sync-version',
    predicate: 'template transfer local fact update requires the observed sync_version',
    search: '        AND sync_version = ${asset.syncVersion ?? 0}\n',
    replacement: '        AND TRUE\n',
    occurrence: 2,
    expectedOccurrences: 2,
    test: transferTest,
  },
  {
    file: managementFile,
    id: 'transfer-cas-returning-authorization',
    predicate: 'template transfer local fact update is confirmed by a returned row',
    search: '    if (updated.rows?.[0]?.id === undefined) {\n',
    replacement: '    if (false) {\n',
    test: transferTest,
  },
  {
    file: assetsFile,
    id: 'sync-cas-asset-id',
    predicate: 'sync marker update is scoped to the observed asset id',
    search: '      WHERE id = ${input.asset.id}\n',
    replacement: '      WHERE id = ${input.asset.id + 1}\n',
    test: syncTest,
  },
  {
    file: assetsFile,
    id: 'sync-cas-version',
    predicate: 'sync marker update requires the observed sync_version',
    search: '        AND sync_version = ${input.asset.syncVersion ?? 0}\n',
    replacement: '        AND TRUE\n',
    test: syncTest,
  },
  {
    file: assetsFile,
    id: 'sync-cas-empty-management-lease',
    predicate: 'sync marker update accepts an empty management lease',
    search: '          domain_management_lease_key IS NULL\n',
    replacement: '          FALSE\n',
    test: syncTest,
  },
  {
    file: assetsFile,
    id: 'sync-cas-inactive-management-lease',
    predicate: 'sync marker update requires the management lease to be empty or expired',
    search:
      '        AND (\n          domain_management_lease_key IS NULL\n          OR domain_management_lease_expires_at <= NOW()\n        )\n',
    replacement: '        AND TRUE\n',
    test: syncTest,
  },
  {
    file: assetsFile,
    id: 'sync-cas-expired-management-lease',
    predicate: 'sync marker update accepts an expired management lease',
    search: '          OR domain_management_lease_expires_at <= NOW()\n',
    replacement: '          OR FALSE\n',
    test: syncTest,
  },
  {
    file: assetsFile,
    id: 'sync-cas-returning-authorization',
    predicate: 'sync marker update is confirmed by a returned row',
    search: '    if (updated.rows?.[0]?.id === undefined) {\n',
    replacement: '    if (false) {\n',
    test: syncTest,
  },
  {
    file: assetsFile,
    id: 'sync-last-success-only-on-match',
    predicate: 'last_synced_at advances only for a matched observation',
    search: "            WHEN ${input.outcome} = 'matched' THEN ${input.observedAt}\n",
    replacement: '            WHEN TRUE THEN ${input.observedAt}\n',
    test: 'records not-owned synchronization state without overwriting local asset facts',
  },
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

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.id}\t${mutation.predicate}\t${mutation.test}\n`)
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
  process.stderr.write(`No D9-D-2 SQL mutations matched: ${selectors.join(', ')}\n`)
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
        testFile,
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
  process.stdout.write(`\nMUTATION sql/${mutation.id}\nPREDICATE ${mutation.predicate}\n`)
  process.stdout.write(`TEST ${testFile} :: ${mutation.test}\nRAW_FAILURE ${failure}\n`)
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
process.stdout.write(`\nD9D2_SQL_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
