import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integration = 'tests/integration/d9b4-wallet-funds-policy.integration.test.ts'
const topUpIntegration = 'tests/integration/d9b2-wallet-top-ups.integration.test.ts'
const unit = 'tests/unit/d9b4-wallet-funds-policy.test.ts'
const renewal = 'tests/integration/d9c2-automatic-renewals.integration.test.ts'

const files = {
  automatic: 'src/services/domains/automatic-renewals.ts',
  balance: 'src/services/commerce/balance-payments.ts',
  collectionsCommerce: 'src/collections/commerce.ts',
  collectionsWallet: 'src/collections/wallet.ts',
  funds: 'src/services/wallet/fund-scenarios.ts',
  ledger: 'src/services/wallet/ledger.ts',
  policy: 'src/services/wallet/policy.ts',
  refunds: 'src/services/commerce/refunds.ts',
  schema: 'src/schemas/wallet-policy.ts',
  statements: 'src/services/wallet/statements.ts',
  topUps: 'src/services/wallet/top-ups.ts',
}

const mutations = []
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })
const add = (file, group, id, predicate, testFile, test, edits) =>
  mutations.push({ edits, file, group, id, predicate, test, testFile })

const fixedPolicyTest = 'rejects unsupported fixed policy value'
for (const [id, field, constant, replacement] of [
  ['policy-currency-literal', 'currency', 'WALLET_POLICY_CURRENCY', 'z.string()'],
  [
    'policy-expiration-literal',
    'balanceExpiration',
    'WALLET_POLICY_BALANCE_EXPIRATION',
    'z.string()',
  ],
  [
    'policy-timezone-literal',
    'financialDayCutTimezone',
    'WALLET_POLICY_FINANCIAL_TIMEZONE',
    'z.string()',
  ],
  [
    'policy-calculation-literal',
    'statementCalculation',
    'WALLET_POLICY_STATEMENT_CALCULATION',
    'z.string()',
  ],
]) {
  add(files.schema, 'policy-schema', id, `${field} remains fixed in P1`, unit, fixedPolicyTest, [
    edit(`${field}: z.literal(${constant}),`, `${field}: ${replacement},`, {
      expectedOccurrences: 2,
      occurrence: 2,
    }),
  ])
}
for (const [id, field, constant] of [
  ['persisted-policy-currency-literal', 'currency', 'WALLET_POLICY_CURRENCY'],
  ['persisted-policy-expiration-literal', 'balanceExpiration', 'WALLET_POLICY_BALANCE_EXPIRATION'],
  [
    'persisted-policy-timezone-literal',
    'financialDayCutTimezone',
    'WALLET_POLICY_FINANCIAL_TIMEZONE',
  ],
  [
    'persisted-policy-calculation-literal',
    'statementCalculation',
    'WALLET_POLICY_STATEMENT_CALCULATION',
  ],
]) {
  add(
    files.schema,
    'policy-schema-callpoints',
    id,
    `${field} is fixed when persisted policy is loaded`,
    unit,
    'rejects corrupted persisted policy value',
    [
      edit(`${field}: z.literal(${constant}),`, `${field}: z.string(),`, {
        expectedOccurrences: 2,
        occurrence: 1,
      }),
    ],
  )
}
add(
  files.schema,
  'policy-schema-callpoints',
  'persisted-schema-version-literal',
  'persisted policy schema version remains one',
  unit,
  'rejects corrupted persisted policy value',
  [edit('    schemaVersion: z.literal(1),\n', '    schemaVersion: z.number(),\n')],
)

