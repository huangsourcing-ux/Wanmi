import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9a-account-closure.integration.test.ts'
const routeTest = 'tests/unit/account-closure-route.test.ts'
const guardTest = 'tests/unit/account-closure-service-guards.test.ts'

const serviceFile = 'src/services/auth/account-closure.ts'
const identityFile = 'src/services/auth/customer-identities.ts'
const schemaFile = 'src/schemas/auth.ts'
const collectionFile = 'src/collections/identity.ts'
const stepUpFile = 'src/services/auth/step-up.ts'

const schemaTest =
  'requires strict confirmations, bounded reasons and notes, one-time grant shape, and UUID ids'
const bodyTest =
  'rejects non-JSON, malformed, declared oversized, and actual oversized bodies on every route'
const gateTest = 'fails closed when the customer or system-admin gate rejects'
const routingTest =
  'routes request, revocation, and final execution through their distinct identity gates'
const actorTest =
  'enforces customer ownership and an active matching system-admin identity before any closure write'
const recordGuardTest =
  'rejects missing, unreadable, malformed-id, malformed-blocker, and malformed-time requested records'
const finalExecutionTest =
  'allows exactly one final execution, closes through A3, and enforces persisted rebind time'
const wechatRegistrationRebindTest =
  'rejects full Wechat registration with a released openid before its rebind cooldown'
const auditTest =
  'records request, revocation, execution, and blocked-review audit and security events'
const accessTest = 'keeps closure records append-only and customer reads owner-scoped'
const rebindTest =
  'keeps every released-identity provider, instance, hash, precedence, timestamp, and cooldown decision necessary'

const mutations = []
function add({ file = serviceFile, id, replacement, search, test, testFile = integrationTest }) {
  mutations.push({ file, id, replacement, search, test, testFile })
}

