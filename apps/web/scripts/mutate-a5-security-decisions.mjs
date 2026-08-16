import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9a-account-recovery.integration.test.ts'
const routeTest = 'tests/unit/account-recovery-route.test.ts'

const evidenceTest = 'keeps every evidence ownership and proof predicate behaviorally necessary'
const invalidStateTest =
  'fails closed on invalid evidence identifiers and invalid or missing account-state rows'
const reviewerTest =
  'rejects non-system-admin and mismatched reviewer identities before consuming a conclusion'
const mainApprovalTest =
  'atomically consumes one approval, restores through A3, revokes every session, records cooldown, and notifies every old channel'
const submissionTest =
  'submits verified real-name, historical-order, and confirmed-payment evidence to manualReviews'

const mutations = []
const add = (mutation) => mutations.push(mutation)

const requestSchemaFields = [
  ['full-name', 'fullNameChinese', 'z.string().trim().min(2).max(50)', 1, 51],
  ['order-number', 'historicalOrderNumber', 'z.string().trim().min(8).max(64)', 5, 65],
  ['document-number', 'identityDocumentNumber', 'z.string().trim().min(3).max(64)', 2, 65],
  ['payment-transaction', 'paymentTransactionId', 'z.string().trim().min(8).max(128)', 5, 129],
  ['phone', 'phone', 'z.string().trim().min(11).max(16)', 10, 17],
]

for (const [id, field, expression, weakMin, weakMax] of requestSchemaFields) {
  const line = `    ${field}: ${expression},\n`
  add({
    file: 'src/schemas/auth.ts',
    group: 'schema',
    id: `request-${id}-required`,
    replacement: `    ${field}: ${expression}.optional(),\n`,
    search: line,
    test: 'requires every evidence field, both unavailable-channel declarations, and no unknown fields',
    testFile: routeTest,
  })
  add({
    file: 'src/schemas/auth.ts',
    group: 'schema',
    id: `request-${id}-trimmed`,
    replacement: line.replace('.trim()', ''),
    search: line,
    test: 'requires every evidence field, both unavailable-channel declarations, and no unknown fields',
    testFile: routeTest,
  })
  add({
    file: 'src/schemas/auth.ts',
    group: 'schema',
    id: `request-${id}-minimum`,
    replacement: line.replace(/\.min\(\d+\)/u, `.min(${weakMin})`),
    search: line,
    test: 'requires every evidence field, both unavailable-channel declarations, and no unknown fields',
    testFile: routeTest,
  })
  add({
    file: 'src/schemas/auth.ts',
    group: 'schema',
    id: `request-${id}-maximum`,
    replacement: line.replace(/\.max\([^)]+\)/u, `.max(${weakMax})`),
    search: line,
    test: 'requires every evidence field, both unavailable-channel declarations, and no unknown fields',
    testFile: routeTest,
  })
}

for (const field of ['phoneUnavailable', 'wechatUnavailable']) {
  add({
    file: 'src/schemas/auth.ts',
    group: 'schema',
    id: `request-${field}-required`,
    replacement: `    ${field}: z.literal(true).optional(),\n`,
    search: `    ${field}: z.literal(true),\n`,
    test: 'requires every evidence field, both unavailable-channel declarations, and no unknown fields',
    testFile: routeTest,
  })
  add({
    file: 'src/schemas/auth.ts',
    group: 'schema',
    id: `request-${field}-must-be-true`,
    replacement: `    ${field}: z.boolean(),\n`,
    search: `    ${field}: z.literal(true),\n`,
    test: 'requires every evidence field, both unavailable-channel declarations, and no unknown fields',
    testFile: routeTest,
  })
}

add({
  file: 'src/schemas/auth.ts',
  group: 'schema',
  id: 'request-schema-strict',
  replacement: '    wechatUnavailable: z.literal(true),\n  })\n  .passthrough()\n',
  search: '    wechatUnavailable: z.literal(true),\n  })\n  .strict()\n',
  test: 'requires every evidence field, both unavailable-channel declarations, and no unknown fields',
  testFile: routeTest,
})