add(
  files.schema,
  'policy-schema-callpoints',
  'persisted-accountBalanceLimitFen-integer',
  'persisted accountBalanceLimitFen is an integer fen value',
  unit,
  'validates persisted amount field accountBalanceLimitFen',
  [
    edit('persistedAccountLimitFen', 'z.number()', {
      expectedOccurrences: 2,
      occurrence: 2,
    }),
  ],
)
for (const [field, persistedOccurrence, updateOccurrence] of [
  ['singleSpendLimitFen', 2, 5],
  ['singleTopUpLimitFen', 3, 6],
]) {
  for (const [suffix, replacement, predicate] of [
    ['integer', 'z.number().positive()', 'is an integer fen value'],
    ['positive', 'z.number().int()', 'is positive'],
  ]) {
    add(
      files.schema,
      'policy-schema-callpoints',
      `persisted-${field}-${suffix}`,
      `persisted ${field} ${predicate}`,
      unit,
      `validates persisted amount field ${field}`,
      [
        edit('positiveFen', replacement, {
          expectedOccurrences: 6,
          occurrence: persistedOccurrence,
        }),
      ],
    )
    add(
      files.schema,
      'policy-schema-callpoints',
      `update-${field}-${suffix}`,
      `policy update ${field} ${predicate}`,
      unit,
      `validates policy update amount field ${field}`,
      [
        edit('positiveFen', replacement, {
          expectedOccurrences: 6,
          occurrence: updateOccurrence,
        }),
      ],
    )
  }
}
for (const [suffix, replacement, predicate] of [
  ['integer', 'z.number().positive()', 'is an integer fen value'],
  ['positive', 'z.number().int()', 'is positive'],
]) {
  add(
    files.schema,
    'policy-schema-callpoints',
    `update-accountBalanceLimitFen-${suffix}`,
    `policy update accountBalanceLimitFen ${predicate}`,
    unit,
    'validates policy update amount field accountBalanceLimitFen',
    [
      edit('positiveFen', replacement, {
        expectedOccurrences: 6,
        occurrence: 4,
      }),
    ],
  )
}

for (const [id, search, replacement] of [
  [
    'persisted-version-integer',
    '    version: z.number().int().positive(),\n',
    '    version: z.number().positive(),\n',
  ],
  [
    'persisted-version-positive',
    '    version: z.number().int().positive(),\n',
    '    version: z.number().int(),\n',
  ],
  [
    'expected-version-integer',
    '  expectedVersion: z.number().int().positive(),\n',
    '  expectedVersion: z.number().positive(),\n',
  ],
  [
    'expected-version-positive',
    '  expectedVersion: z.number().int().positive(),\n',
    '  expectedVersion: z.number().int(),\n',
  ],
]) {
  add(
    files.schema,
    'policy-schema-callpoints',
    id,
    id.replaceAll('-', ' '),
    unit,
    'validates persisted and expected policy versions independently',
    [edit(search, replacement)],
  )
}

for (const [id, search, replacement] of [
  [
    'change-note-minimum',
    '  changeNote: z.string().trim().min(8).max(500),\n',
    '  changeNote: z.string().trim().max(500),\n',
  ],
  [
    'change-note-maximum',
    '  changeNote: z.string().trim().min(8).max(500),\n',
    '  changeNote: z.string().trim().min(8),\n',
  ],
]) {
  add(
    files.schema,
    'policy-schema-callpoints',
    id,
    id.replaceAll('-', ' '),
    unit,
    'requires bounded policy notes and boolean switches',
    [edit(search, replacement)],
  )
}
for (const [field, occurrence, callpoint] of [
  ['allowNegativeBalanceRecovery', 1, 'persisted'],
  ['allowNegativeBalanceRecovery', 2, 'update'],
  ['allowRestrictedAccountEmergencyRenewal', 1, 'persisted'],
  ['allowRestrictedAccountEmergencyRenewal', 2, 'update'],
]) {
  add(
    files.schema,
    'policy-schema-callpoints',
    `${callpoint}-${field}-boolean`,
    `${callpoint} ${field} remains boolean`,
    unit,
    'requires bounded policy notes and boolean switches',
    [
      edit(`${field}: z.boolean(),`, `${field}: z.any(),`, {
        expectedOccurrences: 2,
        occurrence,
      }),
    ],
  )
}
add(
  files.schema,
  'policy-schema',
  'top-up-account-limit-coupling',
  'single top-up maximum cannot exceed the account maximum',
  unit,
  'rejects a top-up maximum above',
  [
    edit(
      '    if (value.singleTopUpLimitFen > value.accountBalanceLimitFen) {\n',
      '    if (false) {\n',
    ),
  ],
)
add(
  files.schema,
  'policy-schema',
  'spend-account-limit-coupling',
  'single spend maximum cannot exceed the account maximum',
  unit,
  'rejects a spend maximum above',
  [
    edit(
      '    if (value.singleSpendLimitFen > value.accountBalanceLimitFen) {\n',
      '    if (false) {\n',
    ),
  ],
)
add(
  files.collectionsWallet,
  'append-only',
  'policy-update-append-only',
  'policy versions reject update even with override access',
  unit,
  'makes policy versions append-only',
  [
    edit("        if (operation === 'update') {\n", '        if (false) {\n', {
      expectedOccurrences: 3,
      occurrence: 3,
    }),
  ],
)
add(
  files.collectionsWallet,
  'append-only',
  'policy-delete-append-only',
  'policy versions reject deletion even with override access',
  unit,
  'makes policy versions append-only',
  [
    edit(
      "      () => {\n        throw new AppError('WALLET_POLICY_APPEND_ONLY', '钱包资金规则版本不得删除', 409)\n      },\n",
      '      () => undefined,\n',
    ),
  ],
)
add(
  files.collectionsCommerce,
  'refund-target',
  'refund-exactly-one-target-hook',
  'refund facts target exactly one order kind',
  unit,
  'requires every refund fact to target exactly one order kind',
  [edit('        if (Boolean(order) === Boolean(walletTopUpOrder)) {\n', '        if (false) {\n')],
)
add(
  files.topUps,
  'top-up-refund-coupling',
  'top-up-original-refund-frozen-amount',
  'the B-2 original-refund claim binds its refund amount to the frozen top-up amount',
  topUpIntegration,
  'makes one original refund number idempotent and rejects a conflicting number',
  [edit('        refunded_amount_fen = amount_fen,\n', '')],
)

