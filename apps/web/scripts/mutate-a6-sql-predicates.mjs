import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const closureFile = 'src/services/auth/account-closure.ts'
const identityFile = 'src/services/auth/customer-identities.ts'
const stepUpFile = 'src/services/auth/step-up.ts'
const testFile = 'tests/integration/d9a-account-closure.integration.test.ts'

const scopeTest = 'keeps every precondition query scoped to the target customer'
const terminalTest =
  'ignores terminal orders and renewals, settled refunds and reconciliations, completed invoices, resolved reviews, and nonpositive balances'
const requestCasTest =
  'keeps every request-claim id, allowed-status, no-active-request, and no-execution-claim predicate necessary'
const revokeCasTest =
  'keeps every revocation id, request-key, no-execution-claim, allowed-status, and returned-row predicate necessary'
const executeCasTest =
  'keeps every execution-claim id, request-key, unclaimed, allowed-status, and returned-row predicate necessary'
const releaseClaimTest =
  'refuses final execution during the persisted closure cooldown and releases its claim'
const finalExecutionTest =
  'allows exactly one final execution, closes through A3, and enforces persisted rebind time'
const requestedLookupTest =
  'requires the immutable requested event for revocation and execution lookups'
const rebindTest =
  'keeps every released-identity provider, instance, hash, precedence, timestamp, and cooldown decision necessary'
const deletionGrantSqlTest = 'keeps every one-time deletion grant SQL predicate necessary'

const mutations = []
const add = (id, search, replacement, test, file = closureFile) =>
  mutations.push({ file, id, replacement, search, test })

