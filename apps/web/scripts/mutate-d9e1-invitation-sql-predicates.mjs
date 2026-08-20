import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const testFile = 'tests/integration/d9e1-invitations.integration.test.ts'
const files = {
  binding: 'src/services/invitations/binding.ts',
  ledger: 'src/services/points/ledger.ts',
  rewards: 'src/services/invitations/rewards.ts',
}
const mutations = []
const add = (mutation) => mutations.push(mutation)

function occurrences(source, search) {
  return source.split(search).length - 1
}

function replaceOccurrence(source, search, replacement, occurrence = 1) {
  let seen = 0
  return source.replaceAll(search, (match) => {
    seen += 1
    return seen === occurrence ? replacement : match
  })
}

function exactMutation({ expectedOccurrences = 1, occurrence = 1, ...mutation }) {
  add({
    ...mutation,
    transform(source) {
      const found = occurrences(source, mutation.search)
      if (found !== expectedOccurrences) {
        throw new Error(`expected ${expectedOccurrences} occurrences, found ${found}`)
      }
      return replaceOccurrence(source, mutation.search, mutation.replacement, occurrence)
    },
  })
}

for (const mutation of [
  {
    id: 'binding-rule-effective-order',
    predicate: 'binding uses the most recent effective rule',
    search: '    ORDER BY effective_at DESC, version DESC\n',
    replacement: '    ORDER BY effective_at ASC, version DESC\n',
    test: 'deterministically selects the highest version when effective times tie',
  },
  {
    id: 'binding-rule-version-tiebreak',
    predicate: 'equal effective times use the greatest unique rule version',
    search: '    ORDER BY effective_at DESC, version DESC\n',
    replacement: '    ORDER BY effective_at DESC, version ASC\n',
    test: 'deterministically selects the highest version when effective times tie',
  },
  {
    id: 'binding-inviter-code',
    predicate: 'binding resolves the exact submitted invitation code',
    search: '        ON inviter.invite_code = ${input.code}\n',
    replacement: '        ON inviter.invite_code <> ${input.code}\n',
    test: 'rejects a second binding and preserves the first immutable relationship',
  },
  {
    id: 'binding-code-active',
    predicate: 'a disabled invitation code cannot be bound',
    search: '       AND inviter.invite_code_disabled_at IS NULL\n',
    replacement: '',
    test: 'does not bind a disabled invitation code',
  },
  {
    id: 'binding-not-self',
    predicate: 'inviter and invitee must differ',
    search: '        AND inviter.id <> invitee.id\n',
    replacement: '',
    test: 'rejects self-invitation and an otherwise valid but unknown code independently',
  },
  {
    id: 'binding-server-window',
    predicate: 'database NOW must be inside the server-computed registration window',
    search: '        AND NOW() <= invitee.created_at + make_interval(hours => ${windowHours})\n',
    replacement: '',
    test: 'rejects binding outside the server-computed window',
  },
  {
    id: 'binding-projection-target',
    predicate: 'legacy projection updates only the exact invitee',
    search:
      '      WHERE id = ${input.inviteeCustomerId}\n        AND invited_by_customer_id IS NULL\n',
    replacement:
      '      WHERE id <> ${input.inviteeCustomerId}\n        AND invited_by_customer_id IS NULL\n',
    test: 'rejects a second binding and preserves the first immutable relationship',
  },
  {
    id: 'binding-projection-null-cas',
    predicate: 'legacy projection cannot overwrite an existing inviter',
    search: '        AND invited_by_customer_id IS NULL\n',
    replacement: '',
    test: 'fails closed when the legacy customer projection disagrees with the append-only relation',
  },
  {
    id: 'diagnose-existing-relationship',
    predicate: 'binding rejection diagnosis prioritizes the immutable existing relationship',
    search: '        WHERE invitee_customer_id = ${input.inviteeCustomerId}\n',
    replacement: '        WHERE false\n',
    test: 'rejects a second binding and preserves the first immutable relationship',
  },
  {
    id: 'disable-code-customer-scope',
    predicate: 'code disable is scoped to the authenticated customer',
    search: '      WHERE id = ${customerId}\n        AND invite_code IS NOT NULL\n',
    replacement: '      WHERE id <> ${customerId}\n        AND invite_code IS NOT NULL\n',
    test: 'does not bind a disabled invitation code',
  },
  {
    id: 'disable-code-present',
    predicate: 'only a customer with an invitation code can disable one',
    search: '        AND invite_code IS NOT NULL\n',
    replacement: '',
    test: 'does not bind a disabled invitation code',
  },
]) {
  exactMutation({ file: files.binding, group: 'binding', ...mutation })
}

