import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const testFile = 'tests/integration/d9d1-dns-records.integration.test.ts'

const mutations = [
  {
    id: 'claim-target-id',
    predicate: 'claim UPDATE domain_assets WHERE id = asset.id',
    search: '      WHERE id = ${asset.id}\n        AND (\n',
    replacement: '      WHERE id = -1\n        AND (\n',
    occurrence: 1,
    test: 'adds an ordinary subdomain without step-up and records scoped append-only audit history',
  },
  {
    id: 'claim-empty-lease',
    predicate: 'claim lease allows dns_mutation_lease_key IS NULL',
    search: '          dns_mutation_lease_key IS NULL\n',
    replacement: '          FALSE\n',
    test: 'adds an ordinary subdomain without step-up and records scoped append-only audit history',
  },
  {
    id: 'claim-expired-lease',
    predicate: 'claim lease allows dns_mutation_lease_expires_at <= NOW()',
    search: '          OR dns_mutation_lease_expires_at <= NOW()\n',
    replacement: '          OR FALSE\n',
    test: 'reclaims an expired lease and resets an expired high-count rate window',
  },
  {
    id: 'claim-expired-rate-window',
    predicate: "claim rate allows dns_change_window_started_at <= NOW() - INTERVAL '1 minute'",
    search:
      "        AND (\n          dns_change_window_started_at <= NOW() - INTERVAL '1 minute'\n          OR COALESCE(dns_change_count, 0) <= ${limit - changeDelta}\n        )\n",
    replacement:
      '        AND (\n          FALSE\n          OR COALESCE(dns_change_count, 0) <= ${limit - changeDelta}\n        )\n',
    test: 'reclaims an expired lease and resets an expired high-count rate window',
  },
  {
    id: 'claim-current-rate-cap',
    predicate: 'claim rate requires COALESCE(dns_change_count, 0) <= limit - changeDelta',
    search: '          OR COALESCE(dns_change_count, 0) <= ${limit - changeDelta}\n',
    replacement: '          OR TRUE\n',
    expectedOccurrences: 1,
    test: 'enforces the configurable per-domain mutation rate before another provider write',
  },
  {
    id: 'set-window-expired-reset',
    predicate: 'SET window resets when prior window is older than one minute',
    search:
      "          WHEN dns_change_window_started_at IS NULL\n            OR dns_change_window_started_at <= NOW() - INTERVAL '1 minute'\n",
    replacement: '          WHEN dns_change_window_started_at IS NULL\n            OR FALSE\n',
    test: 'reclaims an expired lease and resets an expired high-count rate window',
  },
  {
    id: 'set-count-expired-reset',
    predicate: 'SET count resets when prior window is older than one minute',
    search:
      "          WHEN dns_change_window_started_at <= NOW() - INTERVAL '1 minute'\n          THEN ${changeDelta}\n",
    replacement: '          WHEN FALSE\n          THEN ${changeDelta}\n',
    test: 'reclaims an expired lease and resets an expired high-count rate window',
  },
  {
    id: 'release-target-id',
    predicate: 'release UPDATE domain_assets WHERE id = asset.id',
    search: '      WHERE id = ${asset.id}\n        AND dns_mutation_lease_key = ${leaseKey}\n',
    replacement: '      WHERE id = -1\n        AND dns_mutation_lease_key = ${leaseKey}\n',
    test: 'adds an ordinary subdomain without step-up and records scoped append-only audit history',
  },
  {
    id: 'release-owned-lease-key',
    predicate: 'release requires dns_mutation_lease_key = leaseKey',
    search: '        AND dns_mutation_lease_key = ${leaseKey}\n',
    replacement: '        AND TRUE\n',
    test: 'fails closed without clearing a lease that changed before release',
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

const selected = selectors.length
  ? mutations.filter((mutation) => selectors.includes(mutation.id))
  : mutations
if (!selected.length) {
  process.stderr.write(`No SQL mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/src/services/domains/dns-records.ts`
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
process.stdout.write(`\nSQL_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
