import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integration = 'tests/integration/d9b6-wallet-reconciliation.integration.test.ts'
const files = {
  ledger: 'src/services/wallet/ledger.ts',
  reconciliation: 'src/services/commerce/reconciliation.ts',
}

const mutations = []
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })
const add = (file, group, id, predicate, test, edits) =>
  mutations.push({ edits, file, group, id, predicate, test })

add(
  files.reconciliation,
  'input',
  'wallet-period-validation',
  'the wallet callpoint validates start before end',
  'rejects an invalid period and a non-array upstream result',
  [
    edit('  assertPeriod(input.period)\n', '  void input.period\n', {
      expectedOccurrences: 4,
      occurrence: 4,
    }),
  ],
)
add(
  files.reconciliation,
  'input',
  'upstream-retry-count',
  'a failed read is retried once before the task fails',
  'records and retries an upstream read failure',
  [
    edit(
      'const WALLET_RECONCILIATION_SOURCE_ATTEMPTS = 2',
      'const WALLET_RECONCILIATION_SOURCE_ATTEMPTS = 1',
    ),
  ],
)
add(
  files.reconciliation,
  'input',
  'upstream-array-shape',
  'the upstream source must return a statement array',
  'rejects an invalid period and a non-array upstream result',
  [edit('      if (!Array.isArray(entries)) {\n', '      if (false) {\n')],
)
add(
  files.reconciliation,
  'input',
  'upstream-failure-audit',
  'an exhausted upstream failure records retryable audit evidence',
  'records and retries an upstream read failure',
  [
    edit(
      "  await recordWalletReconciliationSourceFailure(req, {\n    attempts: WALLET_RECONCILIATION_SOURCE_ATTEMPTS,\n    outcome: 'exhausted',\n    traceId: input.traceId,\n  })\n",
      '',
    ),
  ],
)

for (const [id, predicate, search, replacement] of [
  [
    'key-period-start',
    'reconciliation idempotency binds the period start',
    '    input.period.start,\n',
    "    '',\n",
  ],
  [
    'key-period-end',
    'reconciliation idempotency binds the period end',
    '    input.period.end,\n',
    "    '',\n",
  ],
  [
    'key-record-key',
    'reconciliation idempotency binds the business key',
    '    input.recordKey,\n',
    "    '',\n",
  ],
]) {
  add(
    files.reconciliation,
    'idempotency',
    id,
    predicate,
    id === 'key-record-key'
      ? 'records all four ledgers as matched'
      : 'binds reconciliation idempotency independently to both period boundaries',
    [edit(search, replacement)],
  )
}
add(
  files.reconciliation,
  'idempotency',
  'key-excludes-run-trace',
  'retries with a new trace still reuse the period and business key',
  'replays the same period and business difference',
  [edit('    input.recordKey,\n', '    input.recordKey,\n    input.traceId,\n')],
)
add(
  files.reconciliation,
  'idempotency',
  'top-up-business-key',
  'the wallet difference key uses the stable top-up order number',
  'replays the same period and business difference',
  [
    edit(
      '          recordKey: `top-up:${topUpOrderNumber ?? transactionKey}`,\n',
      '          recordKey: `top-up:${transactionKey}`,\n',
    ),
  ],
)
add(
  files.reconciliation,
  'idempotency',
  'atomic-conflict-insert',
  'concurrent runs rely on the unique reconciliation key',
  'serializes concurrent runs for one period',
  [
    edit(
      '      ON CONFLICT (reconciliation_key) DO NOTHING\n',
      '      ON CONFLICT (reconciliation_key) DO UPDATE SET trace_id = reconciliations.trace_id\n',
    ),
    edit(
      '    if (insertedId === undefined) return { idempotentReplay: true, record }\n',
      '    if (insertedId !== undefined) return { idempotentReplay: true, record }\n',
    ),
  ],
)