for (const mutation of [
  {
    id: 'decision-conclusion-required',
    replacement: "    conclusion: z.enum(['approved', 'rejected']).optional(),\n",
    search: "    conclusion: z.enum(['approved', 'rejected']),\n",
  },
  {
    id: 'decision-conclusion-enum',
    replacement: "    conclusion: z.enum(['approved', 'rejected', 'allow']),\n",
    search: "    conclusion: z.enum(['approved', 'rejected']),\n",
  },
  {
    id: 'decision-note-required',
    replacement: '    note: z.string().trim().min(3).max(2_000).optional(),\n',
    search: '    note: z.string().trim().min(3).max(2_000),\n',
  },
  {
    id: 'decision-note-trimmed',
    replacement: '    note: z.string().min(3).max(2_000),\n',
    search: '    note: z.string().trim().min(3).max(2_000),\n',
  },
  {
    id: 'decision-note-minimum',
    replacement: '    note: z.string().trim().min(1).max(2_000),\n',
    search: '    note: z.string().trim().min(3).max(2_000),\n',
  },
  {
    id: 'decision-note-maximum',
    replacement: '    note: z.string().trim().min(3).max(2_001),\n',
    search: '    note: z.string().trim().min(3).max(2_000),\n',
  },
  {
    id: 'decision-schema-strict',
    replacement:
      "    conclusion: z.enum(['approved', 'rejected']),\n    note: z.string().trim().min(3).max(2_000),\n  })\n  .passthrough()\n",
    search:
      "    conclusion: z.enum(['approved', 'rejected']),\n    note: z.string().trim().min(3).max(2_000),\n  })\n  .strict()\n",
  },
]) {
  add({
    ...mutation,
    file: 'src/schemas/auth.ts',
    group: 'schema',
    test: 'requires one approved/rejected conclusion, a bounded note, and no unknown fields',
    testFile: routeTest,
  })
}

function addBodyRouteMutations({ file, groupPrefix, maxBytes, test }) {
  const errorCode =
    groupPrefix === 'public'
      ? 'ACCOUNT_RECOVERY_REQUEST_TOO_LARGE'
      : 'ACCOUNT_RECOVERY_REVIEW_TOO_LARGE'
  const label = groupPrefix === 'public' ? '账户找回请求过大' : '账户找回审核请求过大'
  add({
    file,
    group: 'route',
    id: `${groupPrefix}-content-type`,
    replacement: '  if (false) {\n',
    search:
      "  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {\n",
    test,
    testFile: routeTest,
  })
  for (const [id, atom] of [
    ['declared-finite', '!Number.isFinite(declaredLength)'],
    ['declared-nonnegative', 'declaredLength < 0'],
    ['declared-maximum', 'declaredLength > MAX_BODY_BYTES'],
  ]) {
    const condition =
      '!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES'
    add({
      file,
      group: 'route',
      id: `${groupPrefix}-${id}`,
      replacement: `  if (${condition.replace(atom, 'false')}) {\n`,
      search: `  if (${condition}) {\n`,
      test,
      testFile: routeTest,
    })
  }
  add({
    file,
    group: 'route',
    id: `${groupPrefix}-actual-maximum`,
    replacement: '  if (false) {\n',
    search: '  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {\n',
    test,
    testFile: routeTest,
  })
  add({
    file,
    group: 'route',
    id: `${groupPrefix}-malformed-json`,
    replacement:
      groupPrefix === 'public'
        ? "  } catch {\n    return {\n      fullNameChinese: '李小明',\n      historicalOrderNumber: 'A5-ORDER-20260816',\n      identityDocumentNumber: '11010519491231002X',\n      paymentTransactionId: '420000202608160000001',\n      phone: '+8613912345678',\n      phoneUnavailable: true,\n      wechatUnavailable: true,\n    }\n  }\n"
        : "  } catch {\n    return { conclusion: 'approved', note: '人工证据已核验' }\n  }\n",
    search: `  } catch {\n    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)\n  }\n`,
    expectedOccurrences: 1,
    test,
    testFile: routeTest,
  })
  void errorCode
  void label
  void maxBytes
}

addBodyRouteMutations({
  file: 'src/app/api/v1/auth/account-recovery/route.ts',
  groupPrefix: 'public',
  maxBytes: 4_096,
  test: 'rejects invalid or oversized declared request lengths before reading evidence',
})
mutations.find((mutation) => mutation.id === 'public-content-type').test =
  'rejects non-JSON request bodies before creating a Payload request'