add(
  files.policy,
  'policy-admin',
  'policy-system-admin',
  'only an active system administrator can change policy',
  integration,
  'requires an active system administrator',
  [
    edit(
      '  const actor = assertSystemAdmin(req)\n',
      "  const actor = { id: 'mutation-administrator' }\n",
    ),
  ],
)
add(
  files.policy,
  'policy-cas',
  'policy-head-expected-version',
  'the policy head is claimed only from the expected version',
  integration,
  'versions policy updates with a head CAS',
  [edit('        AND current_version = ${current.version}\n', '')],
)
add(
  files.policy,
  'policy-cas',
  'policy-head-returning',
  'zero claimed policy-head rows are rejected',
  integration,
  'versions policy updates with a head CAS',
  [edit('    if (claimed.rows?.[0]?.singleton_key === undefined) {\n', '    if (false) {\n')],
)
add(
  files.policy,
  'policy-audit',
  'policy-change-audit-callpoint',
  'every committed policy version records an audit event',
  integration,
  'versions policy updates with a head CAS',
  [
    edit(
      "    await recordAuditEvent(req, {\n      action: 'wallet.policy.updated',\n",
      "    void ({\n      action: 'wallet.policy.updated',\n",
    ),
  ],
)
for (const [id, search, predicate] of [
  ['runtime-currency', "  if (currency !== 'CNY') {\n", 'runtime funds operations reject non-CNY'],
  [
    'runtime-single-top-up',
    '  if (amountFen > BigInt(policy.singleTopUpLimitFen)) {\n',
    'the runtime top-up guard uses the top-up maximum',
  ],
  [
    'runtime-single-spend',
    '  if (amountFen > BigInt(policy.singleSpendLimitFen)) {\n',
    'the runtime spend guard uses the distinct spend maximum',
  ],
  [
    'runtime-account-balance',
    '  if (postedBalanceFen + incomingAmountFen > BigInt(policy.accountBalanceLimitFen)) {\n',
    'the runtime account cap includes the incoming amount',
  ],
]) {
  add(files.policy, 'runtime-limits', id, predicate, unit, 'kills each runtime amount', [
    edit(search, '  if (false) {\n'),
  ])
}