for (const mutation of [
  {
    id: 'request-confirmation-required',
    search: "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n",
    replacement: "    confirmation: z.literal('DELETE_MY_ACCOUNT').optional(),\n",
  },
  {
    id: 'request-confirmation-literal',
    search: "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n",
    replacement: '    confirmation: z.string(),\n',
  },
  {
    id: 'request-device-required',
    search:
      "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n    deviceId: z.string().min(16).max(128),\n    reason:",
    replacement:
      "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n    deviceId: z.string().min(16).max(128).optional(),\n    reason:",
  },
  {
    id: 'request-device-minimum',
    search:
      "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n    deviceId: z.string().min(16).max(128),\n    reason:",
    replacement:
      "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n    deviceId: z.string().min(5).max(128),\n    reason:",
  },
  {
    id: 'request-device-maximum',
    search:
      "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n    deviceId: z.string().min(16).max(128),\n    reason:",
    replacement:
      "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n    deviceId: z.string().min(16).max(129),\n    reason:",
  },
  {
    id: 'request-reason-required',
    search:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken:',
    replacement:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().trim().min(3).max(1_000).optional(),\n    stepUpToken:',
  },
  {
    id: 'request-reason-trim',
    search:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken:',
    replacement:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().min(3).max(1_000),\n    stepUpToken:',
  },
  {
    id: 'request-reason-minimum',
    search:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken:',
    replacement:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().trim().min(1).max(1_000),\n    stepUpToken:',
  },
  {
    id: 'request-reason-maximum',
    search:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken:',
    replacement:
      '    deviceId: z.string().min(16).max(128),\n    reason: z.string().trim().min(3).max(1_001),\n    stepUpToken:',
  },
  {
    id: 'request-grant-required',
    search:
      '    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n  })',
    replacement:
      '    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),\n  })',
  },
  {
    id: 'request-grant-shape',
    search:
      '    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n  })',
    replacement:
      '    reason: z.string().trim().min(3).max(1_000),\n    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{42,43}$/u),\n  })',
  },
  {
    id: 'request-schema-strict',
    search: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n  })\n  .strict()\n',
    replacement:
      '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n  })\n  .passthrough()\n',
  },
  {
    id: 'revoke-confirmation-required',
    search: "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n",
    replacement: "    confirmation: z.literal('KEEP_MY_ACCOUNT').optional(),\n",
  },
  {
    id: 'revoke-confirmation-literal',
    search: "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n",
    replacement: '    confirmation: z.string(),\n',
  },
  {
    id: 'revoke-reason-required',
    search:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().trim().min(3).max(1_000),\n  })",
    replacement:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().trim().min(3).max(1_000).optional(),\n  })",
  },
  {
    id: 'revoke-reason-trim',
    search:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().trim().min(3).max(1_000),\n  })",
    replacement:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().min(3).max(1_000),\n  })",
  },
  {
    id: 'revoke-reason-minimum',
    search:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().trim().min(3).max(1_000),\n  })",
    replacement:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().trim().min(1).max(1_000),\n  })",
  },
  {
    id: 'revoke-reason-maximum',
    search:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().trim().min(3).max(1_000),\n  })",
    replacement:
      "    confirmation: z.literal('KEEP_MY_ACCOUNT'),\n    reason: z.string().trim().min(3).max(1_001),\n  })",
  },
  {
    id: 'revoke-schema-strict',
    search:
      '    reason: z.string().trim().min(3).max(1_000),\n  })\n  .strict()\n\nexport const accountClosureRevokeResponseSchema',
    replacement:
      '    reason: z.string().trim().min(3).max(1_000),\n  })\n  .passthrough()\n\nexport const accountClosureRevokeResponseSchema',
  },
  {
    id: 'execute-confirmation-required',
    search: "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n",
    replacement: "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE').optional(),\n",
  },
  {
    id: 'execute-confirmation-literal',
    search: "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n",
    replacement: '    confirmation: z.string(),\n',
  },
  {
    id: 'execute-note-required',
    search:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().trim().min(3).max(2_000),\n  })",
    replacement:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().trim().min(3).max(2_000).optional(),\n  })",
  },
  {
    id: 'execute-note-trim',
    search:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().trim().min(3).max(2_000),\n  })",
    replacement:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().min(3).max(2_000),\n  })",
  },
  {
    id: 'execute-note-minimum',
    search:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().trim().min(3).max(2_000),\n  })",
    replacement:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().trim().min(1).max(2_000),\n  })",
  },
  {
    id: 'execute-note-maximum',
    search:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().trim().min(3).max(2_000),\n  })",
    replacement:
      "    confirmation: z.literal('EXECUTE_ACCOUNT_CLOSURE'),\n    note: z.string().trim().min(3).max(2_001),\n  })",
  },
  {
    id: 'execute-schema-strict',
    search:
      '    note: z.string().trim().min(3).max(2_000),\n  })\n  .strict()\n\nexport const accountClosureExecuteResponseSchema',
    replacement:
      '    note: z.string().trim().min(3).max(2_000),\n  })\n  .passthrough()\n\nexport const accountClosureExecuteResponseSchema',
  },
  {
    id: 'request-id-uuid',
    search:
      "export const accountClosureRequestIdSchema = z\n  .uuid()\n  .refine((value) => value !== '00000000-0000-0000-0000-000000000000')\n",
    replacement:
      "export const accountClosureRequestIdSchema = z\n  .string()\n  .refine((value) => value !== '00000000-0000-0000-0000-000000000000')\n",
  },
  {
    id: 'request-id-nonzero',
    search: "  .refine((value) => value !== '00000000-0000-0000-0000-000000000000')\n",
    replacement: '',
    test: 'rejects invalid request ids before authentication',
  },
]) {
  add({ ...mutation, file: schemaFile, test: mutation.test ?? schemaTest, testFile: routeTest })
}

