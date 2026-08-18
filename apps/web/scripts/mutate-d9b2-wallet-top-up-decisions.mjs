import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9b2-wallet-top-ups.integration.test.ts'
const unitTest = 'tests/unit/d9b2-wallet-top-up-contracts.test.ts'
const serviceFile = 'src/services/wallet/top-ups.ts'
const paymentsFile = 'src/services/commerce/payments.ts'
const collectionFile = 'src/collections/wallet.ts'
const mutations = []
const add = (mutation) =>
  mutations.push({ file: serviceFile, testFile: integrationTest, ...mutation })

for (const mutation of [
  {
    id: 'amount-requires-safe-integer',
    search: "typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : 0n",
    replacement: "typeof value === 'bigint' ? value : BigInt(Math.trunc(value))",
  },
  {
    id: 'amount-requires-positive',
    search: 'amount <= 0n || amount > MAX_SAFE_MONEY',
    replacement: 'amount > MAX_SAFE_MONEY',
  },
  {
    id: 'amount-requires-safe-maximum',
    search: 'amount <= 0n || amount > MAX_SAFE_MONEY',
    replacement: 'amount <= 0n',
  },
]) {
  add({
    group: 'input',
    test: 'rejects every non-positive, fractional, and unsafe top-up amount before writes',
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'confirmation-cooldown-callpoint',
    occurrence: 1,
    test: 'enforces identity-risk cooldown at the provider-confirmation callpoint',
  },
  {
    id: 'create-cooldown-callpoint',
    occurrence: 2,
    test: 'enforces identity-risk cooldown at the create-order callpoint',
  },
  {
    id: 'payment-cooldown-callpoint',
    occurrence: 3,
    test: 'enforces identity-risk cooldown at the payment-create callpoint',
  },
]) {
  add({
    group: 'cooldown-callpoint',
    search: '    await assertTopUpCapability(req, ',
    replacement: '    await Promise.resolve(); void (',
    expectedOccurrences: 3,
    ...mutation,
  })
}

add({
  group: 'funding-source',
  id: 'create-rejects-balance-funding',
  search: "  if (input.fundingSource !== 'wechat') {\n",
  replacement: '  if (false) {\n',
  test: 'rejects using wallet balance as the funding source before creating an order',
})

for (const mutation of [
  { id: 'create-auth-callpoint', occurrence: 1 },
  { id: 'payment-auth-callpoint', occurrence: 2 },
  { id: 'query-auth-callpoint', occurrence: 3 },
]) {
  add({
    group: 'auth-callpoint',
    search: '  assertCustomer(req, options.customer)\n',
    replacement: '',
    expectedOccurrences: 3,
    test: 'enforces customer authentication at create, payment, and query callpoints',
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'confirmation-capability-callpoint',
    occurrence: 1,
    test: 'enforces purchase capability at the provider-confirmation callpoint',
  },
  {
    id: 'create-capability-callpoint',
    occurrence: 2,
    test: 'enforces purchase capability at the create-order callpoint',
  },
  {
    id: 'payment-capability-callpoint',
    occurrence: 3,
    test: 'enforces purchase capability at the payment-create callpoint',
  },
]) {
  add({
    group: 'capability-callpoint',
    search: '    await assertTopUpCapability(req, ',
    replacement: '    await Promise.resolve(); void (',
    expectedOccurrences: 3,
    ...mutation,
  })
}

add({
  group: 'capability-guard',
  id: 'purchase-capability-guard',
  search: "  await assertCustomerAccountCapability(req, customerId, 'purchase')\n",
  replacement: '',
  test: 'enforces purchase capability at the create-order callpoint',
})
add({
  group: 'cooldown-guard',
  id: 'identity-risk-cooldown-guard',
  search: '  await assertIdentityRiskCooldownInactive(req, customerId)\n',
  replacement: '',
  test: 'enforces identity-risk cooldown at the create-order callpoint',
})

add({
  group: 'query-state',
  id: 'unknown-query-keeps-current-state',
  search: "!queryResult.ok || !query || query.state === 'unknown'",
  replacement: '!queryResult.ok || !query',
  test: 'keeps the current state and balance when the active query state is unknown',
})
add({
  group: 'query-state',
  id: 'failed-query-keeps-current-state',
  search: "!queryResult.ok || !query || query.state === 'unknown'",
  replacement: "queryResult.ok && (!query || query.state === 'unknown')",
  test: 'keeps the current state and records unavailable evidence when active query fails',
})

