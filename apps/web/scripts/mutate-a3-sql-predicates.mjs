import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const testFile = 'tests/integration/d9a-account-state.integration.test.ts'

const mutations = [
  {
    file: 'src/services/auth/account-state.ts',
    predicate: 'WHERE id = ${input.customerId}',
    replacement: '      WHERE status = ${input.expectedStatus}\n',
    search: '      WHERE id = ${input.customerId}\n        AND status = ${input.expectedStatus}\n',
    test: 'keeps the account-state CAS target id predicate behaviorally necessary',
  },
  {
    file: 'src/services/auth/account-state.ts',
    predicate: '        AND status = ${input.expectedStatus}\n',
    replacement: '',
    search: '        AND status = ${input.expectedStatus}\n',
    test: 'keeps the account-state CAS expected status predicate behaviorally necessary',
  },
  {
    file: 'src/services/auth/account-state.ts',
    predicate: '        AND capability_restrictions = ${expectedRestrictionsJson}::jsonb\n',
    replacement: '',
    search: '        AND capability_restrictions = ${expectedRestrictionsJson}::jsonb\n',
    test: 'keeps the account-state CAS expected restrictions predicate behaviorally necessary',
  },
  {
    file: 'src/services/auth/customer-sessions.ts',
    predicate: 'WHERE customer_id = ${customerId}',
    replacement: '      WHERE revoked_at IS NULL\n',
    search: '      WHERE customer_id = ${customerId}\n        AND revoked_at IS NULL\n',
    test: 'keeps the revoke-all customer id predicate behaviorally necessary',
  },
  {
    file: 'src/services/auth/customer-sessions.ts',
    predicate: '        AND revoked_at IS NULL\n',
    replacement: '',
    search: '        AND revoked_at IS NULL\n',
    test: 'keeps the revoke-all active-session predicate behaviorally necessary',
  },
]

let failed = false

for (const mutation of mutations) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  const occurrences = original.split(mutation.search).length - 1
  if (occurrences !== 1) {
    process.stderr.write(
      `MUTATION SETUP FAILED ${mutation.file} ${JSON.stringify(mutation.predicate.trim())}: expected one occurrence, found ${occurrences}\n`,
    )
    failed = true
    continue
  }

  let result
  try {
    writeFileSync(path, original.replace(mutation.search, mutation.replacement), 'utf8')
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

  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim()
  process.stdout.write(
    `\nMUTATION ${mutation.file} DELETE ${JSON.stringify(mutation.predicate.trim())}\n${output}\n`,
  )
  if (result?.status === 0) {
    process.stderr.write(`SURVIVED: ${mutation.test}\n`)
    failed = true
  } else {
    process.stdout.write(`KILLED: ${mutation.test}\n`)
  }
}

if (failed) process.exitCode = 1