function addRouteMutations(file, validBody, gateSearch, gateReplacement, gateId) {
  add({
    file,
    id: `${gateId}-content-type`,
    replacement: '  if (false) {\n',
    search:
      "  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {\n",
    test: bodyTest,
    testFile: routeTest,
  })
  const condition =
    '!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES'
  for (const [id, atom] of [
    ['declared-finite', '!Number.isFinite(declaredLength)'],
    ['declared-nonnegative', 'declaredLength < 0'],
    ['declared-maximum', 'declaredLength > MAX_BODY_BYTES'],
  ]) {
    add({
      file,
      id: `${gateId}-${id}`,
      replacement: `  if (${condition.replace(atom, 'false')}) {\n`,
      search: `  if (${condition}) {\n`,
      test: bodyTest,
      testFile: routeTest,
    })
  }
  add({
    file,
    id: `${gateId}-actual-maximum`,
    replacement: '  if (false) {\n',
    search: '  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {\n',
    test: bodyTest,
    testFile: routeTest,
  })
  add({
    file,
    id: `${gateId}-malformed-json`,
    replacement: `  } catch {\n    return ${validBody}\n  }\n`,
    search: "  } catch {\n    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)\n  }\n",
    test: bodyTest,
    testFile: routeTest,
  })
  add({
    file,
    id: `${gateId}-identity-gate`,
    replacement: gateReplacement,
    search: gateSearch,
    test: gateTest,
    testFile: routeTest,
  })
}

addRouteMutations(
  'src/app/api/v1/auth/deletion-request/route.ts',
  "{ confirmation: 'DELETE_MY_ACCOUNT', deviceId: 'device-fixture-1234567890', reason: '不再使用这个账号', stepUpToken: 'A'.repeat(43) }",
  '    const { req, user } = await authenticatedCustomerRequest(payload, request)\n',
  "    const req = { headers: request.headers, payload: {} } as never\n    const user = { collection: 'customers', id: 9 } as never\n",
  'request-route',
)
addRouteMutations(
  'src/app/api/v1/account/closure-requests/[requestId]/revoke/route.ts',
  "{ confirmation: 'KEEP_MY_ACCOUNT', reason: '暂时继续使用账号' }",
  '    const { req, user } = await authenticatedCustomerRequest(payload, request)\n',
  "    const req = { headers: request.headers, payload: {} } as never\n    const user = { collection: 'customers', id: 9 } as never\n",
  'revoke-route',
)
addRouteMutations(
  'src/app/api/v1/admin/account-closures/[requestId]/execute/route.ts',
  "{ confirmation: 'EXECUTE_ACCOUNT_CLOSURE', note: '全部阻塞项与冷静期已复核' }",
  '    const { req, user } = await systemAdminRequest(payload, request)\n',
  "    const req = { headers: request.headers, payload: {} } as never\n    const user = { collection: 'admins', id: 7 } as never\n",
  'execute-route',
)
add({
  file: 'src/app/api/v1/auth/deletion-request/route.ts',
  id: 'request-route-accepted-status',
  replacement:
    '    return successResponse(customerDeletionResponseSchema.parse(result), traceId, { status: 200 })\n',
  search:
    '    return successResponse(customerDeletionResponseSchema.parse(result), traceId, { status: 202 })\n',
  test: routingTest,
  testFile: routeTest,
})