for (const mutation of [
  {
    id: 'claim-lock-invitee',
    predicate: 'reward replay locks the claim for the exact invitee',
    search: '    WHERE invitee_customer_id = ${inviteeCustomerId}\n    FOR UPDATE\n',
    replacement: '    WHERE invitee_customer_id <> ${inviteeCustomerId}\n    FOR UPDATE\n',
    test: 'concurrently triggering one invitee creates exactly one pending reward',
  },
  {
    id: 'claim-order-id',
    predicate: 'claim uses the triggering order id',
    search: '    JOIN orders ON orders.id = ${input.orderId}\n',
    replacement: '    JOIN orders ON orders.id <> ${input.orderId}\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'claim-order-relationship-owner',
    predicate: 'order customer matches the relationship invitee',
    search: '      AND orders.customer_id = relationship.invitee_customer_id\n',
    replacement: '      AND orders.customer_id <> relationship.invitee_customer_id\n',
    test: 'rewards one invitee only once across multiple succeeded orders',
  },
  {
    id: 'claim-order-input-owner',
    predicate: 'order customer matches the derived invitee input',
    search: '      AND orders.customer_id = ${input.inviteeCustomerId}\n',
    replacement: '      AND orders.customer_id <> ${input.inviteeCustomerId}\n',
    test: 'rewards one invitee only once across multiple succeeded orders',
  },
  {
    id: 'claim-order-state',
    predicate: 'claim begins only from paid, fulfilling, or succeeded',
    search: "      AND orders.status IN ('paid', 'fulfilling', 'succeeded')\n",
    replacement: "      AND orders.status IN ('cancelled', 'refunded')\n",
    test: 'keeps a paid but not succeeded order pending and does not expose available points',
  },
  {
    id: 'claim-relationship-invitee',
    predicate: 'claim selects the exact invitee relationship',
    search: '    WHERE relationship.invitee_customer_id = ${input.inviteeCustomerId}\n',
    replacement: '    WHERE relationship.invitee_customer_id <> ${input.inviteeCustomerId}\n',
    test: 'rewards one invitee only once across multiple succeeded orders',
  },
  {
    id: 'claim-rule-effective-order',
    predicate: 'reward claim snapshots the latest effective rule',
    search: '      ORDER BY effective_at DESC, version DESC\n',
    replacement: '      ORDER BY effective_at ASC, version DESC\n',
    test: 'deterministically selects the highest version when effective times tie',
  },
  {
    id: 'claim-rule-version-tiebreak',
    predicate: 'reward snapshot uses highest version at equal effective times',
    search: '      ORDER BY effective_at DESC, version DESC\n',
    replacement: '      ORDER BY effective_at DESC, version ASC\n',
    test: 'deterministically selects the highest version when effective times tie',
  },
  {
    id: 'claim-rule-enabled',
    predicate: 'a disabled latest rule cannot create a reward claim',
    search: '      AND rule.enabled = true\n',
    replacement: '',
    test: 'does not create a reward claim while the latest versioned rule is disabled',
  },
  {
    id: 'transition-order-id',
    predicate: 'reward transition loads the exact order',
    search: '      WHERE id = ${input.orderId}\n      FOR SHARE\n',
    replacement: '      WHERE id <> ${input.orderId}\n      FOR SHARE\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'recheck-claim-id',
    predicate: 'released reward recheck locks only the requested claim',
    search: '      WHERE id = ${input.claimId}\n        AND EXISTS (\n',
    replacement: '      WHERE id <> ${input.claimId}\n        AND EXISTS (\n',
    test: 'flags newly detected abuse after release without changing ledger or account state',
  },
  {
    id: 'scan-id-tiebreak',
    predicate: 'bounded released-reward scan has an ascending id fallback',
    search: '      ORDER BY claims.id ASC\n',
    replacement: '      ORDER BY claims.id DESC\n',
    test: 'scans released rewards by ascending claim id with an exact deterministic limit',
  },
  {
    id: 'scan-exact-limit',
    predicate: 'released-reward scan honors the exact validated limit',
    search: '      LIMIT ${limit}\n',
    replacement: '      LIMIT 100\n',
    test: 'scans released rewards by ascending claim id with an exact deterministic limit',
  },
]) {
  exactMutation({ file: files.rewards, group: 'reward', ...mutation })
}