add(
  files.topUps,
  'top-up-callpoints',
  'top-up-currency-callpoint',
  'top-up creation invokes the CNY guard at its own callpoint',
  integration,
  'rejects non-CNY, single top-up',
  [edit("  assertWalletCurrency(input.currency ?? 'CNY')\n", '')],
)
add(
  files.topUps,
  'top-up-callpoints',
  'top-up-single-limit-callpoint',
  'top-up creation invokes the single top-up maximum',
  integration,
  'rejects non-CNY, single top-up',
  [edit('    assertSingleTopUpLimit(policy, amount)\n', '')],
)
add(
  files.topUps,
  'top-up-callpoints',
  'top-up-account-limit-callpoint',
  'top-up creation invokes the account balance maximum',
  integration,
  'rejects non-CNY, single top-up',
  [edit('    assertAccountBalanceLimit(policy, balance.postedBalance, amount)\n', '')],
)
add(
  files.topUps,
  'top-up-callpoints',
  'top-up-confirmation-account-cap-source',
  'paid top-up confirmation passes the configured account cap to B-1 credit',
  integration,
  'rechecks the account-balance limit when a paid top-up is confirmed',
  [edit('      maximumPostedBalanceFen: policy.accountBalanceLimitFen,\n', '')],
)
add(
  files.balance,
  'spend-callpoints',
  'balance-payment-spend-limit-callpoint',
  'balance payment invokes the distinct single-spend maximum',
  integration,
  'rejects non-CNY, single top-up',
  [edit('    assertSingleSpendLimit(policy, orderAmountFen(order))\n', '')],
)
add(
  files.ledger,
  'ledger-limits',
  'credit-account-cap',
  'B-1 credit rejects a posted balance above the supplied maximum',
  integration,
  'rejects non-CNY, single top-up',
  [edit('      account.postedBalance + amount > maximumPostedBalance\n', '      false\n')],
)
add(
  files.ledger,
  'ledger-recovery',
  'negative-recovery-policy-switch',
  'B-1 recovery cannot cross zero when the policy switch is disabled',
  integration,
  'honors the negative-recovery policy switch',
  [
    edit(
      '    if (!input.allowNegativeBalance && amount > account.availableBalance) {\n',
      '    if (false) {\n',
    ),
  ],
)
add(
  files.ledger,
  'ledger-recovery',
  'recovery-derived-posted-sign',
  'recovery is negative in the derived posted balance',
  integration,
  'recovers a consumed disputed top-up',
  [
    edit(
      "          WHEN entry_type IN ('capture', 'recovery') THEN -amount_fen\n",
      "          WHEN entry_type = 'capture' THEN -amount_fen\n",
    ),
  ],
)
add(
  files.ledger,
  'ledger-recovery',
  'recovery-posted-subtraction',
  'recovery subtracts the frozen top-up amount from posted balance',
  integration,
  'recovers a consumed disputed top-up',
  [
    edit(
      '    const postedBalance = account.postedBalance - amount\n',
      '    const postedBalance = account.postedBalance + amount\n',
    ),
  ],
)
add(
  files.ledger,
  'ledger-ordinary-spend',
  'ordinary-reservation-available-predicate',
  'ordinary holds use an atomic available-balance predicate',
  integration,
  'never lets ordinary concurrent deductions',
  [edit('      AND ${delta.toString()} <= (\n', '      AND 0 <= (\n')],
)

const creditFactTest =
  'revalidates payment-recovery evidence against the independent B-1 credit fact'
for (const [id, search, replacement, predicate] of [
  [
    'credit-fact-type',
    "    transaction.type !== 'credit' ||\n",
    '',
    'the referenced B-1 transaction is a credit',
  ],
  [
    'credit-fact-status',
    "    transaction.status !== 'posted' ||\n",
    '',
    'the referenced B-1 credit is posted',
  ],
  [
    'credit-fact-account-source',
    "    String(typeof account === 'object' ? account.id : account) !== String(input.accountId) ||\n",
    '',
    'the B-1 credit account comes from the top-up account fact',
  ],
  [
    'credit-fact-customer-source',
    "    String(typeof customer === 'object' ? customer.id : customer) !== String(input.customerId) ||\n",
    '',
    'the B-1 credit customer comes from the top-up customer fact',
  ],
  [
    'credit-fact-safe-amount',
    '    !Number.isSafeInteger(transaction.amountFen) ||\n',
    '',
    'the B-1 credit amount is a safe integer number of fen',
  ],
  [
    'credit-fact-amount-source',
    '    BigInt(transaction.amountFen) !== amount\n',
    '    false\n',
    'the top-up frozen amount equals the independent B-1 credit amount',
  ],
]) {
  add(files.ledger, 'credit-fact-source', id, predicate, integration, creditFactTest, [
    edit(search, replacement),
  ])
}

for (let occurrence = 1; occurrence <= 4; occurrence += 1) {
  add(
    files.funds,
    'scenario-boundaries',
    `scenario-system-boundary-${occurrence}`,
    `funds scenario callpoint ${occurrence} rejects an authenticated caller`,
    integration,
    'rejects customer-authenticated callers at every funds-scenario system boundary',
    [edit('  assertSystem(req)\n', '', { expectedOccurrences: 4, occurrence })],
  )
}
add(
  files.refunds,
  'scenario-boundaries',
  'top-up-refund-system-boundary',
  'the shared top-up refund entrypoint is system-only',
  integration,
  'rejects customer-authenticated callers at every funds-scenario system boundary',
  [edit('  assertSystemRefundRequest(req)\n', '')],
)