for (const mutation of [
  {
    id: 'paid-query-requires-paid-state',
    search: "    order?.state !== 'paid' ||\n",
    test: 'rejects a not-paid query even when it carries success-like fields',
  },
  {
    id: 'paid-query-requires-transaction-id',
    search: '    !order.transactionId ||\n',
    test: 'requires every paid-query evidence dimension: transaction id',
  },
  {
    id: 'paid-query-requires-paid-at',
    search: '    !order.paidAt ||\n',
    test: 'requires every paid-query evidence dimension: paid timestamp',
  },
  {
    id: 'paid-query-requires-cny',
    search: "    order.currency !== 'CNY' ||\n",
    test: 'requires every paid-query evidence dimension: CNY currency',
  },
  {
    id: 'paid-query-requires-safe-integer-amount',
    search: '    !Number.isSafeInteger(Number(order.amountMinor)) ||\n',
    test: 'requires every paid-query evidence dimension: safe integer amount',
  },
  {
    id: 'paid-query-requires-positive-amount',
    search: '    (order.amountMinor ?? 0) <= 0\n',
    replacement: '    false\n',
    test: 'requires every paid-query evidence dimension: positive amount',
  },
]) {
  add({ group: 'query-shape', replacement: '', ...mutation })
}
add({
  group: 'query-match',
  id: 'merchant-order-match',
  search: '  const merchantMatches = paid.merchantOrderNumber === topUp.topUpOrderNumber\n',
  replacement: '  const merchantMatches = true\n',
  test: 'requires the active-query merchant order number to match the top-up',
})
add({
  group: 'query-match',
  id: 'provider-amount-match',
  search: '  const amountMatches = BigInt(paid.amountMinor) === positiveAmount(topUp.amountFen)\n',
  replacement: '  const amountMatches = true\n',
  test: 'rejects an active-query amount mismatch and creates one scoped manual review',
})
add({
  group: 'query-match',
  id: 'notification-match-callpoint',
  search: '  const notificationMatches = notificationMatchesQuery(source, paid)\n',
  replacement: '  const notificationMatches = true\n',
  test: 'rejects each notification/query disagreement independently',
})
add({
  group: 'query-match',
  id: 'direct-query-does-not-require-notification',
  search: "  if (source.source === 'query') return true\n",
  replacement: "  if (source.source === 'query') return false\n",
  test: 'makes repeated confirmation of one top-up add exactly one ledger credit',
})

for (const mutation of [
  {
    id: 'notification-transaction-match',
    search: '    source.notification.transactionId === query.transactionId &&\n',
  },
  {
    id: 'notification-amount-match',
    search: '    source.notification.amountMinor === query.amountMinor &&\n',
  },
  {
    id: 'notification-paid-at-match',
    search: '    Date.parse(source.notification.paidAt) === Date.parse(query.paidAt)\n',
    replacement: '    true\n',
  },
]) {
  add({
    group: 'notification-match',
    replacement: '',
    test: 'rejects each notification/query disagreement independently',
    ...mutation,
  })
}

add({
  group: 'manual-review',
  id: 'amount-mismatch-manual-review-callpoint',
  search: '      await ensureManualReview(req, topUp, reasonCode, {\n',
  replacement: '      await Promise.resolve(); void ({\n',
  test: 'rejects an active-query amount mismatch and creates one scoped manual review',
})
add({
  group: 'manual-review',
  id: 'mismatch-reason-uses-amount-result',
  search: '    const reasonCode = amountMatches\n',
  replacement: '    const reasonCode = true\n',
  test: 'rejects an active-query amount mismatch and creates one scoped manual review',
})
add({
  group: 'audit',
  id: 'unknown-query-audit-callpoint',
  search: `      await recordObservation(req, topUp, {
        outcome: 'status_unknown',
`,
  replacement: `      void ({
        outcome: 'status_unknown',
`,
  test: 'keeps the current state and balance when the active query state is unknown',
})
add({
  group: 'audit',
  id: 'not-paid-query-audit-callpoint',
  search: `      await recordObservation(req, topUp, {
        outcome: 'not_paid',
`,
  replacement: `      void ({
        outcome: 'not_paid',
`,
  test: 'requires every paid-query evidence dimension: positive amount',
})
add({
  group: 'audit',
  id: 'mismatch-query-audit-callpoint',
  search: `      await recordObservation(req, topUp, {
        outcome: reasonCode,
`,
  replacement: `      void ({
        outcome: reasonCode,
`,
  test: 'rejects an active-query amount mismatch and creates one scoped manual review',
})

