import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integration = 'tests/integration/d9b5-admin-approvals-notifications.integration.test.ts'
const unit = 'tests/unit/d9b5-admin-approval-notification.test.ts'

const files = {
  adminAccount: 'src/services/auth/admin-account.ts',
  accountRecovery: 'src/services/auth/account-recovery.ts',
  accountState: 'src/services/auth/account-state.ts',
  approvals: 'src/services/admin/approvals.ts',
  collectionsAdministration: 'src/collections/administration.ts',
  collectionsNotifications: 'src/collections/notifications.ts',
  identities: 'src/services/auth/customer-identities.ts',
  outbox: 'src/services/notifications/outbox.ts',
  policy: 'src/services/admin/approval-policy.ts',
  schema: 'src/schemas/admin-approvals.ts',
}

const mutations = []
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })
const add = (file, group, id, predicate, test, edits, testFile = integration) =>
  mutations.push({ edits, file, group, id, predicate, test, testFile })

for (const [occurrence, id, test] of [
  [1, 'create-funds-scope', 'separates funds operations from system configuration'],
  [2, 'decision-funds-scope', 'enforces the funds scope independently'],
  [3, 'execution-funds-scope', 'enforces the funds scope independently'],
]) {
  add(files.approvals, 'role-callpoints', id, `${id} requires funds_operations`, test, [
    edit(
      '  const actor = adminActor(req)\n',
      '  const actor = req.user as { id: number | string }\n',
      { expectedOccurrences: 3, occurrence },
    ),
  ])
}
add(
  files.approvals,
  'role-callpoints',
  'approval-list-funds-scope',
  'approval list requires funds_operations',
  'enforces the funds scope independently',
  [edit('  adminActor(req)\n', '  void req.user\n')],
)
add(
  files.outbox,
  'role-callpoints',
  'delivery-list-funds-scope',
  'delivery list requires funds_operations',
  'enforces the funds scope independently',
  [edit("  if (!hasAdminOperationScope(req.user, 'funds_operations')) {\n", '  if (false) {\n')],
)
for (const [occurrence, id] of [
  [1, 'policy-read-system-scope'],
  [2, 'policy-update-system-scope'],
]) {
  add(
    files.policy,
    'role-callpoints',
    id,
    `${id} requires system_configuration`,
    'enforces the system-configuration scope independently',
    [
      edit(
        "  if (!hasAdminOperationScope(req.user, 'system_configuration')) {\n",
        '  if (false) {\n',
        { expectedOccurrences: 2, occurrence },
      ),
    ],
  )
}

for (const [id, search, replacement] of [
  [
    'admin-role-change-detection',
    '  const rolesChanged = hasChangedStringSet(data.roles, previous.roles)\n',
    '  const rolesChanged = false\n',
  ],
  [
    'admin-scope-change-detection',
    '  const operationalScopesChanged = hasChangedStringSet(\n    data.operationalScopes,\n    previous.operationalScopes,\n  )\n',
    '  const operationalScopesChanged = false\n',
  ],
]) {
  add(
    files.adminAccount,
    'role-callpoints',
    id,
    `${id} requires system_configuration`,
    'requires system-configuration scope for actual administrator role and scope changes',
    [edit(search, replacement)],
  )
}