mutations.find((mutation) => mutation.id === 'public-actual-maximum').test =
  'rejects an oversized actual UTF-8 account-recovery body'
mutations.find((mutation) => mutation.id === 'public-malformed-json').test =
  'maps malformed JSON to the stable invalid-request response'

addBodyRouteMutations({
  file: 'src/app/api/v1/admin/account-recoveries/[reviewId]/decision/route.ts',
  groupPrefix: 'admin',
  maxBytes: 8_192,
  test: 'rejects non-JSON, malformed, and oversized review bodies before authentication',
})

for (const [id, search, replacement] of [
  [
    'admin-review-id-integer',
    'const reviewIdSchema = z.coerce.number().int().positive()\n',
    'const reviewIdSchema = z.coerce.number().positive()\n',
  ],
  [
    'admin-review-id-positive',
    'const reviewIdSchema = z.coerce.number().int().positive()\n',
    'const reviewIdSchema = z.coerce.number().int()\n',
  ],
]) {
  add({
    file: 'src/app/api/v1/admin/account-recoveries/[reviewId]/decision/route.ts',
    group: 'route',
    id,
    replacement,
    search,
    test: 'rejects invalid review ids before authentication',
    testFile: routeTest,
  })
}

add({
  file: 'src/app/api/v1/admin/account-recoveries/[reviewId]/decision/route.ts',
  group: 'route',
  id: 'admin-system-role-gate',
  replacement:
    '    const req = { headers: request.headers, payload: {}, user: { id: 7 } } as never\n    const user = { id: 7 }\n',
  search: '    const { req, user } = await systemAdminRequest(payload, request)\n',
  test: 'fails closed when the system-admin request gate rejects',
  testFile: routeTest,
})

for (const [id, search, replacement, test] of [
  [
    'positive-id-safe-integer',
    '  if (!Number.isSafeInteger(id) || id <= 0) throw invalidEvidence()\n',
    '  if (false || id <= 0) throw invalidEvidence()\n',
    invalidStateTest,
  ],
  [
    'positive-id-positive',
    '  if (!Number.isSafeInteger(id) || id <= 0) throw invalidEvidence()\n',
    '  if (!Number.isSafeInteger(id) || false) throw invalidEvidence()\n',
    invalidStateTest,
  ],
  [
    'phone-channel-unavailable',
    '  if (input.phoneUnavailable !== true) {\n',
    '  if (false) {\n',
    'rejects the request independently when phone is not declared unavailable',
  ],
  [
    'wechat-channel-unavailable',
    '  if (input.wechatUnavailable !== true) {\n',
    '  if (false) {\n',
    'rejects the request independently when Wechat is not declared unavailable',
  ],
  [
    'phone-normalization-fails-before-query',
    '  } catch {\n    throw invalidEvidence()\n  }\n\n  let row',
    '  } catch {\n    phone = input.phone\n  }\n\n  let row',
    'rejects an invalid phone before attempting any evidence query',
  ],
  [
    'evidence-query-error-fails-closed',
    "  } catch {\n    throw new AppError('ACCOUNT_RECOVERY_EVIDENCE_UNAVAILABLE', '账户找回证据暂时无法核验', 503)\n  }\n",
    '  } catch {\n    row = { customer_id: 1, order_id: 1, payment_notification_id: 1, realname_template_id: 1 }\n  }\n',
    'fails closed when evidence or account-state storage cannot be queried',
  ],
  [
    'evidence-row-required',
    '  if (!row) throw invalidEvidence()\n',
    '  if (false) throw invalidEvidence()\n',
    evidenceTest,
  ],
]) {
  add({
    file: 'src/services/auth/account-recovery.ts',
    group: 'request-guards',
    id,
    replacement,
    search,
    test,
  })
}