function replaceSignalExpression(signal, sourceReplacement) {
  return (source) => {
    const endToken = `) AS ${signal},`
    const end = source.indexOf(endToken)
    if (end < 0) throw new Error(`${signal}: expression end not found`)
    const start = source.lastIndexOf('      EXISTS (', end)
    if (start < 0) throw new Error(`${signal}: EXISTS start not found`)
    return `${source.slice(0, start)}      ${sourceReplacement} AS ${signal},${source.slice(end + endToken.length)}`
  }
}

for (const [signal, test] of [
  ['same_device_hash', 'independently withholds pending reward for same_device_hash'],
  ['same_realname_subject', 'independently withholds pending reward for same_realname_subject'],
  ['same_phone_hash', 'independently withholds pending reward for same_phone_hash'],
  [
    'same_payment_account_hash',
    'independently withholds pending reward for same_payment_account_hash',
  ],
]) {
  add({
    file: files.rewards,
    group: 'signal',
    id: `${signal}-decision`,
    predicate: `${signal} independently contributes a hold signal`,
    test,
    transform:
      signal === 'same_payment_account_hash'
        ? (source) => {
            const previous = source.indexOf(') AS same_phone_hash,')
            const endToken = ') AS same_payment_account_hash,'
            const start = source.indexOf('      EXISTS (', previous)
            const end = source.indexOf(endToken, start)
            if (previous < 0 || start < 0 || end < 0) {
              throw new Error('same_payment_account_hash: outer expression not found')
            }
            return `${source.slice(0, start)}      false AS same_payment_account_hash,${source.slice(end + endToken.length)}`
          }
        : replaceSignalExpression(signal, 'false'),
  })
}
add({
  file: files.rewards,
  group: 'signal',
  id: 'abnormal-invitation-growth-decision',
  predicate: 'configured invitation growth independently contributes a hold signal',
  test: 'withholds abnormal invitation growth at the configured aggregate boundary',
  transform(source) {
    const search = `      (\n        SELECT COUNT(*)\n        FROM invitation_relationships\n        WHERE inviter_customer_id = \${claim.inviterCustomerId}\n          AND bound_at >= NOW() - make_interval(mins => \${thresholds.windowMinutes})\n      ) >= \${thresholds.abuse.invitationGrowthCount} AS abnormal_invitation_growth\n`
    if (occurrences(source, search) !== 1) throw new Error('growth expression not found')
    return source.replace(search, '      false AS abnormal_invitation_growth\n')
  },
})

for (const mutation of [
  {
    id: 'device-hash-source',
    predicate: 'device signal compares the first-party binding device HMAC',
    search: '         AND inviter_session.device_hash = relationship.binding_device_hash\n',
    replacement: '         AND inviter_session.device_hash = relationship.invite_code_hash\n',
    test: 'independently withholds pending reward for same_device_hash',
  },
  {
    id: 'realname-subject-source',
    predicate: 'realname signal compares existing template document subject fields',
    search:
      '         AND inviter_template.identity_document_number = invitee_template.identity_document_number\n',
    replacement:
      '         AND inviter_template.identity_document_number = invitee_template.identity_document_type\n',
    test: 'independently withholds pending reward for same_realname_subject',
  },
  {
    id: 'phone-identifier-hash-source',
    predicate: 'phone signal compares customer identity identifierHash, never plaintext',
    search: '         AND inviter_identity.identifier_hash = invitee_identity.identifier_hash\n',
    replacement:
      '         AND inviter_identity.identifier_hash = invitee_identity.provider_instance_id\n',
    test: 'independently withholds pending reward for same_phone_hash',
  },
  {
    id: 'payment-payer-hash-source',
    predicate: 'payment signal compares stored payer HMAC values',
    search:
      '                AND inviter_payment.payer_identifier_hash = invitee_payer.payer_identifier_hash\n',
    replacement:
      '                AND inviter_payment.wechat_transaction_id = invitee_payer.payer_identifier_hash\n',
    test: 'independently withholds pending reward for same_payment_account_hash',
  },
  {
    id: 'growth-inviter-source',
    predicate: 'growth signal counts relationships for the exact inviter',
    search: '        WHERE inviter_customer_id = ${claim.inviterCustomerId}\n',
    replacement: '        WHERE invitee_customer_id = ${claim.inviterCustomerId}\n',
    test: 'withholds abnormal invitation growth at the configured aggregate boundary',
  },
]) {
  exactMutation({ file: files.rewards, group: 'signal-source', ...mutation })
}