for (const [occurrence, id, test] of [
  [1, 'persisted-cooldown-positive', 'persisted cooldown source is corrupted'],
  [2, 'updated-cooldown-positive', 'rejects a non-positive cooldown configuration'],
]) {
  add(
    files.schema,
    'cooldown',
    id,
    `${id} must be at least one second`,
    test,
    occurrence === 1
      ? [
          edit(
            'cooldownSeconds: z.number().int().min(1).max(604_800),',
            'cooldownSeconds: z.number().int().min(0).max(604_800),',
            { expectedOccurrences: 2, occurrence: 1 },
          ),
        ]
      : [
          edit(
            'cooldownSeconds: z.number().int().min(1).max(604_800),',
            'cooldownSeconds: z.number().int().min(0).max(604_800),',
            { expectedOccurrences: 2, occurrence: 1 },
          ),
          edit(
            'cooldownSeconds: z.number().int().min(1).max(604_800),',
            'cooldownSeconds: z.number().int().min(0).max(604_800),',
          ),
        ],
  )
}
add(
  files.approvals,
  'approval-decision',
  'different-approver-js',
  'the pre-read rejects initiator approval with the configured policy',
  'rejects initiator self-approval',
  [edit('      current.requiresDifferentApprover &&\n', '      false &&\n')],
)
add(
  files.approvals,
  'approval-decision',
  'different-approver-sql',
  'the authoritative decision CAS rechecks initiator identity',
  'rechecks different-approver identity in SQL',
  [edit('          requested_by_id <> ${actor.id} OR\n', '          TRUE OR\n')],
)
add(
  files.approvals,
  'approval-decision',
  'decision-request-id',
  'a decision changes only the requested row',
  'limits an approval decision to the exact request id',
  [edit('      WHERE id = ${requestId}\n', '      WHERE id > 0\n', { expectedOccurrences: 1 })],
)
add(
  files.approvals,
  'approval-decision',
  'decision-pending-state',
  'a decision consumes only pending approval state',
  'allows exactly one concurrent approval',
  [edit("        AND status = 'pending_approval'\n", '        AND TRUE\n')],
)
add(
  files.approvals,
  'approval-decision',
  'initiator-self-reject',
  'the initiator may reject without granting authority',
  'allows the initiator to reject',
  [edit("          ${input.decision} = 'reject'\n", '          FALSE\n')],
)

add(
  files.approvals,
  'execution-claim',
  'execution-request-id',
  'an execution claim changes only the requested row',
  'limits an execution claim to the exact request id',
  [
    edit('      WHERE id = ${input.requestId}\n', '      WHERE id > 0\n', {
      expectedOccurrences: 3,
      occurrence: 1,
    }),
  ],
)
add(
  files.approvals,
  'execution-claim',
  'execution-operation-type',
  'the claim binds the stored operation type to the caller expectation',
  'rejects a stored operation type being replaced',
  [edit('        AND operation_type = ${input.expectedOperationType}\n', '        AND TRUE\n')],
)
add(
  files.approvals,
  'execution-claim',
  'execution-approved-state',
  'an execution claim consumes only approved state',
  'allows exactly one concurrent approval and one concurrent execution',
  [edit("        AND status = 'approved'\n", '        AND TRUE\n')],
)
add(
  files.approvals,
  'execution-claim',
  'cooldown-clock-source',
  'cooldown eligibility is derived from the server-created request time',
  'uses request creation time rather than approval time',
  [edit('        AND created_at + cooldown_seconds', '        AND approved_at + cooldown_seconds')],
)
add(
  files.approvals,
  'execution-claim',
  'cooldown-eligibility',
  'execution is impossible until the cooldown expires',
  'allows self-approval only when configured',
  [
    edit(
      "        AND created_at + cooldown_seconds * INTERVAL '1 second' <= ${input.now.toISOString()}\n",
      '        AND TRUE\n',
    ),
  ],
)
add(
  files.approvals,
  'execution-snapshot',
  'snapshot-index-binding',
  'the indexed target and immutable operation snapshot cannot drift',
  'de-correlated target index disagrees',
  [edit('      assertStoredOperationBinding(claimed.approval)\n', '')],
)
add(
  files.approvals,
  'execution-finalize',
  'finalize-executing-state',
  'finalization rechecks the executing state',
  'revalidates the executing state',
  [
    edit("          AND status = 'executing'\n", '          AND TRUE\n', {
      expectedOccurrences: 2,
    }),
  ],
)
add(
  files.approvals,
  'execution-finalize',
  'finalize-claim-key',
  'finalization is bound to the exact claim key',
  'revalidates execution_claim_key',
  [
    edit('          AND execution_claim_key = ${claimed.claimKey}\n', '          AND TRUE\n', {
      expectedOccurrences: 2,
      occurrence: 1,
    }),
  ],
)
add(
  files.approvals,
  'execution-finalize',
  'finalize-actor',
  'finalization is bound to the claiming actor',
  'revalidates executed_by_id',
  [edit('          AND executed_by_id = ${actor.id}\n', '          AND TRUE\n')],
)

