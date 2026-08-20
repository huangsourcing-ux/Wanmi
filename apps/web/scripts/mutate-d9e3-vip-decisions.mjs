import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9e3-vip-tiers.integration.test.ts'
const unitTest = 'tests/unit/d9e3-vip-collections.test.ts'
const files = {
  collection: 'src/collections/vip.ts',
  domain: 'src/lib/domain.ts',
  executor: 'src/services/admin/operation-executors.ts',
  orderState: 'src/services/commerce/order-state.ts',
  service: 'src/services/vip/tiers.ts',
}
const mutations = []
const add = (mutation) => mutations.push({ file: files.service, ...mutation })

for (const mutation of [
  {
    id: 'configuration-scope',
    search: "  if (!hasAdminOperationScope(req.user, 'system_configuration')) {",
    replacement: '  if (false) {',
    test: 'rejects rule publication without the system-configuration scope',
  },
  {
    id: 'publish-schema',
    search: '  const input = vipTierRulePublishSchema.parse(rawInput)\n',
    replacement: '  const input = rawInput\n',
    test: 'validates publish, promotion, and appeal input again inside each business service',
  },
  {
    id: 'promotion-schema',
    search: '  const promotion = vipOperationalPromotionSchema.parse(input)\n',
    replacement: '  const promotion = input\n',
    test: 'validates publish, promotion, and appeal input again inside each business service',
  },
  {
    id: 'appeal-schema',
    search: '  const input = vipTierAppealCreateSchema.parse(rawInput)\n',
    replacement: '  const input = rawInput as { statement: string; tierEventId: number }\n',
    test: 'validates publish, promotion, and appeal input again inside each business service',
  },
  {
    id: 'rule-rank-canonical-order',
    search:
      '    .sort(\n      (left, right) =>\n        left.tierRank - right.tierRank || left.tierCode.localeCompare(right.tierCode),\n    )',
    replacement: '',
    test: 'canonicalizes reversed input tiers before validating and publishing ranks',
  },
  {
    id: 'rule-rank-contiguous',
    search: '    if (tier.tierRank !== index + 1 || codes.has(tier.tierCode)) {',
    replacement: '    if (codes.has(tier.tierCode)) {',
    test: 'rejects a non-contiguous tier rank independently',
  },
  {
    id: 'rule-code-unique',
    search: '    if (tier.tierRank !== index + 1 || codes.has(tier.tierCode)) {',
    replacement: '    if (tier.tierRank !== index + 1) {',
    test: 'rejects a duplicate tier code independently',
  },
  {
    id: 'rule-threshold-strict',
    search: '    if (tier.thresholdFen <= previousThreshold) {',
    replacement: '    if (tier.thresholdFen < previousThreshold) {',
    test: 'rejects a non-increasing tier threshold independently',
  },
  {
    id: 'rule-effective-not-past',
    search: '  if (effectiveAt.getTime() < now.getTime()) {',
    replacement: '  if (false) {',
    test: 'rejects a rule version whose effective time is before the publication clock',
  },
  {
    id: 'rule-previous-rank-retained',
    search: '        if (!sameRank || sameRank.tierCode !== previous.tierCode) {',
    replacement: '        if (sameRank && sameRank.tierCode !== previous.tierCode) {',
    test: 'rejects deleting an existing tier identity in a later rule version',
  },
  {
    id: 'rule-previous-code-retained',
    search: '        if (!sameRank || sameRank.tierCode !== previous.tierCode) {',
    replacement: '        if (!sameRank) {',
    test: 'rejects reusing an existing tier rank with another code',
  },
  {
    id: 'notice-display-name',
    search: '      candidate.displayName !== level.displayName ||\n',
    replacement: '',
    test: 'requires the advance-notice lead independently for a display name change',
  },
  {
    id: 'notice-service-content',
    search: '      candidate.serviceContent !== level.serviceContent ||\n',
    replacement: '',
    test: 'requires the advance-notice lead independently for a service content change',
  },
  {
    id: 'notice-quota-benefits',
    search: '      stableJson(candidate.quotaBenefits) !== stableJson(level.quotaBenefits)\n',
    replacement: '      false\n',
    test: 'requires the advance-notice lead independently for a quota benefits change',
  },
  {
    id: 'notice-quota-key-order',
    search:
      '    Object.fromEntries(\n      [...Object.entries(value)].sort(([left], [right]) => left.localeCompare(right)),\n    ),',
    replacement: '    value,',
    test: 'canonicalizes quota-benefit key order without producing a false change notification',
  },
  {
    id: 'notice-lead-time',
    search: '      effectiveAt.getTime() - now.getTime() < VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS',
    replacement: '      false',
    test: 'requires the advance-notice lead independently for a display name change',
  },
  {
    id: 'rule-publication-serialization',
    search:
      "    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('wanmi:vip-tier-rule-version'))`)\n",
    replacement: '',
    test: 'serializes concurrent rule publications into unique audited versions',
  },
  {
    id: 'advance-notification-branch',
    search: '    if (requiresAdvanceNotice) {\n',
    replacement: '    if (false) {\n',
    occurrence: 1,
    expectedOccurrences: 1,
    test: 'publishes versioned rules, enforces advance notice timing, and exposes current adjustable benefits',
  },
  {
    id: 'advance-notification-each-holder',
    search: '      for (const customerId of customers) {\n',
    replacement: '      for (const customerId of []) {\n',
    test: 'publishes versioned rules, enforces advance notice timing, and exposes current adjustable benefits',
  },
  {
    id: 'publish-audit',
    search: "    await recordAuditEvent(req, {\n      action: 'vip.tier_rule.published',",
    replacement:
      "    if (false) await recordAuditEvent(req, {\n      action: 'vip.tier_rule.published',",
    test: 'serializes concurrent rule publications into unique audited versions',
  },
  {
    id: 'natural-order-status',
    search: "    if (order.status !== 'succeeded' || !order.paymentChannel) {",
    replacement: '    if (!order.paymentChannel) {',
    test: 'counts only succeeded orders and independently excludes status pending_payment|counts only succeeded orders and independently excludes status paid|counts only succeeded orders and independently excludes status fulfilling|counts only succeeded orders and independently excludes status refund_pending|counts only succeeded orders and independently excludes status refunding|counts only succeeded orders and independently excludes status refunded|counts only succeeded orders and independently excludes status manual_review|counts only succeeded orders and independently excludes status cancelled',
    testSelector:
      'counts only succeeded orders and independently excludes status pending_payment|counts only succeeded orders and independently excludes status paid|counts only succeeded orders and independently excludes status fulfilling|counts only succeeded orders and independently excludes status refund_pending|counts only succeeded orders and independently excludes status refunding|counts only succeeded orders and independently excludes status refunded|counts only succeeded orders and independently excludes status manual_review|counts only succeeded orders and independently excludes status cancelled',
  },
  {
    id: 'natural-payment-channel',
    search: "    if (order.status !== 'succeeded' || !order.paymentChannel) {",
    replacement: "    if (order.status !== 'succeeded') {",
    test: 'excludes a succeeded row whose authoritative payment channel is absent',
  },
  {
    id: 'natural-no-rule-no-achievement',
    search:
      '    if (!rule) return { achievementCount: 0, counted: true, cumulativeSpendFen: cumulative }',
    replacement: "    if (!rule) throw new AppError('VIP_TIER_RULE_UNAVAILABLE', 'mutated', 409)",
    test: 'counts a successful order but creates no achievement before the first effective rule',
  },
  {
    id: 'natural-skip-achieved-rank',
    search:
      '      if (tier.tierRank <= currentRank || BigInt(tier.thresholdFen) > BigInt(cumulative)) continue',
    replacement: '      if (BigInt(tier.thresholdFen) > BigInt(cumulative)) continue',
    test: 'does not append a second achievement for a rank already reached by another order',
  },
  {
    id: 'natural-threshold',
    search:
      '      if (tier.tierRank <= currentRank || BigInt(tier.thresholdFen) > BigInt(cumulative)) continue',
    replacement: '      if (tier.tierRank <= currentRank) continue',
    test: 'selects the highest version when two rules have the same effective time',
  },
  {
    id: 'promotion-must-raise',
    search: '    if (tier.tierRank <= currentRank) {',
    replacement: '    if (false) {',
    test: 'rejects operational promotion that does not raise the current tier',
  },
  {
    id: 'correction-approval-context',
    search:
      '  if (req.context.adminApprovalExecution !== `vip_fraud_correction:${input.approvalRequestId}`) {',
    replacement: '  if (false) {',
    test: 'requires B-5 request, approval, cooldown and execution for a corrective downgrade',
  },
  {
    id: 'correction-source',
    search: "  if (!['data_correction', 'fraud_reversal'].includes(input.source)) {",
    replacement: '  if (false) {',
    test: 'rejects a correction with an independently invalid source',
  },
  {
    id: 'correction-safe-amount',
    search: '  if (!Number.isSafeInteger(input.spendReversalFen) || input.spendReversalFen < 0) {',
    replacement: '  if (input.spendReversalFen < 0) {',
    test: 'rejects a correction with an independently unsafe non-integer amount',
  },
  {
    id: 'correction-nonnegative-amount',
    search: '  if (!Number.isSafeInteger(input.spendReversalFen) || input.spendReversalFen < 0) {',
    replacement: '  if (!Number.isSafeInteger(input.spendReversalFen)) {',
    test: 'rejects a correction with an independently negative amount',
  },
  {
    id: 'correction-current-tier-exists',
    search: '    if (!current || current.tierRank === 0) {',
    replacement: '    if (false) {',
    test: 'rejects correction when the customer has no achieved tier',
  },
  {
    id: 'correction-target-exists',
    search: '    if (input.targetTierCode !== null && !target) {',
    replacement: '    if (false) {',
    test: 'rejects same-tier, higher-tier, missing-tier, and excessive-spend corrections independently',
  },
  {
    id: 'correction-must-lower',
    search: '    if (targetRank >= current.tierRank) {',
    replacement: '    if (false) {',
    test: 'rejects same-tier, higher-tier, missing-tier, and excessive-spend corrections independently',
  },
  {
    id: 'correction-not-over-spend',
    search: '    if (input.spendReversalFen > beforeSpend) {',
    replacement: '    if (false) {',
    test: 'rejects same-tier, higher-tier, missing-tier, and excessive-spend corrections independently',
  },
  {
    id: 'correction-zero-does-not-invent-debit',
    search: '    if (input.spendReversalFen > 0) {',
    replacement: '    if (true) {',
    test: 'allows an approved rule/data correction to lower a tier without inventing a spend debit',
  },
  {
    id: 'status-customer-auth',
    search:
      "  if (!isCustomerUser(req.user)) throw new AppError('CUSTOMER_AUTH_REQUIRED', '请先登录', 401)\n",
    replacement: '',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'rejects anonymous or admin reads at the customer VIP status callpoint',
  },
  {
    id: 'appeal-customer-auth',
    search:
      "  if (!isCustomerUser(req.user)) throw new AppError('CUSTOMER_AUTH_REQUIRED', '请先登录', 401)\n",
    replacement: '',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'rejects a correction appeal at the non-customer callpoint',
  },
  {
    id: 'appeal-correction-only',
    search: "    if (event.eventType !== 'tier_correction') {",
    replacement: '    if (false) {',
    test: 'rejects an appeal against an achievement rather than a correction',
  },
])
  add({ group: 'service', ...mutation })