for (const mutation of [
  { id: 'created-audit-callpoint', action: 'created' },
  { id: 'payment-started-audit-callpoint', action: 'payment_started' },
  { id: 'credited-audit-callpoint', action: 'credited' },
  { id: 'refunded-audit-callpoint', action: 'refunded' },
]) {
  add({
    group: 'audit',
    search: `    await recordAuditEvent(req, {
      action: 'wallet.top_up.${mutation.action}',
`,
    replacement: `    void ({
      action: 'wallet.top_up.${mutation.action}',
`,
    test: 'records each top-up lifecycle audit callpoint against the top-up',
    ...mutation,
  })
}

add({
  group: 'credit-callpoint',
  id: 'post-wallet-credit-callpoint',
  search: '    const credit = await postWalletCredit(req, {\n',
  replacement: "    const credit = { applied: false, status: 'posted' as const }; void ({\n",
  test: 'makes repeated confirmation of one top-up add exactly one ledger credit',
})
add({
  group: 'credit-callpoint',
  id: 'credited-state-update-callpoint',
  search: '    const credited = await db.execute(sql`\n',
  replacement: '    const credited = { rows: [{ id: topUp.id }] }; void (sql`\n',
  test: 'makes repeated confirmation of one top-up add exactly one ledger credit',
})
add({
  group: 'idempotency',
  id: 'credited-replay-transaction-match',
  search:
    "      if (current.status === 'credited' && current.wechatTransactionId === paid.transactionId) {\n",
  replacement: "      if (current.status === 'credited') {\n",
  test: 'rejects a different WeChat transaction on an already credited top-up',
})
add({
  group: 'refund-race',
  id: 'refunded-state-blocks-late-credit',
  search: "      if (current.status === 'refunded' || current.status === 'refund_pending') {\n",
  replacement: '      if (false) {\n',
  test: 'serializes credit and original-refund marking to one refunded nonnegative result',
})

add({
  group: 'payment-create',
  id: 'payment-create-cas-callpoint',
  search: `    const claimed = await (
      await database(req)
    ).execute(sql\`
`,
  replacement: '    const claimed = { rows: [{ id: topUp.id }] }; void (sql`\n',
  test: 'claims payment creation once from the created state',
})
add({
  group: 'query-precondition',
  id: 'active-query-requires-payment-session',
  search: '  if (!topUp.paymentChannel || !topUp.paymentExpiresAt) {\n',
  replacement: '  if (false) {\n',
  test: 'requires an authenticated owner and an existing payment session for active query',
})
add({
  group: 'notification-routing',
  id: 'notification-top-up-lookup-callpoint',
  file: paymentsFile,
  search: `  const walletTopUp = order
    ? undefined
    : await findWalletTopUpByOrderNumber(req, verified.merchantOrderNumber)
`,
  replacement: '  const walletTopUp = undefined\n',
  test: 'does not credit from a payment notification alone when the active query is not paid',
})
add({
  group: 'notification-query-source',
  id: 'notification-must-query-provider',
  search: `  const query = await provider.queryOrder({
    merchantOrderNumber: topUp.topUpOrderNumber,
    traceId,
  })
`,
  replacement: `  const query = {
    data: {
      amountMinor: notification.amountMinor,
      currency: notification.currency,
      merchantOrderNumber: notification.merchantOrderNumber,
      paidAt: notification.paidAt,
      state: 'paid' as const,
      transactionId: notification.transactionId,
    },
    observedAt: new Date().toISOString(),
    ok: true as const,
    requestId: \`\${traceId}-forged-from-notification\`,
  }
`,
  test: 'queries WeChat once and rejects a correct paid notification when the active query is not paid',
})