for (const [id, search, replacement, test, testFile = integrationTest] of [
  [
    'unavailable-blocker-mapping',
    '  return `${blocker}_check_unavailable` as AccountClosureBlocker\n',
    '  return blocker\n',
    'fails closed as domains_held_check_unavailable when that query fails',
  ],
  [
    'positive-id-safe-integer',
    '  if (Number.isSafeInteger(id) && id > 0) return id\n',
    '  if (true && id > 0) return id\n',
    recordGuardTest,
    guardTest,
  ],
  [
    'positive-id-positive',
    '  if (Number.isSafeInteger(id) && id > 0) return id\n',
    '  if (Number.isSafeInteger(id) && true) return id\n',
    recordGuardTest,
    guardTest,
  ],
  [
    'database-boolean-true',
    '  if (value === true || value === false) return value\n',
    '  if (false || value === false) return value\n',
    'blocks with only domains_held when only that precondition is present',
  ],
  [
    'database-boolean-false',
    '  if (value === true || value === false) return value\n',
    '  if (value === true || false) return value\n',
    'returns no blockers for a clean active account',
  ],
  [
    'precondition-true-branch',
    '      if (await check(database, customerId)) blockers.push(blocker)\n',
    '      if (false) blockers.push(blocker)\n',
    'blocks with only domains_held when only that precondition is present',
  ],
  [
    'precondition-failure-branch',
    '    } catch {\n      blockers.push(unavailableBlocker(blocker))\n    }\n',
    '    } catch {\n      // mutation: incorrectly ignore the unavailable check\n    }\n',
    'fails closed as domains_held_check_unavailable when that query fails',
  ],
  [
    'stored-blockers-array',
    '    !Array.isArray(value) ||\n',
    '    false ||\n',
    recordGuardTest,
    guardTest,
  ],
  [
    'stored-blockers-unique',
    '    new Set(value).size !== value.length ||\n',
    '    false ||\n',
    recordGuardTest,
    guardTest,
  ],
  [
    'stored-blockers-known-values',
    '      (ACCOUNT_CLOSURE_BLOCKERS as readonly unknown[]).includes(item),\n',
    '      true,\n',
    recordGuardTest,
    guardTest,
  ],
  [
    'stored-timestamp-finite',
    '  if (!Number.isFinite(timestamp)) {\n',
    '  if (false) {\n',
    recordGuardTest,
    guardTest,
  ],
  [
    'requested-query-failure',
    "  } catch {\n    throw new AppError('ACCOUNT_CLOSURE_STATE_UNAVAILABLE', '账户关闭状态暂时无法核验', 503)\n  }\n  if (!row) {\n",
    '  } catch {\n    row = undefined\n  }\n  if (!row) {\n',
    recordGuardTest,
    guardTest,
  ],
  [
    'requested-row-required',
    "  if (!row) {\n    throw new AppError('ACCOUNT_CLOSURE_REQUEST_NOT_FOUND'",
    "  if (false) {\n    throw new AppError('ACCOUNT_CLOSURE_REQUEST_NOT_FOUND'",
    recordGuardTest,
    guardTest,
  ],
]) {
  add({ file: serviceFile, id, replacement, search, test, testFile })
}

for (const [id, search, replacement] of [
  [
    'customer-actor-kind',
    '  if (isCustomerUser(req.user) && String(req.user.id) === String(customerId)) return\n',
    '  if (true && String(req.user?.id) === String(customerId)) return\n',
  ],
  [
    'customer-actor-id',
    '  if (isCustomerUser(req.user) && String(req.user.id) === String(customerId)) return\n',
    '  if (isCustomerUser(req.user) && true) return\n',
  ],
  ['admin-system-role', "    hasRole(req.user, ['system_admin']) &&\n", '    true &&\n'],
  ['admin-matching-id', '    String(req.user?.id) === String(actorId) &&\n', '    true &&\n'],
  ['admin-id-safe-integer', '    Number.isSafeInteger(id) &&\n', '    true &&\n'],
  ['admin-id-positive', '    id > 0\n', '    true\n'],
]) {
  add({ id, replacement, search, test: actorTest })
}