add({
  group: 'source-contract',
  id: 'bigint-threshold-comparison',
  search: 'BigInt(tier.thresholdFen) > BigInt(cumulative)',
  replacement: 'tier.thresholdFen > cumulative',
  testFile: unitTest,
  test: 'keeps tier reads sourced from append-only events and spend totals sourced from append-only entries',
})

for (const mutation of [
  {
    id: 'generic-write-deny',
    search: 'const deny: Access = () => false\n',
    replacement: 'const deny: Access = () => true\n',
    test: 'keeps every VIP business record append-only and denies generic mutations',
  },
  {
    id: 'append-update-hook',
    search: "      if (operation === 'update') throw new AppError(code, message, 409)",
    replacement:
      "      if (false && operation === 'update') throw new AppError(code, message, 409)",
    test: 'keeps every VIP business record append-only and denies generic mutations',
  },
  {
    id: 'append-delete-hook',
    search: '      throw new AppError(code, message, 409)\n',
    replacement: '      return undefined\n',
    test: 'keeps every VIP business record append-only and denies generic mutations',
  },
  {
    id: 'four-source-enum',
    search: "  'fraud_reversal',\n] as const",
    replacement: "  'operational_promotion',\n] as const",
    test: 'uses exactly the four approved tier-event sources',
  },
  {
    id: 'independent-identity-field',
    search: "  fields: [\n    positiveSafeInteger('version'),",
    replacement:
      "  fields: [\n    { name: 'vip' + 'Granted', type: 'checkbox' },\n    positiveSafeInteger('version'),",
    test: 'contains no independent VIP identity field in collections or generated customer types',
  },
]) {
  add({
    group: 'collection',
    file: files.collection,
    testFile: unitTest,
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'transactional-notification-type',
    search: "  'vip_benefit_change_advance',\n",
    replacement: '',
  },
  {
    id: 'not-marketing-notification',
    search:
      "export const MARKETING_NOTIFICATION_TYPES = ['product_updates', 'promotions'] as const",
    replacement:
      "export const MARKETING_NOTIFICATION_TYPES = ['product_updates', 'promotions', 'vip_benefit_change_advance'] as const",
  },
]) {
  add({
    group: 'notification',
    file: files.domain,
    testFile: unitTest,
    test: 'registers advance benefit changes as a non-optional transactional notification',
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'succeeded-transition-coupling',
    search:
      '      await recordVipSpendForSucceededOrder(req, { eventId: event.id, orderId: order.id })\n',
    replacement: '',
    test: 'couples the succeeded order transition to one VIP spend entry',
  },
  {
    id: 'refunded-transition-coupling',
    search:
      '      await recordVipSpendReversalForRefundedOrder(req, {\n        eventId: event.id,\n        orderId: order.id,\n      })\n',
    replacement: '',
    test: 'records a refunded-order reversal once while preserving the achieved tier',
  },
])
  add({ group: 'order-state', file: files.orderState, ...mutation })