add(
  files.reconciliation,
  'difference-escalation',
  'difference-status',
  'a nonzero amount persists as difference rather than matched',
  'reports a top-up versus WeChat difference',
  [
    edit(
      "        ${input.differenceMinor === 0 ? 'matched' : 'difference'},\n",
      "        ${'matched'},\n",
    ),
  ],
)
add(
  files.reconciliation,
  'difference-escalation',
  'difference-branch',
  'a difference enters the escalation branch',
  'reports a top-up versus WeChat difference',
  [edit('    if (input.differenceMinor !== 0) {\n', '    if (false) {\n')],
)
add(
  files.reconciliation,
  'difference-escalation',
  'manual-review-create',
  'a wallet difference creates an existing manual review',
  'reports a top-up versus WeChat difference',
  [edit('      if (input.review) {\n', '      if (false) {\n')],
)
add(
  files.reconciliation,
  'difference-escalation',
  'difference-audit',
  'a wallet difference records an audit event',
  'reports a top-up versus WeChat difference',
  [
    edit(
      "        await recordAuditEvent(req, {\n          action: 'wallet.reconciliation.difference_recorded',\n",
      "        void ({\n          action: 'wallet.reconciliation.difference_recorded',\n",
    ),
  ],
)
add(
  files.reconciliation,
  'difference-escalation',
  'correction-applied-false',
  'wallet difference evidence explicitly says no correction occurred',
  'reports a top-up versus WeChat difference',
  [
    edit('            correctionApplied: false,\n', '            correctionApplied: true,\n', {
      expectedOccurrences: 5,
      occurrence: 2,
    }),
  ],
)
for (const [id, predicate, search, replacement, test] of [
  [
    'review-reconciliation-link',
    'the review links the exact reconciliation row',
    '            reconciliation: record.id as never,\n',
    '            reconciliation: undefined,\n',
    'reports a top-up versus WeChat difference',
  ],
  [
    'review-top-up-link',
    'a top-up difference review links the top-up order',
    '              : { walletTopUpOrder: input.review.walletTopUpOrderId as never }),\n',
    '              : {}),\n',
    'reports a top-up versus WeChat difference',
  ],
  [
    'review-order-link',
    'a balance payment difference review links the order',
    '            ...(input.review.orderId === undefined ? {} : { order: input.review.orderId as never }),\n',
    '            ...(input.review.orderId === undefined ? {} : {}),\n',
    'reports a balance payment versus internal-order difference',
  ],
  [
    'review-wallet-account-link',
    'a cache difference review links the wallet account',
    '              : { walletAccount: input.review.walletAccountId as never }),\n',
    '              : {}),\n',
    'derives balances from walletEntries',
  ],
]) {
  add(files.reconciliation, 'difference-escalation', id, predicate, test, [
    edit(search, replacement),
  ])
}

add(
  files.reconciliation,
  'wechat-mapping',
  'top-up-wechat-transaction-id',
  'a top-up payment binds the statement transaction id',
  'fails closed for independently de-correlated WeChat identity',
  [
    edit(
      '      const topUpWechatIdMatches = topUp?.wechatTransactionId === entry.wechatTransactionId\n',
      '      const topUpWechatIdMatches = Boolean(topUp)\n',
    ),
  ],
)
add(
  files.reconciliation,
  'wechat-mapping',
  'top-up-exclusive-source',
  'a mismatched top-up identity cannot become the sole expected source',
  'fails closed for independently de-correlated WeChat identity',
  [
    edit(
      '      const sourceCount = Number(Boolean(order)) + Number(Boolean(topUp && topUpWechatIdMatches))\n',
      '      const sourceCount = Number(Boolean(order)) + Number(Boolean(topUp))\n',
    ),
  ],
)
add(
  files.reconciliation,
  'wechat-mapping',
  'payment-evidence-business-key',
  'wallet credit looks up WeChat evidence by top-up order number',
  'reports a top-up versus WeChat difference',
  [
    edit(
      '        if (topUpOrderNumber)\n          paymentEvidence.set(topUpOrderNumber, { amount: observedMinor, matched })\n',
      "        if (topUpOrderNumber)\n          paymentEvidence.set('mutant-top-up', { amount: observedMinor, matched })\n",
    ),
  ],
)
add(
  files.reconciliation,
  'wechat-mapping',
  'recovery-evidence-business-key',
  'wallet recovery looks up WeChat evidence by recovery key',
  'reports a payment recovery versus WeChat reversal difference',
  [
    edit(
      '        if (recoveryKey) recoveryEvidence.set(recoveryKey, { amount: observedMinor, matched })\n',
      "        if (recoveryKey) recoveryEvidence.set('mutant-recovery', { amount: observedMinor, matched })\n",
    ),
  ],
)