add(
  'domains-customer-id',
  '      FROM domain_assets\n      WHERE customer_id = ${customerId}\n',
  '      FROM domain_assets\n      WHERE TRUE\n',
  scopeTest,
)
add(
  'orders-customer-id',
  '      FROM orders\n      WHERE customer_id = ${customerId}\n',
  '      FROM orders\n      WHERE TRUE\n',
  scopeTest,
)
add(
  'orders-nonterminal-status',
  "        AND status NOT IN ('succeeded', 'refunded', 'cancelled')\n",
  '',
  terminalTest,
)
add(
  'renewals-customer-id',
  '      FROM renewals\n      WHERE customer_id = ${customerId}\n',
  '      FROM renewals\n      WHERE TRUE\n',
  scopeTest,
)
add(
  'renewals-pending-status',
  "        AND status IN ('pending', 'manual_review')\n",
  '',
  terminalTest,
)
add(
  'refund-order-join',
  '      INNER JOIN orders ON orders.id = refunds.order_id\n      WHERE orders.customer_id = ${customerId}\n        AND refunds.status',
  '      INNER JOIN orders ON TRUE\n      WHERE orders.customer_id = ${customerId}\n        AND refunds.status',
  scopeTest,
)
add(
  'refund-customer-id',
  '      WHERE orders.customer_id = ${customerId}\n        AND refunds.status',
  '      WHERE TRUE\n        AND refunds.status',
  scopeTest,
)
add(
  'refund-unsettled-status',
  "        AND refunds.status <> 'succeeded'\n      UNION ALL\n      SELECT 1\n      FROM reconciliations",
  '      UNION ALL\n      SELECT 1\n      FROM reconciliations',
  terminalTest,
)
add(
  'reconciliation-record-key-relation',
  "        ON reconciliations.record_key = 'order:' || orders.order_number\n        OR reconciliations.summary",
  '        ON FALSE\n        OR reconciliations.summary',
  'detects an unmatched reconciliation through the record-key relationship independently',
)
add(
  'reconciliation-summary-relation',
  "        OR reconciliations.summary ->> 'orderNumber' = orders.order_number\n",
  '        OR FALSE\n',
  'detects an unmatched reconciliation through the summary relationship independently',
)
add(
  'reconciliation-order-relation',
  "        ON reconciliations.record_key = 'order:' || orders.order_number\n        OR reconciliations.summary ->> 'orderNumber' = orders.order_number\n",
  '        ON TRUE\n',
  scopeTest,
)
add(
  'reconciliation-customer-id',
  '      WHERE orders.customer_id = ${customerId}\n        AND reconciliations.status',
  '      WHERE TRUE\n        AND reconciliations.status',
  scopeTest,
)
add(
  'reconciliation-open-status',
  "        AND reconciliations.status IN ('pending', 'difference')\n",
  '',
  terminalTest,
)
add(
  'invoice-order-join',
  '        INNER JOIN orders ON orders.id = order_manual_actions.order_id\n',
  '        INNER JOIN orders ON TRUE\n',
  scopeTest,
)
add(
  'invoice-customer-id',
  '        WHERE orders.customer_id = ${customerId}\n',
  '        WHERE TRUE\n',
  scopeTest,
)
add(
  'invoice-action-type',
  "          AND order_manual_actions.action_type = 'invoice_note'\n",
  '',
  terminalTest,
)
add(
  'invoice-latest-per-order',
  '        SELECT DISTINCT ON (order_manual_actions.order_id)\n',
  '        SELECT\n',
  terminalTest,
)
add(
  'invoice-recorded-at-order',
  '          order_manual_actions.recorded_at DESC,\n',
  '',
  terminalTest,
)
add(
  'invoice-id-tiebreaker',
  '          order_manual_actions.id DESC\n',
  '          order_manual_actions.id ASC\n',
  terminalTest,
)
add(
  'invoice-processing-status',
  "      WHERE latest_invoice_actions.invoice_status = 'processing'\n",
  '      WHERE TRUE\n',
  terminalTest,
)
add(
  'security-customer-id',
  '      FROM customers\n      WHERE id = ${customerId}\n',
  '      FROM customers\n      WHERE TRUE\n',
  scopeTest,
)
add(
  'security-suspended-status',
  "          status = 'suspended'\n          OR capability_restrictions",
  '          FALSE\n          OR capability_restrictions',
  'detects the customer suspended security state independently',
)
add(
  'security-refund-review-capability',
  "          OR capability_restrictions ? 'refund_review'\n",
  '          OR FALSE\n',
  'detects the customer refund-review security state independently',
)
add(
  'manual-review-customer-id',
  '      FROM manual_reviews\n      WHERE customer_id = ${customerId}\n',
  '      FROM manual_reviews\n      WHERE TRUE\n',
  scopeTest,
)
add('manual-review-open-status', "        AND status = 'open'\n", '', terminalTest)
add(
  'disputed-refund-order-join',
  '      INNER JOIN orders ON orders.id = refunds.order_id\n      WHERE orders.customer_id = ${customerId}\n        AND refunds.failure_category',
  '      INNER JOIN orders ON TRUE\n      WHERE orders.customer_id = ${customerId}\n        AND refunds.failure_category',
  scopeTest,
)
add(
  'disputed-refund-customer-id',
  '      WHERE orders.customer_id = ${customerId}\n        AND refunds.failure_category',
  '      WHERE TRUE\n        AND refunds.failure_category',
  scopeTest,
)
add(
  'disputed-refund-category',
  "        AND refunds.failure_category = 'disputed'\n",
  '',
  'blocks with only refund_or_reconciliation_issue when only that precondition is present',
)
add(
  'disputed-refund-unsettled-status',
  "        AND refunds.status <> 'succeeded'\n    ) AS blocked\n  `)\n  return databaseBoolean(result.rows?.[0]?.blocked)\n}\n\nasync function positiveBalance",
  '    ) AS blocked\n  `)\n  return databaseBoolean(result.rows?.[0]?.blocked)\n}\n\nasync function positiveBalance',
  terminalTest,
)
add(
  'wallet-relation-exists-guard',
  '  if (!relation.rows?.[0]?.relation_name) return false\n',
  '  if (false) return false\n',
  'returns no blockers for a clean active account',
)
add(
  'wallet-customer-id',
  '      FROM wallet_accounts\n      WHERE customer_id = ${customerId}\n',
  '      FROM wallet_accounts\n      WHERE TRUE\n',
  scopeTest,
)
add(
  'wallet-positive-available-balance',
  '        AND posted_balance - held_balance > 0\n',
  '',
  terminalTest,
)