for (const mutation of [
  {
    id: 'approval-context-binding',
    search: 'return withApprovalContext(req, `vip_fraud_correction:${claimed.id}`, () =>',
    replacement: 'return withApprovalContext(req, `vip_fraud_correction:mutated`, () =>',
  },
  {
    id: 'approval-domain-executor',
    search:
      '          return withApprovalContext(req, `vip_fraud_correction:${claimed.id}`, () =>\n            applyApprovedVipTierCorrection(req, {\n              approvalRequestId: claimed.id,\n              correctionReference: input.correctionReference,\n              customerId: input.customerId,\n              reasonNote: input.reasonNote,\n              source: input.correctionSource,\n              spendReversalFen: input.spendReversalFen,\n              targetTierCode: input.targetTierCode,\n            }),\n          )',
    replacement:
      '          return withApprovalContext(req, `vip_fraud_correction:${claimed.id}`, () =>\n            Promise.resolve({ cumulativeSpendFen: 0, eventId: 0, tierRank: 0 }),\n          )',
  },
  {
    id: 'approval-correction-source-binding',
    search: '              source: input.correctionSource,\n',
    replacement: "              source: 'fraud_reversal',\n",
    test: 'records data correction as an approved append-only event and matching audit fact',
  },
])
  add({
    group: 'approval-coupling',
    file: files.executor,
    test:
      mutation.test ??
      'requires B-5 request, approval, cooldown and execution for a corrective downgrade',
    ...mutation,
  })

function changesFor(mutation) {
  return mutation.changes ?? [mutation]
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
  for (const change of changesFor(mutation)) {
    const found = occurrences(result, change.search)
    const expected = change.expectedOccurrences ?? mutation.expectedOccurrences ?? 1
    if (found !== expected) throw new Error(`expected ${expected} occurrences, found ${found}`)
    result = replaceOccurrence(
      result,
      change.search,
      change.replacement,
      change.occurrence ?? mutation.occurrence ?? 1,
    )
  }
  return result
}
const stripAnsi = (value) => value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')

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
      mutateSource(readFileSync(`${webRoot}/${mutation.file}`, 'utf8'), mutation)
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
  process.stderr.write(`No D9-E-3 decision mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  let result
  try {
    writeFileSync(path, mutateSource(original, mutation), 'utf8')
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
        mutation.testFile ?? integrationTest,
        '-t',
        mutation.testSelector ?? mutation.test,
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const assertion = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`MUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.test}\nRAW_FAILURE ${assertion}\n`)
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
process.stdout.write(`D9E3_DECISION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