add(
  files.reconciliation,
  'four-way-mapping',
  'top-up-only-credit-prefix',
  'only top-up credit keys map wallet credits to WeChat funds',
  'records all four ledgers as matched',
  [edit("      AND transaction.transaction_key LIKE 'wallet-top-up:%:credit'\n", '')],
)
add(
  files.reconciliation,
  'four-way-mapping',
  'balance-payment-channel',
  'only balance-channel orders match wallet captures',
  'fails closed for independently de-correlated WeChat identity',
  [
    edit(
      "      const orderFactMatches = orderId !== undefined && row.payment_channel === 'balance'\n",
      '      const orderFactMatches = orderId !== undefined\n',
    ),
  ],
)
add(
  files.reconciliation,
  'four-way-mapping',
  'balance-payment-order-amount',
  'wallet capture compares against the frozen internal order amount',
  'reports a balance payment versus internal-order difference',
  [
    edit(
      '      const difference = walletAmount - (orderAmount ?? 0n)\n',
      '      const difference = walletAmount - walletAmount\n',
    ),
  ],
)
add(
  files.reconciliation,
  'four-way-mapping',
  'top-up-wechat-observed-amount',
  'wallet credit compares against observed WeChat funds rather than the top-up row',
  'reports a top-up versus WeChat difference',
  [
    edit(
      '      const difference = walletAmount - (wechat?.amount ?? 0n)\n',
      '      const difference = walletAmount - (topUpAmount ?? 0n)\n',
    ),
  ],
)
add(
  files.reconciliation,
  'four-way-mapping',
  'recovery-wechat-observed-amount',
  'wallet recovery compares against the reverse WeChat amount',
  'reports a payment recovery versus WeChat reversal difference',
  [
    edit(
      '      const difference = walletAmount - (recovery?.amount ?? 0n)\n',
      '      const difference = walletAmount - databaseInteger(row.top_up_amount_fen)\n',
    ),
  ],
)