for (const [id, search, replacement] of [
  [
    'manual-review-reason',
    `        reasonCode: RECOVERY_REASON_CODE,\n`,
    `        reasonCode: 'wrong_recovery_reason',\n`,
  ],
  ['manual-review-open-status', "        status: 'open',\n", "        status: 'resolved',\n"],
  [
    'request-record-event',
    "        eventType: 'request_submitted',\n",
    "        eventType: 'review_concluded',\n",
  ],
  [
    'request-record-unavailable-providers',
    "        unavailableProviders: ['phone', 'wechat'],\n",
    "        unavailableProviders: ['phone'],\n",
  ],
  [
    'request-record-realname-evidence',
    '        realnameTemplate: evidence.realnameTemplateId,\n',
    '        realnameTemplate: undefined,\n',
  ],
  [
    'request-record-order-evidence',
    '        order: evidence.orderId,\n',
    '        order: undefined,\n',
  ],
  [
    'request-record-payment-evidence',
    '        paymentNotification: evidence.paymentNotificationId,\n',
    '        paymentNotification: undefined,\n',
  ],
  [
    'request-record-occurred-at',
    '        occurredAt: submittedAt,\n',
    "        occurredAt: '1970-01-01T00:00:00.000Z',\n",
  ],
  [
    'request-security-event',
    "    await recordCustomerSecurityEvent(req, evidence.customerId, 'account_recovery_requested', {\n",
    "    await recordCustomerSecurityEvent(req, evidence.customerId, 'wrong_recovery_event', {\n",
  ],
  [
    'request-audit-action',
    "      action: 'customer.account_recovery.requested',\n",
    "      action: 'admin.auth.login_failed',\n",
  ],
]) {
  add({
    file: 'src/services/auth/account-recovery.ts',
    group: 'request-recording',
    id,
    ...(new Set([
      'request-record-unavailable-providers',
      'request-record-realname-evidence',
      'request-record-order-evidence',
      'request-record-payment-evidence',
    ]).has(id)
      ? { expectedOccurrences: 2, occurrence: 2 }
      : {}),
    replacement,
    search,
    test: submissionTest,
  })
}

for (const [id, search, replacement] of [
  ['reviewer-system-admin-role', "    hasRole(req.user, ['system_admin']) &&\n", '    true &&\n'],
  [
    'reviewer-principal-id-match',
    '    String(req.user?.id) === String(reviewerId) &&\n',
    '    true &&\n',
  ],
  [
    'reviewer-id-safe-integer',
    '    Number.isSafeInteger(normalizedReviewerId) &&\n',
    '    true &&\n',
  ],
  ['reviewer-id-positive', '    normalizedReviewerId > 0\n', '    true\n'],
]) {
  add({
    file: 'src/services/auth/account-recovery.ts',
    group: 'reviewer',
    id,
    replacement,
    search,
    test: reviewerTest,
  })
}

for (const [id, search, replacement, test] of [
  [
    'state-query-error-fails-closed',
    "  } catch {\n    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)\n  }\n",
    "  } catch {\n    row = { capability_restrictions: [], id: customerId, status: 'active' }\n  }\n",
    'fails closed when evidence or account-state storage cannot be queried',
  ],
  [
    'state-row-required',
    "  if (!row) {\n    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)\n  }\n",
    "  if (false) {\n    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)\n  }\n",
    invalidStateTest,
  ],
  [
    'state-row-customer-match',
    '  if (positiveId(row.id) !== customerId) {\n',
    '  if (false) {\n',
    'requires the locked account-state row to belong to the claimed customer',
  ],
  [
    'state-status-whitelist',
    '  if ((CUSTOMER_ACCOUNT_STATUSES as readonly unknown[]).includes(value)) {\n',
    '  if (true) {\n',
    invalidStateTest,
  ],
  [
    'state-restrictions-parse-error',
    "  } catch {\n    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)\n  }\n  if (\n",
    '  } catch {\n    capabilityRestrictions = []\n  }\n  if (\n',
    invalidStateTest,
  ],
  [
    'restricted-state-requires-restrictions',
    "    (status === 'restricted' && capabilityRestrictions.length === 0) ||\n",
    '    false ||\n',
    'fails closed on inconsistent persisted status/restriction state before approving recovery',
  ],
  [
    'nonrestricted-state-forbids-restrictions',
    "    (status !== 'restricted' && capabilityRestrictions.length > 0)\n",
    '    false\n',
    'fails closed on inconsistent persisted status/restriction state before approving recovery',
  ],
  [
    'cooldown-timestamp-finite',
    '    if (!Number.isFinite(cooldownStartedAtMs)) {\n',
    '    if (false) {\n',
    invalidStateTest,
  ],
  [
    'approved-status-whitelist',
    "      if (!['active', 'restricted', 'suspended'].includes(state.status)) {\n",
    '      if (false) {\n',
    'rejects every non-recoverable account status without consuming the review',
  ],
]) {
  add({
    file: 'src/services/auth/account-recovery.ts',
    group: 'state',
    id,
    ...(id === 'state-query-error-fails-closed' ? { expectedOccurrences: 2, occurrence: 1 } : {}),
    replacement,
    search,
    test,
  })
}