const duplicateSourceTest = 'reads every duplicate-top-up evidence field independently'
for (const [id, search, replacement, predicate] of [
  [
    'duplicate-distinct-order',
    '  if (String(original.id) === String(duplicate.id)) {\n',
    '  if (false) {\n',
    'the original and duplicate top-ups are distinct rows',
  ],
  [
    'duplicate-customer-source',
    '    String(relationId(original.customer)) !== String(relationId(duplicate.customer)) ||\n',
    '',
    'duplicate ownership is read from both customer facts',
  ],
  [
    'duplicate-account-source',
    '    String(relationId(original.account)) !== String(relationId(duplicate.account)) ||\n',
    '',
    'duplicate ownership is read from both account facts',
  ],
  [
    'duplicate-original-currency-source',
    "    original.currency !== 'CNY' ||\n",
    '',
    'the original currency is independently CNY',
  ],
  [
    'duplicate-copy-currency-source',
    "    duplicate.currency !== 'CNY' ||\n",
    '',
    'the duplicate currency is independently CNY',
  ],
  [
    'duplicate-amount-source',
    '    original.amountFen !== duplicate.amountFen ||\n',
    '',
    'both frozen top-up amounts match independently',
  ],
  [
    'duplicate-original-status-source',
    "    original.status !== 'credited' ||\n",
    '',
    'the original top-up is independently credited',
  ],
  [
    'duplicate-copy-status-source',
    "    duplicate.status !== 'credited' ||\n",
    '',
    'the duplicate top-up is independently credited',
  ],
  [
    'duplicate-original-transaction-source',
    '    !original.wechatTransactionId ||\n',
    '',
    'the original has its own WeChat transaction fact',
  ],
  [
    'duplicate-copy-transaction-source',
    '    !duplicate.wechatTransactionId ||\n',
    '',
    'the duplicate has its own WeChat transaction fact',
  ],
  [
    'duplicate-distinct-transaction-source',
    '    original.wechatTransactionId === duplicate.wechatTransactionId\n',
    '    false\n',
    'the two top-ups use distinct WeChat transactions',
  ],
]) {
  add(files.funds, 'duplicate-source', id, predicate, integration, duplicateSourceTest, [
    edit(search, replacement),
  ])
}
add(
  files.funds,
  'duplicate-refund',
  'duplicate-refund-frozen-amount',
  'the duplicate refund amount comes from the duplicate frozen amount',
  integration,
  'refunds a duplicate top-up once',
  [
    edit('    amountFen: duplicate.amountFen,\n', '    amountFen: duplicate.amountFen + 1,\n', {
      expectedOccurrences: 2,
      occurrence: 2,
    }),
  ],
)
add(
  files.refunds,
  'duplicate-refund',
  'top-up-refund-amount-ceiling',
  'a top-up original refund cannot exceed its immutable frozen amount',
  integration,
  'refuses a top-up original refund amount above',
  [edit('      amount > BigInt(topUp.amountFen)\n', '      false\n')],
)

add(
  files.funds,
  'service-refund',
  'service-refund-dispatch-callpoint',
  'no-service handling reuses automatic refund dispatch',
  integration,
  'routes no-service refunds only from paymentChannel',
  [
    edit(
      '  return requestAutomaticRegistrationFailureRefund(req, {\n',
      '  return requestWalletTopUpOriginalRefund(req, {\n',
    ),
  ],
)

add(
  files.funds,
  'closure-refund',
  'closure-active-request-predicate',
  'closure balance refunds require the exact active A6 request key',
  integration,
  'blocks closure on positive balance',
  [edit('        AND active_account_closure_request_key = ${input.requestId}\n', '')],
)
add(
  files.funds,
  'closure-refund',
  'closure-positive-balance-branch',
  'only a non-positive available balance returns without refunds',
  integration,
  'blocks closure on positive balance',
  [
    edit(
      "    if (balance.availableBalance <= 0n) return { refunds: [], totalAmountFen: '0' }\n",
      "    if (balance.availableBalance > 0n) return { refunds: [], totalAmountFen: '0' }\n",
    ),
  ],
)
add(
  files.funds,
  'closure-refund',
  'closure-partial-source-amount',
  'closure refunds only the currently unconsumed amount of a larger top-up',
  integration,
  'blocks closure on positive balance',
  [
    edit(
      '      const amount = remaining < BigInt(topUp.amountFen) ? remaining : BigInt(topUp.amountFen)\n',
      '      const amount = BigInt(topUp.amountFen)\n',
    ),
  ],
)

