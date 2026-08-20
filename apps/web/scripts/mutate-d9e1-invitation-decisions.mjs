import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const tests = {
  d9a: 'tests/integration/d9a-identity-registration.integration.test.ts',
  integration: 'tests/integration/d9e1-invitations.integration.test.ts',
  monitoring: 'tests/unit/operations-monitoring.test.ts',
  payment: 'tests/integration/payments.integration.test.ts',
  topUp: 'tests/integration/d9b2-wallet-top-ups.integration.test.ts',
  unit: 'tests/unit/d9e1-invitations.test.ts',
  wechat: 'tests/unit/wechatpay-provider.test.ts',
}
const files = {
  binding: 'src/services/invitations/binding.ts',
  collections: 'src/collections/invitations.ts',
  identity: 'src/services/auth/customer-identities.ts',
  monitoring: 'src/services/operations/monitoring.ts',
  orderState: 'src/services/commerce/order-state.ts',
  payments: 'src/services/commerce/payments.ts',
  provider: 'src/providers/wechatpay.ts',
  rewards: 'src/services/invitations/rewards.ts',
  rules: 'src/services/invitations/rules.ts',
  schema: 'src/schemas/auth.ts',
  topUps: 'src/services/wallet/top-ups.ts',
  walletCollections: 'src/collections/wallet.ts',
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

function inExport(name, transform) {
  return (source) => {
    const start = source.indexOf(`export const ${name}`)
    if (start < 0) throw new Error(`export ${name} not found`)
    const next = source.indexOf('\nexport const ', start + 1)
    const end = next < 0 ? source.length : next
    const block = source.slice(start, end)
    const changed = transform(block)
    if (changed === block) throw new Error(`export ${name} mutation made no change`)
    return `${source.slice(0, start)}${changed}${source.slice(end)}`
  }
}

exactMutation({
  file: files.collections,
  group: 'deterministic-order',
  id: 'signal-canonical-order',
  search: "  'same_device_hash',\n  'same_realname_subject',\n",
  replacement: "  'same_realname_subject',\n  'same_device_hash',\n",
  test: 'keeps abuse signal ordering deterministic and excludes automatic clawback/account changes',
  testFile: tests.unit,
})

exactMutation({
  file: files.rewards,
  group: 'deterministic-order',
  id: 'signal-event-iteration-order',
  search: '  for (const [order, signal] of (input.signals ?? []).entries()) {\n',
  replacement: '  for (const [order, signal] of (input.signals ?? []).toReversed().entries()) {\n',
  test: 'persists multiple abuse signals in the canonical deterministic order',
  testFile: tests.integration,
})

exactMutation({
  file: files.rewards,
  group: 'deterministic-order',
  id: 'signal-event-order-value',
  search: '      VALUES (${order + 1}, ${eventId}, ${signal})\n',
  replacement: '      VALUES (${(input.signals?.length ?? 0) - order}, ${eventId}, ${signal})\n',
  test: 'persists multiple abuse signals in the canonical deterministic order',
  testFile: tests.integration,
})

for (const mutation of [
  {
    id: 'code-random-byte-count',
    search: 'const entropy = Buffer.from(random(16))',
    replacement: 'const entropy = Buffer.from(random(32)).subarray(0, 16)',
  },
  {
    id: 'code-base64url-encoding',
    search: "const code = entropy.toString('base64url')",
    replacement: "const code = `${entropy.toString('base64url').slice(0, 21)}A`",
  },
  {
    id: 'legacy-code-normalization',
    search: '    return normalized.toUpperCase()\n',
    replacement: '    return normalized\n',
    test: 'accepts the full legacy 12-character input range without weakening new 128-bit generation',
  },
  {
    id: 'new-code-normalization',
    search: '  if (INVITATION_CODE_PATTERN.test(normalized)) return normalized\n',
    replacement:
      '  if (INVITATION_CODE_PATTERN.test(normalized)) return `${normalized.slice(0, 21)}A`\n',
    test: 'encodes all 128 random bits and produces non-enumerable invitation codes',
  },
]) {
  exactMutation({
    file: files.binding,
    group: 'code',
    test:
      mutation.test ?? 'encodes all 128 random bits and produces non-enumerable invitation codes',
    testFile: tests.unit,
    ...mutation,
  })
}

exactMutation({
  file: files.schema,
  group: 'schema',
  id: 'bind-schema-client-time-strict',
  search: '  })\n  .strict()\n\nexport const invitationBindResponseSchema',
  replacement: '  })\n  .passthrough()\n\nexport const invitationBindResponseSchema',
  test: 'rejects client-supplied registration time instead of expanding the server window',
  testFile: tests.unit,
})

for (const collection of [
  'InvitationRewardRuleVersions',
  'InvitationRelationships',
  'InvitationRewardClaims',
  'InvitationRewardEvents',
]) {
  for (const operation of ['create', 'delete', 'update']) {
    add({
      file: files.collections,
      group: 'collection-access',
      id: `${collection}-${operation}`,
      test: 'rejects generic mutations and both update/delete hook callpoints for append-only records',
      testFile: tests.unit,
      transform: inExport(collection, (block) => {
        const search = `${operation}: deny`
        if (occurrences(block, search) !== 1) {
          throw new Error(`${collection}.${operation}: expected one deny access`)
        }
        return block.replace(search, `${operation}: () => true`)
      }),
    })
  }
  add({
    file: files.collections,
    group: 'collection-hooks',
    id: `${collection}-append-only-hooks`,
    test: 'rejects generic mutations and both update/delete hook callpoints for append-only records',
    testFile: tests.unit,
    transform: inExport(collection, (block) => {
      const changed = block.replace(/  hooks: appendOnlyHooks\([^\n]+\),\n/u, '')
      if (changed === block) throw new Error(`${collection}: append-only hook call not found`)
      return changed
    }),
  })
}

for (const mutation of [
  {
    id: 'post-bind-customer-auth',
    search: '  if (!isCustomerUser(req.user)) {\n',
    replacement: '  if (false) {\n',
    occurrence: 1,
    expectedOccurrences: 2,
  },
  {
    id: 'disable-code-customer-auth',
    search: '  if (!isCustomerUser(req.user)) {\n',
    replacement: '  if (false) {\n',
    occurrence: 2,
    expectedOccurrences: 2,
  },
  {
    id: 'post-bind-a3-login',
    search: "  await assertCustomerAccountCapability(req, customerId, 'login')\n",
    replacement: '',
    occurrence: 1,
    expectedOccurrences: 2,
  },
  {
    id: 'disable-code-a3-login',
    search: "  await assertCustomerAccountCapability(req, customerId, 'login')\n",
    replacement: '',
    occurrence: 2,
    expectedOccurrences: 2,
  },
]) {
  exactMutation({
    file: files.binding,
    group: 'authorization',
    test: 'enforces customer authentication, A3 login capability, and system-admin rule ownership',
    testFile: tests.integration,
    ...mutation,
  })
}

exactMutation({
  file: files.rules,
  group: 'authorization',
  id: 'rule-system-admin',
  search: "  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {\n",
  replacement: '  if (false) {\n',
  test: 'enforces customer authentication, A3 login capability, and system-admin rule ownership',
  testFile: tests.integration,
})
exactMutation({
  file: files.rules,
  group: 'rule-input',
  id: 'rule-positive-window',
  search: '  const bindingWindowHours = positiveInteger(input.bindingWindowHours, 24 * 30)\n',
  replacement: '  const bindingWindowHours = input.bindingWindowHours\n',
  test: 'enforces customer authentication, A3 login capability, and system-admin rule ownership',
  testFile: tests.integration,
})
exactMutation({
  file: files.rules,
  group: 'rule-version',
  id: 'rule-version-increment',
  search: '        COALESCE(MAX(version), 0) + 1,\n',
  replacement: '        COALESCE(MAX(version), 0) + 2,\n',
  test: 'deterministically selects the highest version when effective times tie',
  testFile: tests.integration,
})

for (const mutation of [
  {
    id: 'registration-new-code-generation',
    search: '          inviteCode: generateInvitationCode(),\n',
    replacement:
      '          inviteCode: hmac(phone, getEnv().SESSION_PEPPER).slice(0, 12).toUpperCase(),\n',
    test: 'does not create an account at OTP verification and records explicit registration consents',
  },
  {
    id: 'registration-invitation-binding',
    search:
      '        await bindInvitationAtRegistration(req, {\n          code: input.invitationCode,\n          deviceHash: hashes.deviceHash,\n          inviteeCustomerId: customer.id,\n        })\n',
    replacement: '',
    test: 'does not create an account at OTP verification and records explicit registration consents',
  },
  {
    id: 'registration-device-hash-source',
    search: '          deviceHash: hashes.deviceHash,\n',
    replacement: '          deviceHash: hashes.ipHash,\n',
    test: 'does not create an account at OTP verification and records explicit registration consents',
  },
]) {
  exactMutation({
    file: files.identity,
    group: 'registration',
    testFile: tests.d9a,
    ...mutation,
  })
}

exactMutation({
  file: files.binding,
  group: 'binding-source',
  id: 'post-bind-device-hash-source',
  search: '    deviceHash: clientHashes(input.headers, input.deviceId).deviceHash,\n',
  replacement: '    deviceHash: clientHashes(input.headers, input.deviceId).ipHash,\n',
  test: 'rejects a second binding and preserves the first immutable relationship',
  testFile: tests.integration,
})

for (const mutation of [
  {
    id: 'binding-success-audit',
    search: "      action: 'invitation.relationship.bound',\n",
    replacement: "      action: 'invitation.relationship.binding_rejected',\n",
    test: 'rejects a second binding and preserves the first immutable relationship',
  },
  {
    id: 'binding-rejection-audit',
    search: "    action: 'invitation.relationship.binding_rejected',\n",
    replacement: "    action: 'invitation.relationship.bound',\n",
    test: 'rejects a second binding and preserves the first immutable relationship',
  },
  {
    id: 'code-disable-audit',
    search: "      action: 'invitation.code.disabled',\n",
    replacement: "      action: 'invitation.relationship.binding_rejected',\n",
    test: 'does not bind a disabled invitation code',
  },
]) {
  exactMutation({
    file: files.binding,
    group: 'audit',
    testFile: tests.integration,
    ...mutation,
  })
}
exactMutation({
  file: files.rules,
  group: 'audit',
  id: 'rule-created-audit',
  search: "      action: 'invitation.reward_rule.created',\n",
  replacement: "      action: 'admin.account.changed',\n",
  test: 'deterministically selects the highest version when effective times tie',
  testFile: tests.integration,
})
exactMutation({
  file: files.rewards,
  group: 'audit',
  id: 'reward-event-audit',
  search: '  await recordAuditEvent(req, {\n    action: `invitation.reward.${eventType}`,\n',
  replacement:
    '  await recordAuditEvent(req, {\n    action: `points.invitation_reward.${eventType}`,\n',
  test: 'rewards one invitee only once across multiple succeeded orders',
  testFile: tests.integration,
})

for (const [id, search, replacement, test] of [
  [
    'order-hook-paid',
    "to === 'paid' || ",
    '',
    'keeps a paid but not succeeded order pending and does not expose available points',
  ],
  [
    'order-hook-fulfilling',
    "to === 'fulfilling' || ",
    '',
    'rewards one invitee only once across multiple succeeded orders',
  ],
  [
    'order-hook-succeeded',
    " || to === 'succeeded'",
    '',
    'rewards one invitee only once across multiple succeeded orders',
  ],
]) {
  exactMutation({
    file: files.orderState,
    group: 'order-hook',
    id,
    search,
    replacement,
    test,
    testFile: tests.integration,
  })
}

for (const mutation of [
  {
    id: 'reward-order-must-be-claimed-order',
    search:
      "    if (!claim || String(claim.orderId) !== String(input.orderId)) return { outcome: 'ignored' }\n",
    replacement:
      "    if (!claim || String(claim.orderId) === String(input.orderId)) return { outcome: 'ignored' }\n",
    test: 'rewards one invitee only once across multiple succeeded orders',
  },
  {
    id: 'reward-not-available-before-succeeded',
    search: "    if (input.status !== 'succeeded') return { outcome: 'pending' }\n",
    replacement: '',
    test: 'keeps a paid but not succeeded order pending and does not expose available points',
  },
  {
    id: 'reward-signal-hold-branch',
    search: '    if (signals.length > 0) {\n',
    replacement: '    if (false) {\n',
    test: 'independently withholds pending reward for same_device_hash',
  },
  {
    id: 'released-requires-available-event',
    search: "          WHERE claim_id = invitation_reward_claims.id AND event_type = 'available'\n",
    replacement:
      "          WHERE claim_id = invitation_reward_claims.id AND event_type = 'pending'\n",
    test: 'keeps a paid but not succeeded order pending and does not expose available points',
  },
  {
    id: 'released-no-signal-short-circuit',
    search: '    if (signals.length === 0) return { flagged: false }\n',
    replacement: '    if (false) return { flagged: false }\n',
    test: 'rewards one invitee only once across multiple succeeded orders',
  },
]) {
  exactMutation({
    file: files.rewards,
    group: 'reward-branch',
    testFile: tests.integration,
    ...mutation,
  })
}

for (const [field, label] of [
  ['smsRequestCount', '短信请求速率'],
  ['registrationCount', '注册速率'],
  ['invitationGrowthCount', '邀请增长速率'],
  ['pointsEarned', '米币赚取速率'],
  ['walletAbsoluteChangeFen', '余额异常变动'],
]) {
  exactMutation({
    file: files.monitoring,
    group: 'monitor-threshold',
    id: `threshold-${field}`,
    search: `    '${field}',\n`,
    replacement: '',
    test: `${label} 单独越限时产生独立脱敏告警`,
    testFile: tests.monitoring,
  })
}

for (const mutation of [
  {
    id: 'sms-rate-collection',
    search: "        collection: 'smsChallenges',\n",
    replacement: "        collection: 'invitationRelationships',\n",
  },
  {
    id: 'sms-rate-time-source',
    search: "        where: timeRange('sentAt', start, end),\n",
    replacement: "        where: timeRange('createdAt', start, end),\n",
  },
  {
    id: 'registration-rate-collection',
    search: "        collection: 'customerSecurityEvents',\n",
    replacement: "        collection: 'invitationRelationships',\n",
  },
  {
    id: 'registration-rate-event',
    search: "            { event: { equals: 'registration_completed' } },\n",
    replacement: "            { event: { equals: 'login_succeeded' } },\n",
  },
  {
    id: 'registration-rate-time-source',
    search: "            ...timeRange('occurredAt', start, end).and,\n",
    replacement: "            ...timeRange('createdAt', start, end).and,\n",
  },
  {
    id: 'invitation-rate-collection',
    search: "        collection: 'invitationRelationships',\n",
    replacement: "        collection: 'smsChallenges',\n",
  },
  {
    id: 'invitation-rate-time-source',
    search: "        where: timeRange('boundAt', start, end),\n",
    replacement: "        where: timeRange('createdAt', start, end),\n",
  },
  {
    id: 'points-rate-collection',
    search: "        collection: 'pointsBatches',\n",
    replacement: "        collection: 'walletEntries',\n",
  },
  {
    id: 'points-rate-value-source',
    search: '    pointsEarned: checkedSum(pointsBatches.docs.map((batch) => batch.points)),\n',
    replacement: '    pointsEarned: checkedSum(pointsBatches.docs.map(() => 7)),\n',
  },
  {
    id: 'wallet-rate-collection',
    search: "        collection: 'walletEntries',\n",
    replacement: "        collection: 'pointsBatches',\n",
  },
  {
    id: 'wallet-rate-entry-types',
    search: "            { entryType: { in: ['credit', 'capture', 'recovery'] } },\n",
    replacement: "            { entryType: { in: ['hold', 'release'] } },\n",
  },
  {
    id: 'wallet-rate-value-source',
    search:
      '    walletAbsoluteChangeFen: checkedSum(walletEntries.docs.map((entry) => entry.amountFen)),\n',
    replacement: '    walletAbsoluteChangeFen: checkedSum(walletEntries.docs.map(() => 29)),\n',
  },
]) {
  exactMutation({
    file: files.monitoring,
    group: 'monitor-source',
    test: 'collects five de-correlated abuse rates from their authoritative fields without identifiers',
    testFile: tests.monitoring,
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'provider-payer-field-source',
    search: '  return input.payer?.openid\n',
    replacement: '  return undefined\n',
    test: 'extracts the payer only from the official nested openid field',
    testFile: tests.wechat,
  },
  {
    id: 'provider-notification-payer-callpoint',
    search: '      const payerIdentifier = wechatPaymentPayerIdentifier(transaction)\n',
    replacement: '      const payerIdentifier = undefined\n',
    test: 'verifies RSA notification signatures, decrypts AES-GCM only afterwards and rejects tampering',
    testFile: tests.wechat,
  },
  {
    id: 'provider-query-payer-callpoint',
    search: '    const payerIdentifier = wechatPaymentPayerIdentifier(parsed.data)\n',
    replacement: '    const payerIdentifier = undefined\n',
    test: 'creates signed Native and H5 orders with the server expiry and queries a verified response',
    testFile: tests.wechat,
  },
]) {
  exactMutation({ file: files.provider, group: 'payer-hash', ...mutation })
}
exactMutation({
  file: files.payments,
  group: 'payer-hash',
  id: 'payment-notification-hmac',
  search:
    '                    payerIdentifierHash: hmac(paidQuery.payerIdentifier, getEnv().SESSION_PEPPER),\n',
  replacement: "              payerIdentifierHash: '0'.repeat(64),\n",
  test: 'uses the quote expiry, confirms by server query and replays one notification idempotently',
  testFile: tests.payment,
})
exactMutation({
  file: files.topUps,
  group: 'payer-hash',
  id: 'top-up-payer-hmac',
  search: 'paid.payerIdentifier ? hmac(paid.payerIdentifier, getEnv().SESSION_PEPPER) : null',
  replacement: 'paid.payerIdentifier ? null : null',
  test: 'makes repeated confirmation of one top-up add exactly one ledger credit',
  testFile: tests.topUp,
})
exactMutation({
  file: files.walletCollections,
  group: 'payer-hash',
  id: 'top-up-payer-hash-field-read',
  search:
    "      name: 'payerIdentifierHash',\n      type: 'text',\n      access: { read: sensitiveFieldRead },\n",
  replacement: "      name: 'payerIdentifierHash',\n      type: 'text',\n",
  test: 'makes repeated confirmation of one top-up add exactly one ledger credit',
  testFile: tests.topUp,
})

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.file}\t${mutation.test}\n`)
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
  process.stderr.write(`No D9-E-1 decision mutations matched: ${selectors.join(', ')}\n`)
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
  const assertion = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.testFile} :: ${mutation.test}\nRAW_FAILURE ${assertion}\n`)
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
process.stdout.write(`\nD9E1_DECISION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