for (const mutation of [
  {
    id: 'refund-system-only',
    search: '  if (req.user) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'refund-number-nonblank',
    search: '  if (!refundNumber || refundNumber.length > 64) {\n',
    replacement: '  if (refundNumber.length > 64) {\n',
  },
  {
    id: 'refund-number-maximum',
    search: '  if (!refundNumber || refundNumber.length > 64) {\n',
    replacement: '  if (!refundNumber) {\n',
  },
  {
    id: 'refund-timestamp-valid',
    search: '  if (!Number.isFinite(Date.parse(input.refundedAt))) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'refund-order-required',
    search: "  if (!topUp) throw new AppError('WALLET_TOP_UP_NOT_FOUND', '未找到充值单', 404)\n",
    replacement:
      "  if (!topUp) throw new AppError('WALLET_TOP_UP_REFUND_STATE_INVALID', '充值单当前不可标记原路退款', 409)\n",
  },
]) {
  add({
    group: 'refund-guard',
    test: 'rejects unauthorized, malformed, missing, and invalid-state refund markers',
    ...mutation,
  })
}

add({
  group: 'refund-idempotency',
  id: 'refund-replay-number-match',
  search: '        if (current.originalRefundNumber !== refundNumber) {\n',
  replacement: '        if (false) {\n',
  test: 'makes one original refund number idempotent and rejects a conflicting number',
})
add({
  group: 'refund-guard',
  id: 'credited-refund-requires-ledger-reversal',
  search: '    if (hadWalletCredit) {\n',
  replacement: '    if (false) {\n',
  test: 'removes an unconsumed credited top-up when an original refund is confirmed',
})
add({
  group: 'refund-callpoint',
  id: 'refund-hold-callpoint',
  search: '        await holdWalletBalance(req, {\n',
  replacement: '        await Promise.resolve(); void ({\n',
  test: 'removes an unconsumed credited top-up when an original refund is confirmed',
})
add({
  group: 'refund-callpoint',
  id: 'refund-capture-callpoint',
  search: '      await captureWalletHold(req, refundLedgerKey)\n',
  replacement: '',
  test: 'removes an unconsumed credited top-up when an original refund is confirmed',
})
add({
  group: 'refund-guard',
  id: 'consumed-balance-rejected',
  search:
    "        if (error instanceof AppError && error.code === 'WALLET_BALANCE_INSUFFICIENT') {\n",
  replacement: '        if (false) {\n',
  test: 'rejects an unconditional original refund after the credited balance was consumed',
})
add({
  group: 'refund-callpoint',
  id: 'refunded-state-update-callpoint',
  search: '    const refunded = await db.execute(sql`\n',
  replacement: '    const refunded = { rows: [{ id: topUp.id }] }; void (sql`\n',
  test: 'removes an unconsumed credited top-up when an original refund is confirmed',
})

for (const mutation of [
  {
    id: 'collection-generic-mutations-denied',
    search:
      "  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },\n",
    replacement:
      "  access: { create: () => true, delete: () => true, read: ownOrSystem('customer'), update: () => true },\n",
    occurrence: 4,
    expectedOccurrences: 4,
    test: 'denies generic mutations and preserves top-up orders through hooks',
  },
  {
    id: 'collection-owner-scoped-read',
    search:
      "  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },\n",
    replacement: '  access: { create: deny, delete: deny, read: () => true, update: deny },\n',
    occurrence: 4,
    expectedOccurrences: 4,
    test: 'scopes reads to the owning customer and links existing evidence collections',
  },
  {
    id: 'collection-update-hook',
    search: "        if (operation === 'update') {\n",
    replacement: '        if (false) {\n',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'denies generic mutations and preserves top-up orders through hooks',
  },
  {
    id: 'collection-delete-hook',
    search: "        throw new AppError('WALLET_TOP_UP_APPEND_ONLY', '充值单不得删除', 409)\n",
    replacement: '        return\n',
    test: 'denies generic mutations and preserves top-up orders through hooks',
  },
]) {
  add({ group: 'collection', file: collectionFile, testFile: unitTest, ...mutation })
}

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
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.test}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-B-2 decision mutations matched: ${selectors.join(', ')}\n`)
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
        mutation.testFile,
        '-t',
        mutation.test,
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const behaviorFailure =
    output.includes('AssertionError:') ||
    (output.includes('FAIL ') && output.includes(mutation.test.split(':', 1)[0]))
  const failureLine =
    output.split('\n').find((line) => line.includes('AssertionError:')) ??
    output.split('\n').find((line) => line.includes('FAIL ')) ??
    ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.testFile} :: ${mutation.test}\n`)
  process.stdout.write(`RAW_FAILURE ${failureLine}\n`)
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

process.stdout.write(`\nD9B2_DECISION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
