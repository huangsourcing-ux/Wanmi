import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const testFile = 'tests/integration/d9a-consent-personal-information.integration.test.ts'

const mutations = [
  {
    id: 'consent-claim-customer-id',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: 'UPDATE customers WHERE id = input.customerId',
    search:
      '    WHERE id = ${input.customerId}\n      AND consent_state_version = ${input.expectedVersion}\n',
    replacement: '    WHERE consent_state_version = ${input.expectedVersion}\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'CAS consent writes constrain customer id, expected version, allowed status, and returned claim',
  },
  {
    id: 'consent-claim-expected-version',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: 'UPDATE customers AND consent_state_version = input.expectedVersion',
    search: '      AND consent_state_version = ${input.expectedVersion}\n',
    replacement: '',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'CAS consent writes constrain customer id, expected version, allowed status, and returned claim',
  },
  {
    id: 'consent-claim-allowed-status',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: "UPDATE customers AND status IN ('active', 'restricted')",
    search: "      AND status IN ('active', 'restricted')\n",
    replacement: '',
    occurrence: 1,
    expectedOccurrences: 3,
    test: 'CAS consent writes constrain customer id, expected version, allowed status, and returned claim',
  },
  {
    id: 'consent-noop-customer-id',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: 'SELECT customers WHERE id = input.customerId',
    search:
      '    WHERE id = ${input.customerId}\n      AND consent_state_version = ${input.expectedVersion}\n',
    replacement: '    WHERE consent_state_version = ${input.expectedVersion}\n',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'validates no-op consent reads against the same customer id, version, and allowed status',
  },
  {
    id: 'consent-noop-expected-version',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: 'SELECT customers AND consent_state_version = input.expectedVersion',
    search: '      AND consent_state_version = ${input.expectedVersion}\n',
    replacement: '',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'validates no-op consent reads against the same customer id, version, and allowed status',
  },
  {
    id: 'consent-noop-allowed-status',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: "SELECT customers AND status IN ('active', 'restricted')",
    search: "      AND status IN ('active', 'restricted')\n",
    replacement: '',
    occurrence: 2,
    expectedOccurrences: 3,
    test: 'validates no-op consent reads against the same customer id, version, and allowed status',
  },
  {
    id: 'legacy-completion-customer-id',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: 'legacy completion WHERE id = customer.id',
    search: '      WHERE id = ${customer.id}\n',
    replacement: '      WHERE TRUE\n',
    test: 'completion CAS updates only the target customer id',
  },
  {
    id: 'legacy-completion-account-type',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: "legacy completion AND account_type = 'legacy_unknown'",
    search: "        AND account_type = 'legacy_unknown'\n",
    replacement: '',
    test: 'completion CAS rejects a stale account type database predicate',
  },
  {
    id: 'legacy-completion-registration-source',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: "legacy completion AND registration_source = 'legacy_unknown'",
    search: "        AND registration_source = 'legacy_unknown'\n",
    replacement: '',
    test: 'completion CAS rejects a stale registration source database predicate',
  },
  {
    id: 'legacy-completion-not-completed',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: 'legacy completion AND legacy_profile_completed_at IS NULL',
    search: '        AND legacy_profile_completed_at IS NULL\n',
    replacement: '',
    test: 'completion CAS rejects a stale completion timestamp database predicate',
  },
  {
    id: 'legacy-completion-expected-version',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: 'legacy completion AND consent_state_version = expectedVersion',
    search: '        AND consent_state_version = ${expectedVersion}\n',
    replacement: '',
    test: 'completion CAS rejects a stale consent version database predicate',
  },
  {
    id: 'legacy-completion-allowed-status',
    file: 'src/services/privacy/customer-consents.ts',
    predicate: "legacy completion AND status IN ('active', 'restricted')",
    search: "        AND status IN ('active', 'restricted')\n",
    replacement: '',
    test: 'completion CAS rejects a stale allowed status database predicate',
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

let failed = false
let killed = 0
for (const mutation of mutations) {
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
  const behaviorFailure = output.includes('AssertionError:')
  const failureLine = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.id}\nPREDICATE ${mutation.predicate}\n`)
  process.stdout.write(`TEST ${mutation.test}\nRAW_FAILURE ${failureLine}\n`)
  if (result?.status !== 0 && behaviorFailure) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write(`\nSQL_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${mutations.length}\n`)
if (failed) process.exitCode = 1