add(
  'request-customer-id',
  "      WHERE id = ${customer.id}\n        AND status IN ('active', 'restricted')\n",
  "      WHERE TRUE\n        AND status IN ('active', 'restricted')\n",
  requestCasTest,
)
add(
  'request-allowed-status',
  "        AND status IN ('active', 'restricted')\n        AND active_account_closure_request_key IS NULL\n",
  '        AND active_account_closure_request_key IS NULL\n',
  requestCasTest,
)
add(
  'request-no-active-request',
  '        AND active_account_closure_request_key IS NULL\n        AND account_closure_execution_claimed_at IS NULL\n',
  '        AND account_closure_execution_claimed_at IS NULL\n',
  requestCasTest,
)
add(
  'request-no-execution-claim',
  '        AND account_closure_execution_claimed_at IS NULL\n      RETURNING id\n',
  '      RETURNING id\n',
  requestCasTest,
)

add(
  'revoke-customer-id',
  '      WHERE id = ${customer.id}\n        AND active_account_closure_request_key = ${input.requestId}\n',
  '      WHERE TRUE\n        AND active_account_closure_request_key = ${input.requestId}\n',
  revokeCasTest,
)
add(
  'revoke-request-key',
  '        AND active_account_closure_request_key = ${input.requestId}\n        AND account_closure_execution_claimed_at IS NULL\n',
  '        AND account_closure_execution_claimed_at IS NULL\n',
  revokeCasTest,
)
add(
  'revoke-no-execution-claim',
  "        AND account_closure_execution_claimed_at IS NULL\n        AND status IN ('active', 'restricted')\n",
  "        AND status IN ('active', 'restricted')\n",
  revokeCasTest,
)
add(
  'revoke-allowed-status',
  "        AND status IN ('active', 'restricted')\n      RETURNING id\n",
  '      RETURNING id\n',
  revokeCasTest,
)

add(
  'execute-customer-id',
  '    WHERE id = ${request.customerId}\n      AND active_account_closure_request_key = ${request.requestKey}\n',
  '    WHERE TRUE\n      AND active_account_closure_request_key = ${request.requestKey}\n',
  executeCasTest,
)
add(
  'execute-request-key',
  '      AND active_account_closure_request_key = ${request.requestKey}\n      AND account_closure_execution_claimed_at IS NULL\n',
  '      AND account_closure_execution_claimed_at IS NULL\n',
  executeCasTest,
)
add(
  'execute-no-existing-claim',
  "      AND account_closure_execution_claimed_at IS NULL\n      AND status IN ('active', 'restricted')\n",
  "      AND status IN ('active', 'restricted')\n",
  executeCasTest,
)
add(
  'execute-allowed-status',
  "      AND status IN ('active', 'restricted')\n    RETURNING id, status, capability_restrictions\n",
  '    RETURNING id, status, capability_restrictions\n',
  executeCasTest,
)

