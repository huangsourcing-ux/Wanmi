import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const testFile = 'tests/integration/d9c1-domain-center.integration.test.ts'
const managementFile = 'src/services/domains/domain-management.ts'
const enableTest =
  'enables the domain lock with the current session and audit but no step-up or bound channel'
const stolenLeaseTest =
  'fails closed when the domain-management lease is stolen before the local lock fact CAS'

const mutations = [
  {
    id: 'lock-local-status-direction',
    predicate: 'confirmed local lock status is derived from the requested direction',
    search: "    const status = locked ? 'locked' : 'unlocked'\n",
    replacement: "    const status = locked ? 'unlocked' : 'locked'\n",
    test: enableTest,
  },
  {
    id: 'lock-local-updated-at-coupling',
    predicate: 'confirmed local lock status and domain_lock_updated_at advance together',
    search: '          domain_lock_updated_at = NOW(),\n',
    replacement: '          domain_lock_updated_at = NULL,\n',
    test: enableTest,
  },
  {
    id: 'lock-local-version-coupling',
    predicate: 'confirmed local lock status and sync_version advance together',
    search: '          sync_version = sync_version + 1,\n',
    replacement: '          sync_version = sync_version,\n',
    expectedOccurrences: 2,
    occurrence: 1,
    test: enableTest,
  },
  {
    expectedOccurrences: 4,
    id: 'lock-local-asset-id',
    occurrence: 3,
    predicate: 'confirmed local lock state is scoped to the requested asset id',
    search: '      WHERE id = ${asset.id}\n',
    replacement: '      WHERE id = -1\n',
    test: enableTest,
  },
  {
    id: 'lock-local-owned-lease',
    predicate: 'confirmed local lock state requires the caller-owned management lease',
    search: '        AND domain_management_lease_key = ${leaseKey}\n',
    replacement: '        AND TRUE\n',
    expectedOccurrences: 2,
    occurrence: 2,
    test: stolenLeaseTest,
  },
  {
    changes: [
      {
        expectedOccurrences: 4,
        occurrence: 3,
        search: '      WHERE id = ${asset.id}\n',
        replacement: '      WHERE id = -1\n',
      },
      {
        search: '    if (updated.rows?.[0]?.id === undefined) {\n',
        replacement: '    if (false) {\n',
        expectedOccurrences: 2,
        occurrence: 1,
      },
    ],
    id: 'lock-local-returning-authorization',
    predicate: 'zero returned rows reject a local lock fact write',
    test: enableTest,
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

function changesFor(mutation) {
  return mutation.changes ?? [mutation]
}

function mutateSource(source, mutation) {
  let result = source
  for (const change of changesFor(mutation)) {
    const found = occurrences(result, change.search)
    const expected = change.expectedOccurrences ?? mutation.expectedOccurrences ?? 1
    if (found !== expected) throw new Error(`expected ${expected} occurrences, found ${found}`)
    result = replaceOccurrence(
      result,
      change.search,
      change.replacement,
      change.occurrence ?? mutation.occurrence ?? 1,
    )
  }
  return result
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
  const source = readFileSync(`${webRoot}/${managementFile}`, 'utf8')
  for (const mutation of mutations) {
    try {
      mutateSource(source, mutation)
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
  ? mutations.filter((mutation) => selectors.includes(mutation.id))
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-C-1 SQL mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${managementFile}`
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
process.stdout.write(`\nD9C1_SQL_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