for (const mutation of [
  {
    id: 'earn-transition-evidence-callpoint',
    predicate: 'pending invitation earning validates exact order transition evidence',
    search:
      '    await assertOrderTransitionFact(database, {\n      eventId: input.orderTransitionEventId,\n      orderId: input.orderId,\n      sourceCustomerId: input.sourceCustomerId,\n      status: input.transitionStatus,\n    })\n',
    replacement: '',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'confirm-transition-evidence-callpoint',
    predicate: 'available transition independently validates succeeded evidence',
    search:
      "    await assertOrderTransitionFact(database, {\n      eventId: input.orderTransitionEventId,\n      orderId: discovered.sourceOrderId,\n      sourceCustomerId: discovered.sourceCustomerId,\n      status: 'succeeded',\n    })\n",
    replacement: '',
    test: 'keeps a paid but not succeeded order pending and does not expose available points',
  },
  {
    id: 'transition-evidence-order-id',
    predicate: 'transition evidence uses the source order id',
    search: '    WHERE orders.id = ${input.orderId}\n',
    replacement: '    WHERE orders.id <> ${input.orderId}\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'transition-evidence-order-customer',
    predicate: 'transition evidence uses the source customer on the order',
    search: '      AND orders.customer_id = ${input.sourceCustomerId}\n',
    replacement: '      AND orders.customer_id <> ${input.sourceCustomerId}\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'transition-evidence-order-state',
    predicate: 'transition evidence uses the requested order status',
    search: '      AND orders.status = ${input.status}\n',
    replacement: '      AND orders.status <> ${input.status}\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'transition-evidence-event-id',
    predicate: 'transition evidence uses the exact event id',
    search: '      AND order_events.id = ${input.eventId}\n',
    replacement: '      AND order_events.id <> ${input.eventId}\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'transition-evidence-event-customer',
    predicate: 'transition event carries the exact source customer',
    search: '      AND order_events.customer_id = ${input.sourceCustomerId}\n',
    replacement: '      AND order_events.customer_id <> ${input.sourceCustomerId}\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'transition-evidence-event-state',
    predicate: 'transition event carries the exact target state',
    search: '      AND order_events.to_status = ${input.status}\n',
    replacement: '      AND order_events.to_status <> ${input.status}\n',
    test: 'rejects a transition event sourced from another customer and order',
  },
  {
    id: 'batch-source-customer-write',
    predicate: 'invitation batch stores the invitee as sourceCustomer',
    search: '        ${input.sourceCustomerId},\n        ${input.orderId},\n',
    replacement: '        ${account.customerId},\n        ${input.orderId},\n',
    test: 'rewards one invitee only once across multiple succeeded orders',
  },
  {
    id: 'batch-source-order-write',
    predicate: 'invitation batch stores the exact qualifying order',
    search: '        ${input.sourceCustomerId},\n        ${input.orderId},\n',
    replacement: '        ${input.sourceCustomerId},\n        ${account.customerId},\n',
    test: 'rewards one invitee only once across multiple succeeded orders',
  },
]) {
  exactMutation({ file: files.ledger, group: 'points', ...mutation })
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

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
  for (const mutation of mutations) {
    try {
      mutation.transform(readFileSync(`${webRoot}/${mutation.file}`, 'utf8'))
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
  process.stderr.write(`No D9-E-1 SQL mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  let result
  try {
    writeFileSync(path, mutation.transform(original), 'utf8')
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
  const assertion = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `PREDICATE ${mutation.predicate}\nTEST ${mutation.test}\nRAW_FAILURE ${assertion}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError:')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(`\nD9E1_SQL_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