for (const [id, search, replacement, test, testFile = integrationTest] of [
  ['requested-record-key-kind', "    input.eventType === 'requested'\n", '    false\n', accessTest],
  [
    'nonrequested-record-key-uniqueness',
    '      : `${input.requestKey}:${input.eventType}:${randomUUID()}`\n',
    '      : `${input.requestKey}:${input.eventType}`\n',
    'appends a distinct immutable blocker refresh on every blocked retry',
  ],
  [
    'request-customer-actor-call',
    '  assertCustomerActor(req, customer.id)\n  if (customer.status',
    '  if (customer.status',
    actorTest,
  ],
  [
    'revoke-customer-actor-call',
    '  assertCustomerActor(req, customer.id)\n  return inAuthTransaction(req, async () => {\n    const request = await requestedClosure(req, input.requestId)\n',
    '  return inAuthTransaction(req, async () => {\n    const request = await requestedClosure(req, input.requestId)\n',
    actorTest,
  ],
  [
    'request-active-source-state',
    "  if (customer.status !== 'active' && customer.status !== 'restricted') {\n",
    "  if (false && customer.status !== 'restricted') {\n",
    'rejects deletion source states before attempting step-up authorization',
    'tests/integration/d9a-account-state.integration.test.ts',
  ],
  [
    'request-restricted-source-state',
    "  if (customer.status !== 'active' && customer.status !== 'restricted') {\n",
    "  if (customer.status !== 'active' && false) {\n",
    'rejects deletion source states before attempting step-up authorization',
    'tests/integration/d9a-account-state.integration.test.ts',
  ],
  [
    'step-up-customer-id',
    '      customerId: customer.id,\n      deviceId: input.deviceId,\n',
    '      customerId: Number(customer.id) + 1,\n      deviceId: input.deviceId,\n',
    'requires a fresh one-time deletion grant for every new closure request',
  ],
  [
    'step-up-device-id',
    '      deviceId: input.deviceId,\n      headers: req.headers,\n',
    "      deviceId: 'mutated-device',\n      headers: req.headers,\n",
    'requires a fresh one-time deletion grant for every new closure request',
  ],
  [
    'step-up-purpose',
    "      purpose: 'account_deletion',\n",
    "      purpose: 'identity_bind',\n",
    'requires a fresh one-time deletion grant for every new closure request',
  ],
  [
    'step-up-token',
    '      stepUpToken: input.stepUpToken,\n',
    "      stepUpToken: 'mutated-token',\n",
    'requires a fresh one-time deletion grant for every new closure request',
  ],
  [
    'step-up-authorization-required',
    "    const grant = await authorizeStepUpGrant(req, {\n      customerId: customer.id,\n      deviceId: input.deviceId,\n      headers: req.headers,\n      purpose: 'account_deletion',\n      stepUpToken: input.stepUpToken,\n    })\n",
    '    const grant = { grantId: 0 }\n',
    'requires a fresh one-time deletion grant for every new closure request',
  ],
  [
    'request-claim-returned-row',
    '    if (claimed.rows?.[0]?.id === undefined) {\n',
    '    if (false) {\n',
    'keeps every request-claim id, allowed-status, no-active-request, and no-execution-claim predicate necessary',
  ],
  [
    'revocation-request-owner',
    '    if (request.customerId !== customer.id) {\n',
    '    if (false) {\n',
    actorTest,
  ],
  [
    'revocation-returned-row',
    '    if (revoked.rows?.[0]?.id === undefined) {\n',
    '    if (false) {\n',
    'keeps every revocation id, request-key, no-execution-claim, allowed-status, and returned-row predicate necessary',
  ],
  [
    'execution-claim-returned-row',
    "  if (!row) {\n    throw new AppError(\n      'ACCOUNT_CLOSURE_EXECUTION_ALREADY_CONSUMED'",
    "  if (false) {\n    throw new AppError(\n      'ACCOUNT_CLOSURE_EXECUTION_ALREADY_CONSUMED'",
    'keeps every execution-claim id, request-key, unclaimed, allowed-status, and returned-row predicate necessary',
  ],
  [
    'release-claim-returned-row',
    '  if (String(released.rows?.[0]?.id) !== String(request.customerId)) {\n',
    '  if (false) {\n',
    'fails closed when releasing a blocked execution claim returns no target row',
    guardTest,
  ],
  [
    'anonymization-returned-row',
    '  if (String(anonymized.rows?.[0]?.id) !== String(input.customerId)) {\n',
    '  if (false) {\n',
    'fails closed when final anonymization returns no target row',
    guardTest,
  ],
  [
    'closure-cooldown-comparison',
    '    if (new Date(request.cooldownEndsAt).getTime() > new Date(claimedAt).getTime()) {\n',
    '    if (false) {\n',
    'refuses final execution during the persisted closure cooldown and releases its claim',
  ],
  [
    'closure-cooldown-blocker',
    "      blockers.unshift('closure_cooldown_active')\n",
    '',
    'refuses final execution during the persisted closure cooldown and releases its claim',
  ],
  [
    'any-blocker-early-return',
    '    if (blockers.length > 0) {\n',
    '    if (false) {\n',
    'refuses final execution with only the fresh domains_held blocker',
  ],
]) {
  add({ file: serviceFile, id, replacement, search, test, testFile })
}

