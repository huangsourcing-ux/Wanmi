import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const servicePath = `${webRoot}/src/services/vip/tiers.ts`
const testFile = 'tests/integration/d9e3-vip-tiers.integration.test.ts'
const mutations = []
const add = (mutation) => mutations.push(mutation)

for (const mutation of [
  {
    id: 'rule-effective-window',
    predicate: 'applicable rule excludes versions effective after the event clock',
    search: '    WHERE effective_at < ${at.toISOString()}\n',
    replacement: '    WHERE effective_at > ${at.toISOString()}\n',
    test: 'counts a successful order but creates no achievement before the first effective rule',
  },
  {
    id: 'rule-inclusive-boundary',
    predicate: 'applicable rule includes the exact effective instant',
    search: '       OR (${inclusive} AND effective_at = ${at.toISOString()})\n',
    replacement: '       OR (false AND effective_at = ${at.toISOString()})\n',
    test: 'selects the highest version when two rules have the same effective time',
  },
  {
    id: 'rule-version-tie-breaker',
    predicate: 'same-time rules select the globally unique highest version',
    search: '    ORDER BY effective_at DESC, version DESC\n',
    replacement: '    ORDER BY effective_at DESC, version ASC\n',
    test: 'selects the highest version when two rules have the same effective time',
  },
  {
    id: 'levels-rule-id-scope',
    predicate: 'rule levels belong to the selected rule row',
    search: '    WHERE rule_version_id = ${rule.id}\n',
    replacement: '    WHERE rule_version_id <> ${rule.id}\n',
    test: 'iterates physically reversed rule rows by rank and records every crossed tier',
  },
  {
    id: 'levels-version-binding',
    predicate: 'rule levels repeat and match the selected immutable version number',
    search: '      AND version_number = ${rule.version}\n',
    replacement: '',
    test: 'fails closed when a rule level carries another version number',
  },
  {
    id: 'levels-rank-order',
    predicate: 'crossed tiers are iterated by ascending unique rank',
    search: '    ORDER BY tier_rank ASC\n',
    replacement: '    ORDER BY tier_rank DESC\n',
    test: 'iterates physically reversed rule rows by rank and records every crossed tier',
  },
  {
    id: 'holder-customer-order',
    predicate: 'advance notifications enumerate holders in ascending customer order',
    search: '    ORDER BY latest.customer_id ASC\n',
    replacement: '    ORDER BY latest.customer_id DESC\n',
    test: 'notifies current holders in deterministic ascending customer order',
  },
  {
    id: 'holder-current-event-id-tie',
    predicate: 'holder selection uses the higher event id when timestamps tie',
    search: '      ORDER BY customer_id ASC, occurred_at DESC, id DESC\n',
    replacement: '      ORDER BY customer_id ASC, occurred_at DESC, id ASC\n',
    test: 'does not notify a corrected-to-zero former holder when event timestamps tie',
  },
  {
    id: 'holder-positive-current-tier',
    predicate: 'only customers whose latest event has a positive tier are notified',
    search: '    WHERE latest.tier_rank > 0\n',
    replacement: '    WHERE latest.tier_rank >= 0\n',
    test: 'does not notify a corrected-to-zero former holder when event timestamps tie',
  },
  {
    id: 'holder-customer-present',
    predicate: 'advance notifications exclude anonymized history without a customer relation',
    search: '      AND latest.customer_id IS NOT NULL\n',
    replacement: '      AND TRUE\n',
    test: 'notifies current holders in deterministic ascending customer order',
  },
  {
    id: 'customer-lock-scope',
    predicate: 'customer mutex locks exactly the affected customer',
    search: '  ).execute(sql`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`)\n',
    replacement: '  ).execute(sql`SELECT id FROM customers WHERE id = ${customerId} FOR SHARE`)\n',
    test: 'serializes different succeeded orders so one customer reaches each rank exactly once',
  },
  {
    id: 'spend-credit-source',
    predicate: 'cumulative spend credits only succeeded-order facts',
    search: "        WHEN entry_type = 'succeeded_order' THEN amount_fen\n",
    replacement: "        WHEN entry_type = 'succeeded_order' THEN 0\n",
    test: 'counts the frozen payable amount for successful native orders',
  },
  {
    id: 'spend-order-reversal-source',
    predicate: 'ordinary order reversals subtract from cumulative spend',
    search:
      "        WHEN entry_type IN ('order_reversal', 'data_correction', 'fraud_reversal') THEN -amount_fen\n",
    replacement:
      "        WHEN entry_type IN ('data_correction', 'fraud_reversal') THEN -amount_fen\n",
    test: 'subtracts an independently recorded reversal before evaluating a later achievement',
  },
  {
    id: 'spend-data-correction-source',
    predicate: 'approved data-correction debits subtract from cumulative spend',
    search:
      "        WHEN entry_type IN ('order_reversal', 'data_correction', 'fraud_reversal') THEN -amount_fen\n",
    replacement:
      "        WHEN entry_type IN ('order_reversal', 'fraud_reversal') THEN -amount_fen\n",
    test: 'records data correction as an approved append-only event and matching audit fact',
  },
  {
    id: 'spend-fraud-reversal-source',
    predicate: 'approved fraud-reversal debits subtract from cumulative spend',
    search:
      "        WHEN entry_type IN ('order_reversal', 'data_correction', 'fraud_reversal') THEN -amount_fen\n",
    replacement:
      "        WHEN entry_type IN ('order_reversal', 'data_correction') THEN -amount_fen\n",
    test: 'records fraud reversal as an approved append-only event and matching audit fact',
  },
  {
    id: 'spend-customer-scope',
    predicate: 'cumulative spend is scoped to one customer ledger',
    search: '    FROM vip_spend_entries\n    WHERE customer_id = ${customerId}\n',
    replacement: '    FROM vip_spend_entries\n    WHERE TRUE\n',
    test: 'scopes cumulative spend and tier history to the authenticated customer',
  },
  {
    id: 'tier-event-customer-scope',
    predicate: 'current tier reads only the requested customer event stream',
    search: '    FROM vip_tier_events\n    WHERE customer_id = ${customerId}\n',
    replacement: '    FROM vip_tier_events\n    WHERE TRUE\n',
    test: 'scopes cumulative spend and tier history to the authenticated customer',
  },
  {
    id: 'tier-event-latest-time-source',
    predicate: 'current tier selects the latest event timestamp before the id tie-breaker',
    search: '        SELECT MAX(occurred_at)\n',
    replacement: '        SELECT MIN(occurred_at)\n',
    test: 'orders current tier by event time before using the id tie-breaker',
  },
  {
    id: 'tier-source-replaced-by-current-spend',
    predicate: 'current tier comes from the event stream, never a current-spend recomputation',
    search: '    FROM vip_tier_events\n    WHERE customer_id = ${customerId}\n',
    replacement:
      "    FROM vip_tier_events\n    WHERE customer_id = ${customerId}\n      AND cumulative_spend_fen_snapshot <= (\n        SELECT COALESCE(SUM(CASE\n          WHEN entry_type = 'succeeded_order' THEN amount_fen\n          ELSE -amount_fen\n        END), 0)\n        FROM vip_spend_entries\n        WHERE customer_id = ${customerId}\n      )\n",
    test: 'keeps the achieved historical high-water tier after an ordinary refund reversal',
  },
  {
    id: 'order-authoritative-table',
    predicate: 'eligibility reads commerce orders rather than wallet top-up orders',
    search: '    FROM orders\n    WHERE id = ${orderId}\n',
    replacement: '    FROM wallet_top_up_orders\n    WHERE id = ${orderId}\n',
    test: 'excludes a wallet top-up itself from cumulative VIP spend',
  },
  {
    id: 'order-id-scope',
    predicate: 'eligibility reads exactly the transitioned order id',
    search: '    FROM orders\n    WHERE id = ${orderId}\n',
    replacement: '    FROM orders\n    WHERE id <> ${orderId}\n',
    test: 'counts the frozen payable amount for successful native orders',
  },
  {
    id: 'order-frozen-amount-source',
    predicate: 'spend uses the order frozen amount_minor field',
    search: '      amount_minor AS "amountFen",\n',
    replacement: '      1::numeric AS "amountFen",\n',
    test: 'counts the frozen payable amount for successful native orders',
  },
  {
    id: 'order-payment-channel-source',
    predicate: 'spend snapshots the authoritative order payment channel',
    search: '      payment_channel AS "paymentChannel"\n',
    replacement: '      \'native\'::text AS "paymentChannel"\n',
    test: 'counts the frozen payable amount for successful h5 orders',
  },
  {
    id: 'order-native-channel',
    predicate: 'native is an accepted order payment channel',
    search: "    row.paymentChannel === 'native' ||\n",
    replacement: '    false ||\n',
    test: 'counts the frozen payable amount for successful native orders',
  },
  {
    id: 'order-h5-channel',
    predicate: 'h5 is an accepted order payment channel',
    search: "    row.paymentChannel === 'h5' ||\n",
    replacement: '    false ||\n',
    test: 'counts the frozen payable amount for successful h5 orders',
  },
  {
    id: 'order-balance-channel',
    predicate: 'balance is an accepted order payment channel',
    search: "    row.paymentChannel === 'balance'\n",
    replacement: '    false\n',
    test: 'counts the frozen payable amount for successful balance orders',
  },
  {
    id: 'order-share-lock',
    predicate: 'eligibility holds a shared order lock against concurrent state writes',
    search: '    FOR SHARE\n',
    replacement: '',
    occurrence: 1,
    expectedOccurrences: 1,
    test: 'waits for an in-flight order-state write before deciding succeeded eligibility',
  },
  {
    id: 'spend-entry-idempotency',
    predicate: 'the succeeded-order spend fact uses its unique conflict key',
    search: '      ON CONFLICT (entry_key) DO NOTHING\n      RETURNING id\n',
    replacement: '      RETURNING id\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'records exactly one achievement when the same customer triggers it concurrently',
  },
  {
    id: 'reversal-source-order',
    predicate: 'refund reversal reads the requested source order fact',
    search: '      WHERE spend.source_order_id = ${input.orderId}\n',
    replacement: '      WHERE spend.source_order_id <> ${input.orderId}\n',
    test: 'records a refunded-order reversal once while preserving the achieved tier',
  },
  {
    id: 'reversal-success-fact',
    predicate: 'refund reversal requires a prior succeeded-order spend fact',
    search: "        AND spend.entry_type = 'succeeded_order'\n",
    replacement: "        AND spend.entry_type = 'order_reversal'\n",
    test: 'records a refunded-order reversal once while preserving the achieved tier',
  },
  {
    id: 'reversal-refunded-order-state',
    predicate: 'refund reversal requires the authoritative refunded order state',
    search: "        AND orders.status = 'refunded'\n",
    replacement: '        AND TRUE\n',
    test: 'does not reverse a VIP spend fact before the order is actually refunded',
  },
  {
    id: 'reversal-entry-idempotency',
    predicate: 'the order-reversal fact uses its unique conflict key',
    search: '      ON CONFLICT (entry_key) DO NOTHING\n      RETURNING id\n',
    replacement: '      RETURNING id\n',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'records a refunded-order reversal once while preserving the achieved tier',
  },
  {
    id: 'history-event-time-order',
    predicate: 'current tier and customer-visible history sort by occurrence time first',
    search:
      '    Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || Number(right.id) - Number(left.id)\n',
    replacement: '    Number(right.id) - Number(left.id)\n',
    test: 'orders current tier by event time before using the id tie-breaker',
  },
  {
    id: 'history-event-id-tie-breaker',
    predicate: 'current tier and customer-visible history use id for equal occurrence times',
    search:
      '    Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || Number(right.id) - Number(left.id)\n',
    replacement: '    Date.parse(right.occurredAt) - Date.parse(left.occurredAt)\n',
    test: 'uses the higher event id when tier events share the exact same timestamp',
  },
  {
    id: 'appeal-local-api-access',
    predicate: 'appeal event lookup enforces customer access instead of Local API override',
    search: '      overrideAccess: false,\n      req,\n      user: req.user,\n',
    replacement: '      overrideAccess: true,\n      req,\n      user: req.user,\n',
    test: 'rejects an appeal for another customer correction record',
  },
])
  add({ group: 'sql', ...mutation })

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
  const found = occurrences(source, mutation.search)
  const expected = mutation.expectedOccurrences ?? 1
  if (found !== expected) throw new Error(`expected ${expected} occurrences, found ${found}`)
  return replaceOccurrence(source, mutation.search, mutation.replacement, mutation.occurrence ?? 1)
}
const stripAnsi = (value) => value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.group}\t${mutation.id}\t${mutation.predicate}\t${mutation.test}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  const source = readFileSync(servicePath, 'utf8')
  for (const mutation of mutations) {
    try {
      mutateSource(source, mutation)
    } catch (error) {
      invalid += 1
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  process.exit(invalid ? 1 : 0)
}
const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-E-3 SQL mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const original = readFileSync(servicePath, 'utf8')
  let result
  try {
    writeFileSync(servicePath, mutateSource(original, mutation), 'utf8')
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
    writeFileSync(servicePath, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const assertion = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`MUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `PREDICATE ${mutation.predicate}\nTEST ${mutation.test}\nRAW_FAILURE ${assertion}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError:')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`${output.split('\n').slice(-30).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(`D9E3_SQL_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