for (const [id, search, replacement, test] of [
  [
    'claim-miss-fails-closed',
    '    if (!claimedRow) {\n',
    '    if (false) {\n',
    'keeps the review id, recovery reason, and open-status claim predicates behaviorally necessary',
  ],
  [
    'request-key-required',
    '  if (!requestKey) throw invalidEvidence()\n',
    '  if (false) throw invalidEvidence()\n',
    'requires a submitted event with a nonempty request key before consuming the conclusion',
  ],
  [
    'approved-branch-required',
    "    if (input.decision.conclusion === 'approved') {\n",
    '    if (false) {\n',
    mainApprovalTest,
  ],
  [
    'rejected-branch-has-no-approval-effects',
    "    if (input.decision.conclusion === 'approved') {\n",
    '    if (true) {\n',
    'records a rejected conclusion once without revoking sessions, notifying channels, or starting cooldown',
  ],
  [
    'suspended-restores-through-a3',
    "      if (state.status === 'suspended') {\n",
    '      if (false) {\n',
    mainApprovalTest,
  ],
  [
    'cooldown-duration',
    '        new Date(decidedAt).getTime() + getEnv().IDENTITY_RISK_COOLDOWN_SECONDS * 1_000,\n',
    '        new Date(decidedAt).getTime() + 0,\n',
    mainApprovalTest,
  ],
  [
    'revoke-all-sessions-invoked',
    "      revokedSessionCount = await revokeAllCustomerSessions(\n        req,\n        customerId,\n        'account_recovery_approved',\n      )\n",
    '      revokedSessionCount = 0\n',
    mainApprovalTest,
  ],
  [
    'old-identities-loaded',
    '      identities = await activeCustomerIdentities(req, customerId)\n',
    '      identities = []\n',
    mainApprovalTest,
  ],
  [
    'old-identities-required',
    '      if (identities.length === 0) {\n',
    '      if (false) {\n',
    'rolls back an approval when there is no old bound channel to notify',
  ],
  [
    'decision-record-event',
    "        eventType: 'review_concluded',\n",
    "        eventType: 'request_submitted',\n",
    mainApprovalTest,
  ],
  [
    'decision-record-conclusion',
    '        conclusion: input.decision.conclusion,\n',
    '        conclusion: undefined,\n',
    mainApprovalTest,
  ],
  [
    'decision-record-reviewer',
    '        reviewer: reviewerId,\n',
    '        reviewer: undefined,\n',
    mainApprovalTest,
  ],
  [
    'decision-record-note',
    '        decisionNote: input.decision.note,\n',
    '        decisionNote: undefined,\n',
    mainApprovalTest,
  ],
  [
    'decision-record-occurred-at',
    '        occurredAt: decidedAt,\n',
    "        occurredAt: '1970-01-01T00:00:00.000Z',\n",
    mainApprovalTest,
  ],
  [
    'decision-record-cooldown-start',
    '        cooldownStartedAt,\n',
    '        cooldownStartedAt: undefined,\n',
    mainApprovalTest,
  ],
  [
    'decision-record-cooldown-end',
    '        cooldownEndsAt,\n',
    '        cooldownEndsAt: undefined,\n',
    mainApprovalTest,
  ],
  [
    'decision-record-request-key',
    '        requestKey: request.requestKey,\n',
    "        requestKey: '',\n",
    mainApprovalTest,
  ],
  [
    'decision-record-revoked-count',
    '        revokedSessionCount,\n',
    '        revokedSessionCount: undefined,\n',
    mainApprovalTest,
  ],
  [
    'decision-security-event',
    "    await recordCustomerSecurityEvent(req, customerId, 'account_recovery_decided', {\n",
    "    await recordCustomerSecurityEvent(req, customerId, 'wrong_recovery_event', {\n",
    mainApprovalTest,
  ],
  [
    'decision-audit-action',
    "      action: 'customer.account_recovery.decided',\n",
    "      action: 'customer.account_state.changed',\n",
    mainApprovalTest,
  ],
  [
    'approved-notification-branch',
    "  if (result.conclusion === 'approved') {\n",
    '  if (false) {\n',
    mainApprovalTest,
  ],
  [
    'notify-every-old-identity',
    '    await notifyFormerCustomerIdentities(req, result.customerId, result.identities, input.traceId)\n',
    '    await notifyFormerCustomerIdentities(req, result.customerId, result.identities.slice(0, 1), input.traceId)\n',
    mainApprovalTest,
  ],
]) {
  add({
    file: 'src/services/auth/account-recovery.ts',
    group: 'decision',
    id,
    ...(new Set([
      'decision-record-conclusion',
      'decision-record-cooldown-start',
      'decision-record-cooldown-end',
      'decision-record-revoked-count',
    ]).has(id)
      ? { expectedOccurrences: 2, occurrence: 1 }
      : {}),
    replacement,
    search,
    test,
  })
}