add(
  files.accountRecovery,
  'domain-bypass',
  'account-recovery-approval-context',
  'account recovery cannot bypass the approval execution context',
  'blocks direct account-recovery and identity-conflict decisions',
  [
    edit(
      '  if (req.context.adminApprovalExecution !== `account_recovery:${input.reviewId}`) {\n',
      '  if (false) {\n',
    ),
  ],
)
add(
  files.identities,
  'domain-bypass',
  'identity-conflict-approval-context',
  'identity conflict resolution cannot bypass approval',
  'blocks direct account-recovery and identity-conflict decisions',
  [
    edit(
      '  if (req.context.adminApprovalExecution !== `identity_conflict_resolution:${input.reviewId}`) {\n',
      '  if (false) {\n',
    ),
  ],
)
add(
  files.accountState,
  'domain-bypass',
  'unfreeze-approval-context',
  'high-risk admin unfreeze cannot bypass approval',
  'blocks direct admin unfreeze',
  [edit('    isAdminUnfreeze &&\n', '    false &&\n')],
)

add(
  files.approvals,
  'privacy',
  'approval-sensitive-payload',
  'operation snapshots reject embedded secrets and identifiers',
  'rejects sensitive or unknown operation payload fields',
  [
    edit(
      '  if (JSON.stringify(sanitized) !== JSON.stringify(operationData)) {\n',
      '  if (false) {\n',
    ),
  ],
)
add(
  files.approvals,
  'privacy',
  'approval-reason-sanitization',
  'approval reason snapshots are sanitized before persistence',
  'masks phone and document values',
  [
    edit(
      '  const reasonNote = String(sanitizeSensitiveData(input.reasonNote))\n',
      '  const reasonNote = input.reasonNote\n',
    ),
  ],
)
add(
  files.outbox,
  'privacy',
  'outbox-sensitive-content',
  'immutable message snapshots reject sensitive content',
  'rejects full phone and document values',
  [edit('  assertImmutableSafeContent(input.subject, input.body)\n', '')],
)

add(
  files.outbox,
  'outbox-targeting',
  'all-verified-channels',
  'every verified channel receives a high-risk security event',
  'targets every verified channel',
  [
    edit(
      '    for (const identity of identities) {\n',
      '    for (const identity of identities.slice(0, 1)) {\n',
    ),
  ],
)
add(
  files.outbox,
  'outbox-targeting',
  'no-channel-in-app',
  'a customer without an external identity receives an in-app delivery',
  'creates an in-app delivery when no verified external identity exists',
  [edit('    if (identities.length === 0) {\n', '    if (false) {\n')],
)
add(
  files.outbox,
  'delivery-claim',
  'claim-status-cas',
  'concurrent workers cannot reclaim a sending delivery',
  'rechecks claimable status atomically',
  [edit("        AND status IN ('pending', 'retry_pending', 'sent')\n", '        AND TRUE\n')],
)
add(
  files.outbox,
  'delivery-claim',
  'claim-due-cas',
  'claim CAS rechecks the authoritative due timestamp',
  'rechecks the due timestamp atomically',
  [edit('        AND next_attempt_at <= ${now.toISOString()}\n', '        AND TRUE\n')],
)
add(
  files.outbox,
  'delivery-finalize',
  'delivery-attempt-binding',
  'delivery finalization is bound to the claimed attempt',
  'binds delivery finalization to the exact claimed attempt fact',
  [edit('        AND attempt_count = ${delivery.attemptCount}\n', '        AND TRUE\n')],
)
add(
  files.outbox,
  'delivery-finalize',
  'delivery-claim-time-binding',
  'delivery finalization is bound to the exact claim timestamp',
  'binds delivery finalization to the exact claim timestamp fact',
  [edit('        AND claimed_at = ${delivery.claimedAt}\n', '        AND TRUE\n')],
)
add(
  files.outbox,
  'delivery-retry',
  'retry-known-only',
  'only an explicitly retryable known failure may retry',
  'never retries a known non-retryable external failure',
  [edit('      input.retryableKnown === true &&\n', '      true &&\n')],
)
add(
  files.outbox,
  'delivery-retry',
  'unknown-outcome-source',
  'an upstream status-unknown failure is recorded as unknown',
  'never retries an external failure whose upstream status is unknown',
  [
    edit(
      "        outcome: sent.error.statusKnown ? 'failed' : 'unknown',\n",
      "        outcome: 'failed',\n",
    ),
  ],
)
add(
  files.outbox,
  'delivery-retry',
  'retry-attempt-limit',
  'a failed delivery stops retrying at maxAttempts',
  'retries known SMS failures, dead-letters at the limit',
  [edit('      delivery.attemptCount < delivery.maxAttempts\n', '      true\n')],
)
add(
  files.outbox,
  'delivery-retry',
  'receipt-poll-limit',
  'an indefinitely pending receipt eventually enters DLQ',
  'dead-letters an indefinitely pending provider receipt',
  [edit('      delivery.attemptCount >= delivery.maxAttempts\n', '      false\n')],
)
add(
  files.outbox,
  'delivery-retry',
  'interrupted-send-no-replay',
  'an interrupted external send is not blindly replayed',
  'dead-letters an interrupted sending lease',
  [edit('    if (wasStale) {\n', '    if (false) {\n')],
)
add(
  files.outbox,
  'delivery-receipt',
  'receipt-sent-at-source',
  'receipt queries use the immutable provider-accepted timestamp',
  'queries SMS receipts with the immutable accepted-at fact',
  [
    edit(
      '        sentAt: await providerSentAt(req, delivery.id),\n',
      '        sentAt: now.toISOString(),\n',
    ),
  ],
)