const recoverySourceTest =
  'revalidates payment-recovery evidence against the independent B-1 credit fact'
for (const [id, search, replacement, predicate] of [
  [
    'recovery-currency-source',
    "      topUp.currency !== 'CNY' ||\n",
    '',
    'recovery reads CNY from the top-up fact',
  ],
  [
    'recovery-safe-amount-source',
    '      !Number.isSafeInteger(topUp.amountFen) ||\n',
    '',
    'recovery reads a safe integer frozen amount',
  ],
  [
    'recovery-positive-amount-source',
    '      topUp.amountFen <= 0 ||\n',
    '',
    'recovery requires a positive frozen amount',
  ],
  [
    'recovery-credited-at-source',
    '      !topUp.creditedAt ||\n',
    '',
    'recovery requires the credited timestamp fact',
  ],
  [
    'recovery-paid-at-source',
    '      !topUp.providerPaidAt ||\n',
    '',
    'recovery requires the provider-paid timestamp fact',
  ],
  [
    'recovery-wechat-source',
    '      !topUp.wechatTransactionId\n',
    '      false\n',
    'recovery requires the WeChat transaction fact',
  ],
]) {
  add(files.funds, 'recovery-source', id, predicate, integration, recoverySourceTest, [
    edit(search, replacement, {
      expectedOccurrences: id.includes('safe-amount') || id.includes('currency-source') ? 2 : 1,
      occurrence: id.includes('safe-amount') || id.includes('currency-source') ? 2 : 1,
    }),
  ])
}
add(
  files.funds,
  'recovery-source',
  'recovery-credit-fact-callpoint',
  'payment recovery invokes B-1 credit-fact verification at its own callpoint',
  integration,
  recoverySourceTest,
  [
    edit(
      '    await assertPostedWalletCredit(req, {\n      accountId: relationId(topUp.account),\n',
      '    void ({\n      accountId: relationId(topUp.account),\n',
    ),
  ],
)
add(
  files.funds,
  'recovery-restriction',
  'negative-balance-restriction-branch',
  'a negative recovered balance immediately enters the A3 restriction path',
  integration,
  'recovers a consumed disputed top-up',
  [edit('    if (restricted) {\n', '    if (false) {\n')],
)
add(
  files.funds,
  'recovery-restriction',
  'balance-spend-disabled-value',
  'the A3 restriction is exactly balance_spend_disabled',
  integration,
  'recovers a consumed disputed top-up',
  [edit("    'balance_spend_disabled',\n", "    'purchase_disabled',\n")],
)
add(
  files.funds,
  'recovery-cas',
  'recovery-claim-status-predicate',
  'payment recovery claims only a credited top-up',
  integration,
  'rejects a zero-row payment-recovery claim',
  [edit("        AND status = 'credited'\n", '')],
)
add(
  files.funds,
  'recovery-cas',
  'recovery-claim-returning',
  'zero payment-recovery claim rows are rejected',
  integration,
  'rejects a zero-row payment-recovery claim',
  [edit('    if (claimed.rows?.[0]?.id === undefined) {\n', '    if (false) {\n')],
)
add(
  files.funds,
  'recovery-cas',
  'recovery-final-key-predicate',
  'recovery finalization is bound to the exact recovery key',
  integration,
  'binds payment-recovery finalization',
  [edit('        AND payment_recovery_key = ${recoveryKey}\n', '')],
)
add(
  files.funds,
  'recovery-audit',
  'recovery-audit-callpoint',
  'each committed payment recovery records an audit event',
  integration,
  'recovers a consumed disputed top-up',
  [
    edit(
      "    await recordAuditEvent(req, {\n      action: 'wallet.top_up.payment_recovered',\n",
      "    void ({\n      action: 'wallet.top_up.payment_recovered',\n",
    ),
  ],
)