add(
  'release-claim-customer-id',
  '    WHERE id = ${request.customerId}\n    RETURNING id\n',
  '    WHERE TRUE\n    RETURNING id\n',
  releaseClaimTest,
)
add(
  'release-identity-customer-id',
  '    WHERE customer_id = ${input.customerId}\n',
  '    WHERE TRUE\n',
  finalExecutionTest,
)
add('release-identity-active-status', "      AND status = 'active'\n", '', finalExecutionTest)
add(
  'release-identity-never-released',
  '      AND released_identifier_hash IS NULL\n',
  '',
  finalExecutionTest,
)
add(
  'release-identity-no-existing-rebind-time',
  '      AND rebind_allowed_at IS NULL\n',
  '',
  finalExecutionTest,
)
add(
  'anonymize-customer-id',
  '    WHERE id = ${input.customerId}\n    RETURNING id\n',
  '    WHERE TRUE\n    RETURNING id\n',
  finalExecutionTest,
)
add(
  'requested-event-request-key',
  '      WHERE request_key = ${requestKey}\n',
  '      WHERE TRUE\n',
  requestedLookupTest,
)
add('requested-event-type', "        AND event_type = 'requested'\n", '', requestedLookupTest)

add(
  'rebind-provider',
  '        WHERE provider = ${input.provider}\n',
  '        WHERE TRUE\n',
  rebindTest,
  identityFile,
)
add(
  'rebind-provider-instance',
  '          AND provider_instance_id = ${input.providerInstanceId}\n',
  '',
  rebindTest,
  identityFile,
)
add(
  'rebind-current-hash',
  '            identifier_hash = ${input.identifierHash}\n',
  '            FALSE\n',
  rebindTest,
  identityFile,
)
add(
  'rebind-released-hash',
  '            OR released_identifier_hash = ${input.identifierHash}\n',
  '            OR FALSE\n',
  rebindTest,
  identityFile,
)
add(
  'rebind-current-binding-precedence',
  '          CASE WHEN identifier_hash = ${input.identifierHash} THEN 0 ELSE 1 END,\n',
  '',
  rebindTest,
  identityFile,
)

add(
  'deletion-grant-token-hash',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE TRUE\n',
  deletionGrantSqlTest,
  stepUpFile,
)
add(
  'deletion-grant-customer-id',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n',
  deletionGrantSqlTest,
  stepUpFile,
)
add(
  'deletion-grant-purpose',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n            AND purpose = ${input.purpose}\n',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n',
  deletionGrantSqlTest,
  stepUpFile,
)
add(
  'deletion-grant-device-hash',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n            AND purpose = ${input.purpose}\n            AND device_hash = ${deviceHash}\n',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n            AND purpose = ${input.purpose}\n',
  deletionGrantSqlTest,
  stepUpFile,
)
add(
  'deletion-grant-unconsumed',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n            AND purpose = ${input.purpose}\n            AND device_hash = ${deviceHash}\n            AND consumed_at IS NULL\n',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n            AND purpose = ${input.purpose}\n            AND device_hash = ${deviceHash}\n',
  deletionGrantSqlTest,
  stepUpFile,
)
add(
  'deletion-grant-unexpired',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n            AND purpose = ${input.purpose}\n            AND device_hash = ${deviceHash}\n            AND consumed_at IS NULL\n            AND expires_at > NOW()\n',
  '          UPDATE step_up_grants\n          SET consumed_at = NOW(), updated_at = NOW()\n          WHERE token_hash = ${tokenHash}\n            AND customer_id = ${input.customerId}\n            AND purpose = ${input.purpose}\n            AND device_hash = ${deviceHash}\n            AND consumed_at IS NULL\n',
  deletionGrantSqlTest,
  stepUpFile,
)

function occurrences(source, search) {
  return source.split(search).length - 1
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

if (process.argv[2] === '--list') {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.id}\t${mutation.file}\t${mutation.test}\n`)
  }
  process.exit(0)
}

let failed = false
let killed = 0
for (const mutation of mutations) {
  const path = `${webRoot}/${mutation.file}`
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
        '--dir',
        'apps/web',
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
  const failureLine = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.id}\nTEST ${mutation.test}\n`)
  process.stdout.write(`RAW_FAILURE ${failureLine}\n`)
  if (result?.status !== 0 && failureLine) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write(`\nA6_SQL_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${mutations.length}\n`)
if (failed) process.exitCode = 1