add(
  files.reconciliation,
  'ledger-source',
  'posted-source-wallet-entries',
  'posted balance comes from walletEntries rather than the account cache',
  'derives balances from walletEntries',
  [
    edit(
      '      const postedFromEntries = databaseInteger(row.posted_balance_from_entries_fen)\n',
      '      const postedFromEntries = databaseInteger(row.posted_balance_cache_fen)\n',
    ),
  ],
)
add(
  files.reconciliation,
  'ledger-source',
  'held-source-wallet-entries',
  'held balance comes from walletEntries rather than the account cache',
  'derives balances from walletEntries',
  [
    edit(
      '      const heldFromEntries = databaseInteger(row.held_balance_from_entries_fen)\n',
      '      const heldFromEntries = databaseInteger(row.held_balance_cache_fen)\n',
    ),
  ],
)
add(
  files.reconciliation,
  'ledger-source',
  'cache-posted-difference',
  'cache drift includes the posted component',
  'derives balances from walletEntries',
  [
    edit(
      '        absolute(postedFromEntries - postedCache) + absolute(heldFromEntries - heldCache)\n',
      '        absolute(heldFromEntries - heldCache)\n',
    ),
  ],
)
add(
  files.reconciliation,
  'ledger-source',
  'cache-held-difference',
  'cache drift includes the held component',
  'derives balances from walletEntries',
  [
    edit(
      '        absolute(postedFromEntries - postedCache) + absolute(heldFromEntries - heldCache)\n',
      '        absolute(postedFromEntries - postedCache)\n',
    ),
  ],
)
add(
  files.reconciliation,
  'read-only',
  'cache-no-auto-correction',
  'reconciliation never writes a corrected cache balance',
  'derives balances from walletEntries',
  [
    edit(
      '      const differenceMinor = safeDifferenceMinor(difference)\n      results.push(\n',
      '      const differenceMinor = safeDifferenceMinor(difference)\n      await database.execute(sql`UPDATE wallet_accounts SET posted_balance_cache_fen = ${postedFromEntries.toString()}, held_balance_cache_fen = ${heldFromEntries.toString()} WHERE id = ${accountId}`)\n      results.push(\n',
    ),
  ],
)
add(
  files.reconciliation,
  'ledger-source',
  'cache-summary-source-label',
  'the evidence identifies walletEntries as the aggregate source',
  'derives balances from walletEntries',
  [
    edit(
      "            source: 'wallet_entries_aggregate',\n",
      "            source: 'wallet_accounts_cache',\n",
    ),
  ],
)

add(
  files.ledger,
  'cache-snapshot',
  'mutation-posted-cache-refresh',
  'normal wallet mutations refresh posted cache from the derived entry balance',
  'records all four ledgers as matched',
  [
    edit(
      '      posted_balance_cache_fen = ${balance.postedBalance.toString()},\n',
      '      posted_balance_cache_fen = posted_balance_cache_fen,\n',
    ),
  ],
)
add(
  files.ledger,
  'cache-snapshot',
  'settlement-held-cache-refresh',
  'capture and release refresh held cache from the derived entry balance',
  'records all four ledgers as matched',
  [
    edit(
      '      held_balance_cache_fen = ${balance.heldBalance.toString()},\n',
      '      held_balance_cache_fen = held_balance_cache_fen,\n',
    ),
  ],
)
add(
  files.ledger,
  'cache-snapshot',
  'hold-cache-refresh',
  'a hold refreshes held cache without making it a source of truth',
  'records all four ledgers as matched',
  [
    edit(
      '      held_balance_cache_fen = ${(account.heldBalance + delta).toString()},\n',
      '      held_balance_cache_fen = held_balance_cache_fen,\n',
    ),
  ],
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

function mutateSource(source, mutation) {
  let result = source
  for (const change of mutation.edits) {
    const found = occurrences(result, change.search)
    const expected = change.expectedOccurrences ?? 1
    if (found !== expected) {
      throw new Error(
        `expected ${expected} occurrences of ${JSON.stringify(change.search)}, found ${found}`,
      )
    }
    result = replaceOccurrence(result, change.search, change.replacement, change.occurrence ?? 1)
  }
  return result
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.group}/${mutation.id}\t${mutation.predicate}\t${integration} :: ${mutation.test}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}

if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      mutateSource(readFileSync(`${webRoot}/${mutation.file}`, 'utf8'), mutation)
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
  process.stderr.write(`No D9-B-6 mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
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
        integration,
        '-t',
        mutation.test,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_REAL_PROVIDER_WRITES: 'false',
          ALLOW_REAL_WECHATPAY: 'false',
          ALLOW_REAL_WECHATPAY_PAYMENTS: 'false',
          ALLOW_REAL_WECHATPAY_REFUNDS: 'false',
          ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_READS: 'false',
          ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES: 'false',
        },
      },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(
    `\nMUTATION ${mutation.group}/${mutation.id}\nPREDICATE ${mutation.predicate}\nTEST ${integration} :: ${mutation.test}\nRAW_FAILURE ${failure}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError:')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`RAW_OUTPUT ${output.split('\n').slice(-35).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(
  `\nD9B6_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