for (const [id, search, replacement] of [
  [
    'evidence-realname-owner-join',
    '      INNER JOIN realname_templates\n        ON realname_templates.customer_id = customers.id\n',
    '      CROSS JOIN realname_templates\n',
  ],
  [
    'evidence-order-owner-join',
    '      INNER JOIN orders\n        ON orders.customer_id = customers.id\n',
    '      CROSS JOIN orders\n',
  ],
  [
    'evidence-payment-order-join',
    '      INNER JOIN payment_notifications\n        ON payment_notifications.order_id = orders.id\n',
    '      CROSS JOIN payment_notifications\n',
  ],
  ['evidence-customer-phone', '      WHERE customers.phone = ${phone}\n', '      WHERE TRUE\n'],
  [
    'evidence-realname-full-name',
    '        AND realname_templates.full_name_chinese = ${input.fullNameChinese}\n',
    '',
  ],
  [
    'evidence-realname-document',
    '        AND realname_templates.identity_document_number = ${input.identityDocumentNumber}\n',
    '',
  ],
  [
    'evidence-order-number',
    '        AND orders.order_number = ${input.historicalOrderNumber}\n',
    '',
  ],
  [
    'evidence-payment-transaction',
    '        AND payment_notifications.wechat_transaction_id = ${input.paymentTransactionId}\n',
    '',
  ],
  [
    'evidence-payment-signature',
    '        AND payment_notifications.signature_verified = TRUE\n',
    '',
  ],
  [
    'evidence-payment-confirmed',
    "        AND payment_notifications.confirmation_status = 'confirmed'\n",
    '',
  ],
]) {
  add({
    file: 'src/services/auth/account-recovery.ts',
    group: 'sql-evidence',
    id,
    replacement,
    search,
    test: evidenceTest,
  })
}