add({
  file: 'src/lib/domain.ts',
  id: 'account-deletion-one-time-classification',
  replacement: "export const ONE_TIME_STEP_UP_PURPOSES = ['realname_change'] as const\n",
  search:
    "export const ONE_TIME_STEP_UP_PURPOSES = ['realname_change', 'account_deletion'] as const\n",
  test: 'requires a fresh one-time deletion grant for every new closure request',
})
add({
  file: stepUpFile,
  id: 'identity-risk-cooldown-required',
  replacement: '',
  search: '    await assertIdentityRiskCooldownInactive(req, input.customerId)\n',
  test: 'rejects a closure request during the shared identity-risk cooldown',
})

for (const mutation of [
  {
    id: 'first-transition-expected-status',
    search:
      "      expectedStatus: claim.status,\n      reason: 'account_closure_execution_started',\n",
    replacement:
      "      expectedStatus: 'closing',\n      reason: 'account_closure_execution_started',\n",
  },
  {
    id: 'first-transition-closing-target',
    search:
      "      restrictions: [],\n      status: 'closing',\n    })\n    const disabledTemplateCount",
    replacement:
      "      restrictions: [],\n      status: 'closed',\n    })\n    const disabledTemplateCount",
  },
  {
    id: 'disable-realname-templates',
    search:
      "    const disabledTemplateCount = await disableCustomerRealnameTemplates(req, {\n      actor: { id: actorId, type: 'admin' },\n      customerId: request.customerId,\n      startedAt: claimedAt,\n    })\n",
    replacement: '    const disabledTemplateCount = 0\n',
  },
  {
    id: 'identity-rebind-duration',
    search:
      '      new Date(claimedAt).getTime() + getEnv().IDENTITY_REBIND_COOLDOWN_SECONDS * 1_000,\n',
    replacement: '      new Date(claimedAt).getTime(),\n',
  },
  {
    id: 'release-identities',
    search:
      '    const releasedIdentityCount = await releaseCustomerIdentities(req, {\n      customerId: request.customerId,\n      rebindAllowedAt: identityRebindAllowedAt,\n      releasedAt: claimedAt,\n      requestKey: input.requestId,\n    })\n',
    replacement: '    const releasedIdentityCount = 0\n',
  },
  {
    id: 'second-transition-expected-closing',
    search:
      "      expectedStatus: 'closing',\n      reason: 'account_closure_preconditions_satisfied',\n",
    replacement:
      "      expectedStatus: 'active',\n      reason: 'account_closure_preconditions_satisfied',\n",
  },
  {
    id: 'second-transition-closed-target',
    search:
      "      reason: 'account_closure_preconditions_satisfied',\n      restrictions: [],\n      status: 'closed',\n",
    replacement:
      "      reason: 'account_closure_preconditions_satisfied',\n      restrictions: [],\n      status: 'closing',\n",
  },
  {
    id: 'anonymize-final-profile',
    search:
      '    await anonymizeClosedCustomer(req, {\n      claimedAt,\n      customerId: request.customerId,\n      requestKey: input.requestId,\n    })\n',
    replacement: '',
  },
  {
    id: 'executed-record-event-type',
    search: "      eventType: 'executed',\n      executedAt: claimedAt,\n",
    replacement: "      eventType: 'blockers_refreshed',\n      executedAt: claimedAt,\n",
  },
  {
    id: 'retention-realname-deadline',
    search: '      realnamePrimaryAndBackupDeletionDeadlineDays: 30,\n',
    replacement: '      realnamePrimaryAndBackupDeletionDeadlineDays: 0,\n',
  },
]) {
  add({ ...mutation, test: finalExecutionTest })
}