add(
  files.outbox,
  'preferences',
  'transactional-unsubscribe',
  'transactional notification preferences are structurally rejected',
  'structurally forbids transactional unsubscribe',
  [edit("  if (input.category !== 'marketing') {\n", '  if (false) {\n')],
)
add(
  files.outbox,
  'preferences',
  'marketing-type-allowlist',
  'only marketing notification types can enter preference storage',
  'structurally forbids transactional unsubscribe',
  [
    edit(
      "  if (!['product_updates', 'promotions'].includes(input.notificationType)) {\n",
      '  if (false) {\n',
    ),
  ],
)
for (const [occurrence, id] of [
  [1, 'preference-customer-auth'],
  [2, 'notification-list-customer-auth'],
  [3, 'notification-read-customer-auth'],
]) {
  add(
    files.outbox,
    'customer-auth-callpoints',
    id,
    `${id} requires an authenticated customer`,
    'requires the authenticated customer at every notification preference',
    [
      edit('  if (!isCustomerUser(req.user)) {\n', '  if (false) {\n', {
        expectedOccurrences: 3,
        occurrence,
      }),
    ],
  )
}

add(
  files.collectionsAdministration,
  'append-only',
  'approval-service-context',
  'approval rows require the service context',
  'requires the approval service context',
  [edit('  if (!approvalContext(context)) {\n', '  if (false) {\n')],
  unit,
)
for (const [file, id, search] of [
  [
    files.collectionsAdministration,
    'admin-access-append-only',
    "  hooks: appendOnly('ADMIN_ACCESS_EVENT_APPEND_ONLY', '管理员访问事件只允许追加'),\n",
  ],
  [
    files.collectionsNotifications,
    'outbox-append-only',
    "  hooks: appendOnly('NOTIFICATION_OUTBOX_APPEND_ONLY', '通知正文快照只允许追加'),\n",
  ],
  [
    files.collectionsNotifications,
    'receipt-append-only',
    "  hooks: appendOnly('NOTIFICATION_RECEIPT_APPEND_ONLY', '通知 provider 回执只允许追加'),\n",
  ],
  [
    files.collectionsNotifications,
    'read-state-append-only',
    "  hooks: appendOnly('NOTIFICATION_READ_STATE_APPEND_ONLY', '通知已读状态只允许追加'),\n",
  ],
]) {
  add(
    file,
    'append-only',
    id,
    `${id} rejects updates and deletes`,
    'keeps',
    [edit(search, '  hooks: {},\n')],
    unit,
  )
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
  process.stderr.write(`No D9-B-5 mutations matched: ${selectors.join(', ')}\n`)
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
          ALLOW_REAL_ALIYUN_SMS: 'false',
          ALLOW_REAL_WECHAT_OFFICIAL: 'false',
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
  `\nD9B5_DECISION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
