import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const serviceFile = 'src/services/wallet/top-ups.ts'
const testFile = 'tests/integration/d9b2-wallet-top-ups.integration.test.ts'

const mutations = [
  {
    id: 'confirmation-order-number',
    predicate: 'provider confirmation WHERE platform top-up order number matches active query',
    search: '      WHERE top_up_order_number = ${paid.merchantOrderNumber}\n',
    replacement: '      WHERE TRUE\n',
    test: 'rejects stale order-number and amount snapshots at the confirmation CAS',
  },
  {
    id: 'confirmation-expected-state',
    predicate: "provider confirmation AND status = 'payment_pending'",
    search:
      "      WHERE top_up_order_number = ${paid.merchantOrderNumber}\n        AND status = 'payment_pending'\n",
    replacement:
      '      WHERE top_up_order_number = ${paid.merchantOrderNumber}\n        AND TRUE\n',
    test: 'makes repeated confirmation of one top-up add exactly one ledger credit',
  },
  {
    id: 'confirmation-provider-amount',
    predicate: 'provider confirmation AND stored amount equals active-query amount',
    search: '        AND amount_fen = ${BigInt(paid.amountMinor).toString()}\n',
    replacement: '        AND TRUE\n',
    test: 'rejects stale order-number and amount snapshots at the confirmation CAS',
  },
  {
    id: 'credited-commit-order-id',
    predicate: 'credited commit WHERE id = claimed top-up',
    search:
      "      SET status = 'credited', credited_at = NOW(), updated_at = NOW()\n      WHERE id = ${topUp.id}\n        AND status = 'provider_confirmed'\n",
    replacement:
      "      SET status = 'credited', credited_at = NOW(), updated_at = NOW()\n      WHERE TRUE\n        AND status = 'provider_confirmed'\n",
    test: 'scopes the credited-state commit to the claimed top-up',
  },
  {
    id: 'credited-commit-expected-state',
    predicate: "credited commit AND status = 'provider_confirmed'",
    search:
      "      WHERE id = ${topUp.id}\n        AND status = 'provider_confirmed'\n      RETURNING id\n",
    replacement: '      WHERE id = ${topUp.id}\n        AND TRUE\n      RETURNING id\n',
    test: 'rolls back credit if the claimed state changes before the credited-state CAS',
  },
  {
    id: 'payment-create-order-id',
    predicate: 'payment creation WHERE id = requested top-up',
    search: "      WHERE id = ${topUp.id}\n        AND status = 'created'\n      RETURNING id\n",
    replacement: "      WHERE TRUE\n        AND status = 'created'\n      RETURNING id\n",
    test: 'scopes payment creation and known-failure closing to exactly one top-up',
  },
  {
    id: 'payment-create-expected-state',
    predicate: "payment creation AND status = 'created'",
    search: "      WHERE id = ${topUp.id}\n        AND status = 'created'\n      RETURNING id\n",
    replacement: '      WHERE id = ${topUp.id}\n        AND TRUE\n      RETURNING id\n',
    test: 'claims payment creation once from the created state',
  },
  {
    id: 'payment-close-order-id',
    predicate: 'known-failure close WHERE id = claimed top-up',
    search:
      "          WHERE id = ${topUp.id}\n            AND status = 'payment_pending'\n          RETURNING id\n",
    replacement:
      "          WHERE TRUE\n            AND status = 'payment_pending'\n          RETURNING id\n",
    test: 'scopes payment creation and known-failure closing to exactly one top-up',
  },
  {
    id: 'payment-close-expected-state',
    predicate: "known-failure close AND status = 'payment_pending'",
    search:
      "          WHERE id = ${topUp.id}\n            AND status = 'payment_pending'\n          RETURNING id\n",
    replacement: '          WHERE id = ${topUp.id}\n            AND TRUE\n          RETURNING id\n',
    test: 'does not close a top-up whose state changed during a failed provider create',
  },
  {
    id: 'refund-claim-order-id',
    predicate: 'original-refund claim WHERE id = requested top-up',
    search:
      "      WHERE id = ${topUp.id}\n        AND status IN ('payment_pending', 'provider_confirmed', 'credited')\n",
    replacement:
      "      WHERE TRUE\n        AND status IN ('payment_pending', 'provider_confirmed', 'credited')\n",
    test: 'scopes refund claim and finalization to exactly one top-up',
  },
  {
    id: 'refund-claim-eligible-state',
    predicate: 'original-refund claim AND status is payment_pending/provider_confirmed/credited',
    search:
      "      WHERE id = ${topUp.id}\n        AND status IN ('payment_pending', 'provider_confirmed', 'credited')\n",
    replacement: '      WHERE id = ${topUp.id}\n        AND TRUE\n',
    test: 'rejects unauthorized, malformed, missing, and invalid-state refund markers',
  },
  {
    id: 'refund-final-order-id',
    predicate: 'refunded commit WHERE id = claimed top-up',
    search:
      "      WHERE id = ${topUp.id}\n        AND status = 'refund_pending'\n      RETURNING id\n",
    replacement: "      WHERE TRUE\n        AND status = 'refund_pending'\n      RETURNING id\n",
    test: 'scopes refund claim and finalization to exactly one top-up',
  },
  {
    id: 'refund-final-expected-state',
    predicate: "refunded commit AND status = 'refund_pending'",
    search:
      "      WHERE id = ${topUp.id}\n        AND status = 'refund_pending'\n      RETURNING id\n",
    replacement: '      WHERE id = ${topUp.id}\n        AND TRUE\n      RETURNING id\n',
    test: 'rolls back a refund if the claimed state changes before finalization',
  },
]

function occurrences(source, search) {
  return source.split(search).length - 1
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
  process.stderr.write(`No D9-B-2 SQL mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${serviceFile}`
  const original = readFileSync(path, 'utf8')
  const found = occurrences(original, mutation.search)
  if (found !== 1) {
    process.stderr.write(
      `MUTATION SETUP FAILED ${mutation.id}: expected 1 occurrence, found ${found}\n`,
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
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const behaviorFailure = output.includes('AssertionError:') || output.includes(' FAIL ')
  const failureLine =
    output.split('\n').find((line) => line.includes('AssertionError:')) ??
    output.split('\n').find((line) => line.includes(' FAIL ')) ??
    ''
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

process.stdout.write(`\nD9B2_SQL_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