for (const [id, search, replacement, test] of [
  [
    'claim-review-id',
    '      WHERE id = ${input.reviewId}\n        AND reason_code = ${RECOVERY_REASON_CODE}\n',
    '      WHERE reason_code = ${RECOVERY_REASON_CODE}\n',
    'keeps the review id, recovery reason, and open-status claim predicates behaviorally necessary',
  ],
  [
    'claim-recovery-reason',
    '        AND reason_code = ${RECOVERY_REASON_CODE}\n',
    '',
    'keeps the review id, recovery reason, and open-status claim predicates behaviorally necessary',
  ],
  [
    'claim-open-status',
    "        AND status = 'open'\n",
    '',
    'keeps the review id, recovery reason, and open-status claim predicates behaviorally necessary',
  ],
  [
    'state-select-customer-id',
    '      WHERE id = ${customerId}\n      FOR UPDATE\n',
    '      FOR UPDATE\n',
    mainApprovalTest,
  ],
  [
    'request-record-review-id',
    "    WHERE manual_review_id = ${reviewId}\n      AND event_type = 'request_submitted'\n",
    "    WHERE event_type = 'request_submitted'\n",
    'fails closed when the immutable request record is missing realname_template_id',
  ],
  [
    'request-record-submitted-event',
    "      AND event_type = 'request_submitted'\n",
    '',
    'requires a submitted event with a nonempty request key before consuming the conclusion',
  ],
  [
    'request-record-realname-evidence',
    '      AND realname_template_id IS NOT NULL\n',
    '',
    'fails closed when the immutable request record is missing realname_template_id',
  ],
  [
    'request-record-order-evidence',
    '      AND order_id IS NOT NULL\n',
    '',
    'fails closed when the immutable request record is missing order_id',
  ],
  [
    'request-record-payment-evidence',
    '      AND payment_notification_id IS NOT NULL\n',
    '',
    'fails closed when the immutable request record is missing payment_notification_id',
  ],
  [
    'cooldown-customer-id',
    '    WHERE id = ${input.customerId}\n      AND status = ${input.expectedStatus}\n',
    '    WHERE status = ${input.expectedStatus}\n',
    'keeps every cooldown UPDATE CAS predicate behaviorally necessary',
  ],
  [
    'cooldown-expected-status',
    '      AND status = ${input.expectedStatus}\n',
    '',
    'keeps every cooldown UPDATE CAS predicate behaviorally necessary',
  ],
  [
    'cooldown-expected-restrictions',
    '      AND capability_restrictions = ${expectedRestrictionsJson}::jsonb\n',
    '',
    'keeps every cooldown UPDATE CAS predicate behaviorally necessary',
  ],
  [
    'cooldown-expected-prior-value',
    '      AND identity_risk_cooldown_started_at IS NOT DISTINCT FROM\n        ${input.expectedCooldownStartedAt ?? null}::timestamptz\n',
    '',
    'keeps every cooldown UPDATE CAS predicate behaviorally necessary',
  ],
]) {
  add({
    file: 'src/services/auth/account-recovery.ts',
    group: 'sql-state',
    id,
    replacement,
    search,
    test,
  })
}

for (const [id, search, replacement] of [
  [
    'session-revoke-customer-id',
    '      WHERE customer_id = ${customerId}\n        AND revoked_at IS NULL\n',
    '      WHERE revoked_at IS NULL\n',
  ],
  ['session-revoke-active-only', '        AND revoked_at IS NULL\n', ''],
]) {
  add({
    file: 'src/services/auth/customer-sessions.ts',
    group: 'sql-session',
    id,
    replacement,
    search,
    test: mainApprovalTest,
  })
}

for (const [id, search, replacement] of [
  [
    'identity-selection-customer',
    "      and: [{ customer: { equals: customerId } }, { status: { equals: 'active' } }],\n",
    "      and: [{ status: { equals: 'active' } }],\n",
  ],
  [
    'identity-selection-active-status',
    "      and: [{ customer: { equals: customerId } }, { status: { equals: 'active' } }],\n",
    '      and: [{ customer: { equals: customerId } }],\n',
  ],
]) {
  add({
    file: 'src/services/auth/customer-identities.ts',
    group: 'identity-notification',
    id,
    replacement,
    search,
    test: mainApprovalTest,
  })
}

for (const [label] of [
  ['domain management password'],
  ['domain lock disable'],
  ['Name Server change'],
  ['real-name information change'],
]) {
  add({
    file: 'src/services/auth/step-up.ts',
    group: 'cooldown-gate',
    id: `cooldown-${label.toLowerCase().replaceAll(' ', '-')}`,
    replacement: '',
    search: '    await assertIdentityRiskCooldownInactive(req, input.customerId)\n',
    test: `rejects only the ${label} action when that recovery cooldown case is exercised`,
  })
}