add(
  files.automatic,
  'emergency-renewal',
  'emergency-policy-switch',
  'emergency renewal is controlled by the persisted switch',
  renewal,
  'balance-spend restriction is re-read independently',
  [edit('    policy.allowRestrictedAccountEmergencyRenewal &&\n', '    true &&\n')],
)
add(
  files.automatic,
  'emergency-renewal',
  'emergency-sole-restriction-count',
  'emergency renewal permits exactly one restriction',
  renewal,
  'allows emergency renewal only when policy is enabled',
  [edit('    restrictions.length === 1 &&\n', '    restrictions.length >= 1 &&\n')],
)
add(
  files.automatic,
  'emergency-renewal',
  'emergency-restriction-source',
  'emergency renewal reads balance_spend_disabled from A3',
  renewal,
  'allows emergency renewal only when policy is enabled',
  [
    edit(
      "    restrictions[0] === 'balance_spend_disabled'\n",
      "    restrictions[0] === 'purchase_disabled'\n",
    ),
  ],
)

add(
  files.statements,
  'statement-boundary',
  'statement-customer-auth',
  'statement export requires an authenticated customer',
  integration,
  'exports opening and closing balances',
  [edit('  if (!isCustomerUser(req.user))\n', '  if (false)\n')],
)
add(
  files.statements,
  'statement-boundary',
  'statement-shanghai-offset',
  'statement day boundaries are fixed at UTC+08:00',
  integration,
  'exports opening and closing balances',
  [
    edit(
      '  const date = new Date(`${localDate}T00:00:00+08:00`)\n',
      '  const date = new Date(`${localDate}T00:00:00Z`)\n',
    ),
  ],
)
add(
  files.statements,
  'statement-boundary',
  'statement-period-maximum',
  'one statement export is limited to 366 Shanghai days',
  integration,
  'exports opening and closing balances',
  [
    edit(
      '  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1_000) {\n',
      '  if (false) {\n',
    ),
  ],
)
add(
  files.statements,
  'statement-ledger',
  'statement-account-scope',
  'statement entries are scoped to the authenticated customer account',
  integration,
  'exports opening and closing balances',
  [edit('      WHERE account_id = ${accountId}\n', '      WHERE account_id IS NOT NULL\n')],
)
for (const [id, search, replacement, predicate] of [
  [
    'statement-sequence-integrity',
    "    if (sequence !== BigInt(index + 1)) throw unavailable('钱包账本序列不连续')\n",
    '',
    'statement export checks every ledger sequence',
  ],
  [
    'statement-snapshot-integrity',
    '      integer(row.posted_balance_after_fen) !== posted ||\n',
    '      false ||\n',
    'statement export verifies posted snapshots',
  ],
  [
    'statement-version-integrity',
    "  if (BigInt(rows.length) !== ledgerVersion) throw unavailable('钱包账本版本不一致')\n",
    '',
    'statement export binds entry count to ledger version',
  ],
]) {
  add(
    files.statements,
    'statement-ledger',
    id,
    predicate,
    integration,
    'fails statement export closed',
    [edit(search, replacement)],
  )
}
add(
  files.statements,
  'statement-boundary',
  'statement-start-inclusive',
  'period entries include the Shanghai start boundary',
  integration,
  'exports opening and closing balances',
  [
    edit(
      '      return timestamp >= start.getTime() && timestamp < end.getTime()\n',
      '      return timestamp > start.getTime() && timestamp < end.getTime()\n',
    ),
  ],
)
add(
  files.statements,
  'statement-audit',
  'statement-export-audit-callpoint',
  'each successful statement export records a scoped audit event',
  integration,
  'exports opening and closing balances',
  [
    edit(
      "    await recordAuditEvent(req, {\n      action: 'wallet.statement.exported',\n",
      "    void ({\n      action: 'wallet.statement.exported',\n",
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
      `${mutation.group}/${mutation.id}\t${mutation.predicate}\t${mutation.testFile} :: ${mutation.test}\n`,
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
  process.stderr.write(`No D9-B-4 mutations matched: ${selectors.join(', ')}\n`)
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
        mutation.testFile,
        '-t',
        mutation.test,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_REAL_WECHATPAY: 'false',
          ALLOW_REAL_WECHATPAY_PAYMENTS: 'false',
          ALLOW_REAL_WECHATPAY_REFUNDS: 'false',
          ALLOW_REAL_WECHATPAY_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_READS: 'false',
          ALLOW_REAL_WESTDIGITAL_WRITES: 'false',
        },
      },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(
    `\nMUTATION ${mutation.group}/${mutation.id}\nPREDICATE ${mutation.predicate}\nTEST ${mutation.testFile} :: ${mutation.test}\nRAW_FAILURE ${failure}\n`,
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
  `\nD9B4_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