for (const [id, search, replacement] of [
  [
    'request-audit-action',
    "      action: 'customer.account_closure.requested',\n",
    "      action: 'customer.account_closure.revoked',\n",
  ],
  [
    'revoke-audit-action',
    "      action: 'customer.account_closure.revoked',\n",
    "      action: 'customer.account_closure.requested',\n",
  ],
  [
    'blocked-audit-action',
    "        action: 'customer.account_closure.blockers_refreshed',\n",
    "        action: 'customer.account_closure.executed',\n",
  ],
  [
    'execute-audit-action',
    "      action: 'customer.account_closure.executed',\n",
    "      action: 'customer.account_closure.requested',\n",
  ],
  [
    'request-security-event',
    "    await recordCustomerSecurityEvent(req, customer.id, 'account_closure_requested', {\n",
    "    await recordCustomerSecurityEvent(req, customer.id, 'account_closure_requested_mutant', {\n",
  ],
  [
    'revoke-security-event',
    "    await recordCustomerSecurityEvent(req, customer.id, 'account_closure_revoked', {\n",
    "    await recordCustomerSecurityEvent(req, customer.id, 'account_closure_revoked_mutant', {\n",
  ],
  [
    'execute-security-event',
    "    await recordCustomerSecurityEvent(req, request.customerId, 'account_closure_executed', {\n",
    "    await recordCustomerSecurityEvent(req, request.customerId, 'account_closure_executed_mutant', {\n",
  ],
]) {
  add({ id, replacement, search, test: auditTest })
}

for (const mutation of [
  {
    id: 'collection-create-access',
    search:
      "export const AccountClosureRequests: CollectionConfig = {\n  slug: 'accountClosureRequests',\n  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },\n",
    replacement:
      "export const AccountClosureRequests: CollectionConfig = {\n  slug: 'accountClosureRequests',\n  access: { create: () => true, delete: deny, read: ownOrSystem('customer'), update: deny },\n",
  },
  {
    id: 'collection-read-access',
    search:
      "export const AccountClosureRequests: CollectionConfig = {\n  slug: 'accountClosureRequests',\n  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },\n",
    replacement:
      "export const AccountClosureRequests: CollectionConfig = {\n  slug: 'accountClosureRequests',\n  access: { create: deny, delete: deny, read: () => true, update: deny },\n",
  },
  {
    id: 'append-only-update-hook',
    search:
      "        if (operation === 'update') {\n          throw new AppError('ACCOUNT_CLOSURE_RECORD_APPEND_ONLY'",
    replacement:
      "        if (false) {\n          throw new AppError('ACCOUNT_CLOSURE_RECORD_APPEND_ONLY'",
  },
  {
    id: 'append-only-delete-hook',
    search:
      "      () => {\n        throw new AppError('ACCOUNT_CLOSURE_RECORD_APPEND_ONLY', '账户关闭记录只允许追加', 409)\n      },\n",
    replacement: '      () => undefined,\n',
  },
  {
    id: 'blockers-array-validation',
    search: '  return Array.isArray(value) &&\n',
    replacement: '  return true &&\n',
    test: 'rejects non-array, duplicate, unknown, and non-string persisted blocker lists',
  },
  {
    id: 'blockers-unique-validation',
    search: '    new Set(value).size === value.length &&\n',
    replacement: '    true &&\n',
    test: 'rejects non-array, duplicate, unknown, and non-string persisted blocker lists',
  },
  {
    id: 'blockers-known-validation',
    search:
      '    value.every((item) => (ACCOUNT_CLOSURE_BLOCKERS as readonly unknown[]).includes(item))\n',
    replacement: '    value.every(() => true)\n',
    test: 'rejects non-array, duplicate, unknown, and non-string persisted blocker lists',
  },
  {
    id: 'reason-sensitive-field-access',
    search:
      "    { name: 'reason', type: 'textarea', access: { read: sensitiveFieldRead }, required: true },\n",
    replacement: "    { name: 'reason', type: 'textarea', required: true },\n",
  },
]) {
  add({
    ...mutation,
    file: collectionFile,
    test: mutation.test ?? accessTest,
  })
}