for (const [id, search, replacement, test] of [
  [
    'record-create-access-denied',
    '  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },\n',
    '  access: { create: () => true, delete: deny, read: systemAdminOnly, update: deny },\n',
    'keeps recovery-record create, update, and delete closed through collection access',
  ],
  [
    'record-update-access-denied',
    '  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },\n',
    '  access: { create: deny, delete: deny, read: systemAdminOnly, update: () => true },\n',
    'keeps recovery-record create, update, and delete closed through collection access',
  ],
  [
    'record-delete-access-denied',
    '  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },\n',
    '  access: { create: deny, delete: () => true, read: systemAdminOnly, update: deny },\n',
    'keeps recovery-record create, update, and delete closed through collection access',
  ],
  [
    'record-read-system-admin-only',
    '  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },\n',
    '  access: { create: deny, delete: deny, read: () => true, update: deny },\n',
    'keeps recovery records hidden from anonymous, customer, and non-system administrators',
  ],
  [
    'record-update-append-only-hook',
    "        if (operation === 'update') {\n",
    '        if (false) {\n',
    'keeps request and conclusion records append-only even for overrideAccess system calls',
  ],
  [
    'record-delete-append-only-hook',
    "      () => {\n        throw new AppError('ACCOUNT_RECOVERY_RECORD_APPEND_ONLY', '账户找回记录只允许追加', 409)\n      },\n",
    '      () => undefined,\n',
    'keeps request and conclusion records append-only even for overrideAccess system calls',
  ],
]) {
  add({
    file: 'src/collections/identity.ts',
    group: 'append-access',
    id,
    ...(id.endsWith('access-denied') || id === 'record-read-system-admin-only'
      ? { expectedOccurrences: 4, occurrence: 1 }
      : {}),
    ...(id === 'record-update-append-only-hook' ? { expectedOccurrences: 2, occurrence: 2 } : {}),
    replacement,
    search,
    test,
  })
}

for (const [id, search, replacement, test] of [
  [
    'requested-audit-actor-type',
    "  'customer.account_recovery.requested': {\n    actorTypes: ['anonymous'],\n",
    "  'customer.account_recovery.requested': {\n    actorTypes: ['anonymous', 'admin'],\n",
    'restricts recovery audit actions to their intended actor types',
  ],
  [
    'decided-audit-actor-type',
    "  'customer.account_recovery.decided': {\n    actorTypes: ['admin'],\n",
    "  'customer.account_recovery.decided': {\n    actorTypes: ['admin', 'anonymous'],\n",
    'restricts recovery audit actions to their intended actor types',
  ],
  [
    'requested-audit-target-type',
    "  'customer.account_recovery.requested': {\n    actorTypes: ['anonymous'],\n    targetType: 'customer',\n",
    "  'customer.account_recovery.requested': {\n    actorTypes: ['anonymous'],\n    targetType: 'admin-auth',\n",
    submissionTest,
  ],
  [
    'decided-audit-target-type',
    "  'customer.account_recovery.decided': {\n    actorTypes: ['admin'],\n    targetType: 'customer',\n",
    "  'customer.account_recovery.decided': {\n    actorTypes: ['admin'],\n    targetType: 'admin',\n",
    mainApprovalTest,
  ],
]) {
  add({
    file: 'src/services/audit/record-audit-event.ts',
    group: 'audit',
    id,
    replacement,
    search,
    test,
  })
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

function rawFailure(output) {
  const lines = stripAnsi(output).split('\n')
  const index = lines.findIndex((line) => line.includes('AssertionError:'))
  if (index >= 0)
    return lines
      .slice(index, index + 4)
      .join('\n')
      .trim()
  return lines.slice(-12).join('\n').trim()
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.file}\t${mutation.test}\n`)
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
  process.stderr.write(`No mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
const killedByGroup = new Map()
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
  if (mutated === original) {
    process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: source was unchanged\n`)
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
        mutation.testFile ?? integrationTest,
        '-t',
        mutation.test,
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }

  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim()
  const behaviorFailure = stripAnsi(output).includes('AssertionError:')
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.testFile ?? integrationTest} :: ${mutation.test}\n`)
  process.stdout.write(`RAW_FAILURE ${rawFailure(output)}\n`)
  if (result?.status !== 0 && behaviorFailure) {
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
    killedByGroup.set(mutation.group, (killedByGroup.get(mutation.group) ?? 0) + 1)
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write('\nMUTATION_MATRIX_SUMMARY\n')
for (const group of [...new Set(selected.map((mutation) => mutation.group))]) {
  const total = selected.filter((mutation) => mutation.group === group).length
  process.stdout.write(`${group}\t${killedByGroup.get(group) ?? 0}/${total}\n`)
}
process.stdout.write(
  `TOTAL\t${[...killedByGroup.values()].reduce((total, count) => total + count, 0)}/${selected.length}\n`,
)

if (failed) process.exitCode = 1