for (const [id, search, replacement, test = rebindTest] of [
  [
    'rebind-query-failure',
    "    } catch {\n      throw new AppError('IDENTITY_REBIND_STATE_UNAVAILABLE'",
    "    } catch {\n      row = undefined\n      if (false) throw new AppError('IDENTITY_REBIND_STATE_UNAVAILABLE'",
  ],
  ['rebind-no-row', '    if (!row) return\n', '    if (false) return\n'],
  [
    'rebind-current-bound-guard',
    '    if (row.identifier_hash === input.identifierHash) {\n',
    '    if (false) {\n',
  ],
  [
    'rebind-released-hash-guard',
    '    if (row.released_identifier_hash !== input.identifierHash) {\n',
    '    if (false) {\n',
  ],
  [
    'rebind-timestamp-finite',
    '    if (!Number.isFinite(rebindAllowedAt)) {\n',
    '    if (false) {\n',
  ],
  [
    'rebind-expiry-allow',
    '    if (rebindAllowedAt <= Date.now()) return\n',
    '    if (false) return\n',
  ],
  [
    'phone-auth-rebind-check',
    "  await assertReleasedIdentityRebindAllowed(req, {\n    identifierHash,\n    provider: 'phone',\n    providerInstanceId,\n  })\n",
    '',
    finalExecutionTest,
  ],
  [
    'wechat-auth-rebind-check',
    "  await assertReleasedIdentityRebindAllowed(req, {\n    identifierHash,\n    provider: 'wechat',\n    providerInstanceId,\n  })\n",
    '',
    finalExecutionTest,
  ],
  [
    'registration-phone-rebind-check',
    '      await assertReleasedIdentityRebindAllowed(req, {\n        identifierHash: phoneIntent.identifierHash,\n        provider: phoneIntent.provider,\n        providerInstanceId: phoneIntent.providerInstanceId,\n      })\n',
    '',
    finalExecutionTest,
  ],
  [
    'registration-primary-rebind-check',
    '        await assertReleasedIdentityRebindAllowed(req, {\n          identifierHash: primary.identifierHash,\n          provider: primary.provider,\n          providerInstanceId: primary.providerInstanceId,\n        })\n',
    '',
    wechatRegistrationRebindTest,
  ],
  [
    'binding-rebind-check',
    '      await assertReleasedIdentityRebindAllowed(req, {\n        identifierHash: intent.identifierHash,\n        provider: intent.provider,\n        providerInstanceId: intent.providerInstanceId,\n      })\n',
    '',
    finalExecutionTest,
  ],
]) {
  add({ file: identityFile, id, replacement, search, test })
}

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
  const source = readFileSync(`${webRoot}/${mutation.file}`, 'utf8')
  const found = occurrences(source, mutation.search)
  if (found !== 1) {
    process.stderr.write(
      `MUTATION SETUP FAILED ${mutation.id}: expected 1 occurrence, found ${found}\n`,
    )
    failed = true
  }
}
if (failed) process.exit(1)
if (process.env.A6_MUTATION_PREFLIGHT === '1') process.exit(0)

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

process.stdout.write(
  `\nA6_SECURITY_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${mutations.length}\n`,
)
if (failed) process.exitCode = 1
