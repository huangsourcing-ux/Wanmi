import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const accountStateTest = 'tests/integration/d9a-account-state.integration.test.ts'
const routeTest = 'tests/unit/account-security-route.test.ts'
const domainRouteTest = 'tests/unit/domain-assets-route.test.ts'
const domainIntegrationTest = 'tests/integration/domain-assets.integration.test.ts'
const registrationTest = 'tests/integration/d9a-identity-registration.integration.test.ts'

const mutations = [
  {
    group: 'actor',
    id: 'actor-system-requires-empty-req-user',
    file: 'src/services/auth/account-state.ts',
    search: '    if (!req.user) return\n',
    replacement: '    return\n',
    test: 'rejects a system actor whenever req.user is present',
  },
  {
    group: 'actor',
    id: 'actor-admin-requires-system-admin-role',
    file: 'src/services/auth/account-state.ts',
    search:
      "    if (hasRole(req.user, ['system_admin']) && String(req.user?.id) === String(actor.id)) {\n",
    replacement: '    if (true && String(req.user?.id) === String(actor.id)) {\n',
    test: 'rejects an admin actor without the system_admin role',
  },
  {
    group: 'actor',
    id: 'actor-admin-id-matches-session',
    file: 'src/services/auth/account-state.ts',
    search:
      "    if (hasRole(req.user, ['system_admin']) && String(req.user?.id) === String(actor.id)) {\n",
    replacement: "    if (hasRole(req.user, ['system_admin']) && true) {\n",
    test: 'rejects an admin actor whose asserted id does not match the authenticated admin',
  },
  {
    group: 'actor',
    id: 'actor-customer-requires-customer-principal',
    file: 'src/services/auth/account-state.ts',
    search: '    isCustomerUser(req.user) &&\n',
    replacement: '    true &&\n',
    test: 'rejects a customer actor when the authenticated principal is not a customer',
  },
  {
    group: 'actor',
    id: 'actor-customer-id-matches-session',
    file: 'src/services/auth/account-state.ts',
    search: '    String(req.user.id) === String(actor.id) &&\n',
    replacement: '    true &&\n',
    test: 'rejects a customer actor id that does not match the authenticated customer',
  },
  {
    group: 'actor',
    id: 'actor-customer-owns-target-customer-id',
    file: 'src/services/auth/account-state.ts',
    search: '    String(req.user.id) === String(customerId) &&\n',
    replacement: '    true &&\n',
    test: 'rejects a customer changing another customerId even with a matching actor id',
  },
  {
    group: 'actor',
    id: 'actor-customer-source-active-or-restricted',
    file: 'src/services/auth/account-state.ts',
    search: "    (from === 'active' || from === 'restricted') &&\n",
    replacement: '    true &&\n',
    test: 'rejects customer self-service from non active or restricted source states',
  },
  {
    group: 'actor',
    id: 'actor-customer-target-closing-only',
    file: 'src/services/auth/account-state.ts',
    search: "    to === 'closing'\n",
    replacement: '    true\n',
    test: 'rejects customer targets other than closing',
  },
  {
    group: 'actor',
    id: 'transition-invokes-actor-guard',
    file: 'src/services/auth/account-state.ts',
    search:
      '  assertActorAllowed(req, input.customerId, input.actor, input.expectedStatus, input.status)\n',
    replacement: '',
    test: 'rejects an admin actor without the system_admin role',
  },
  {
    group: 'actor',
    id: 'session-security-action-invokes-actor-guard',
    file: 'src/services/auth/account-state.ts',
    search: "  assertActorAllowed(req, input.customerId, input.actor, 'active', 'active')\n",
    replacement: '',
    test: 'rejects unauthorized use of the one-action security session revocation service',
  },
  {
    group: 'actor',
    id: 'whole-actor-guard-not-empty',
    file: 'src/services/auth/account-state.ts',
    search:
      "  if (actor.type === 'system') {\n    if (!req.user) return\n  } else if (actor.type === 'admin') {\n    if (hasRole(req.user, ['system_admin']) && String(req.user?.id) === String(actor.id)) {\n      return\n    }\n  } else if (\n    isCustomerUser(req.user) &&\n    String(req.user.id) === String(actor.id) &&\n    String(req.user.id) === String(customerId) &&\n    (from === 'active' || from === 'restricted') &&\n    to === 'closing'\n  ) {\n    return\n  }\n  throw new AppError('ACCOUNT_STATE_CHANGE_FORBIDDEN', '无权变更该账号状态', 403)\n",
    replacement: '  return\n',
    test: 'rejects an admin actor without the system_admin role',
  },
  {
    group: 'invariant',
    id: 'restricted-state-requires-nonempty-restrictions',
    file: 'src/services/auth/account-state.ts',
    search:
      "  if (status === 'restricted' ? restrictions.length > 0 : restrictions.length === 0) return\n",
    replacement: "  if (status === 'restricted' ? true : restrictions.length === 0) return\n",
    test: 'rejects an empty restriction set for a restricted target state',
  },
  {
    group: 'invariant',
    id: 'nonrestricted-state-requires-empty-restrictions',
    file: 'src/services/auth/account-state.ts',
    search:
      "  if (status === 'restricted' ? restrictions.length > 0 : restrictions.length === 0) return\n",
    replacement: "  if (status === 'restricted' ? restrictions.length > 0 : true) return\n",
    test: 'rejects restrictions on a non-restricted target state',
  },
  {
    group: 'invariant',
    id: 'whole-state-restriction-invariant-not-empty',
    file: 'src/services/auth/account-state.ts',
    search:
      "  if (status === 'restricted' ? restrictions.length > 0 : restrictions.length === 0) return\n  throw new AppError(\n    'ACCOUNT_STATE_RESTRICTIONS_MISMATCH',\n    status === 'restricted'\n      ? 'restricted 状态必须至少限制一项能力'\n      : '只有 restricted 状态可以保存能力限制',\n    400,\n  )\n",
    replacement: '  return\n',
    test: 'rejects an empty restriction set for a restricted target state',
  },
  {
    group: 'invariant',
    id: 'transition-validates-expected-state-invariant',
    file: 'src/services/auth/account-state.ts',
    search: '  assertStateRestrictionInvariant(input.expectedStatus, expectedRestrictions)\n',
    replacement: '',
    test: 'rejects an inconsistent expected state snapshot before CAS',
  },
  {
    group: 'invariant',
    id: 'transition-validates-target-state-invariant',
    file: 'src/services/auth/account-state.ts',
    search: '  assertStateRestrictionInvariant(input.status, restrictions)\n',
    replacement: '',
    test: 'rejects an empty restriction set for a restricted target state',
  },
  {
    group: 'transition',
    id: 'transition-invokes-whitelist-guard',
    file: 'src/services/auth/account-state.ts',
    search:
      '  assertTransitionAllowed(input.expectedStatus, input.status, expectedRestrictions, restrictions)\n',
    replacement: '',
    test: 'rejects unlisted and no-op transitions before writing an audit event',
  },
  {
    group: 'transition',
    id: 'transition-whitelist-rejects-unlisted-edge',
    file: 'src/services/auth/account-state.ts',
    search:
      '  if ((CUSTOMER_ACCOUNT_TRANSITIONS[from] as readonly CustomerAccountStatus[]).includes(to)) return\n',
    replacement: '  return\n',
    test: 'rejects unlisted and no-op transitions before writing an audit event',
  },
  {
    group: 'transition',
    id: 'same-state-path-is-not-bypassed',
    file: 'src/services/auth/account-state.ts',
    search: '  if (from === to) {\n',
    replacement: '  if (false) {\n',
    test: 'rejects same-state no-op transitions with the stable no-op code',
  },
  {
    group: 'transition',
    id: 'restricted-same-state-requires-changed-restrictions',
    file: 'src/services/auth/account-state.ts',
    search:
      "    if (from === 'restricted' && !sameRestrictions(expectedRestrictions, restrictions)) return\n",
    replacement: '',
    test: 'atomically allows exactly one concurrent restricted capability-set replacement',
  },
  {
    group: 'transition',
    id: 'same-restrictions-compares-array-length',
    file: 'src/services/auth/account-state.ts',
    search:
      '  return left.length === right.length && left.every((value, index) => value === right[index])\n',
    replacement: '  return true && left.every((value, index) => value === right[index])\n',
    test: 'allows a restricted replacement that only appends a capability restriction',
  },
  {
    group: 'transition',
    id: 'same-restrictions-compares-each-value',
    file: 'src/services/auth/account-state.ts',
    search:
      '  return left.length === right.length && left.every((value, index) => value === right[index])\n',
    replacement: '  return left.length === right.length && true\n',
    test: 'atomically allows exactly one concurrent restricted capability-set replacement',
  },
  {
    group: 'normalization',
    id: 'restriction-input-requires-array',
    file: 'src/services/auth/account-state.ts',
    search: '  if (!Array.isArray(value)) {\n',
    replacement: '  if (false) {\n',
    test: 'rejects a non-array persisted restriction snapshot with the stable storage error',
  },
  {
    group: 'normalization',
    id: 'restriction-input-rejects-duplicates',
    file: 'src/services/auth/account-state.ts',
    search: '    restrictions.length !== value.length ||\n',
    replacement: '    false ||\n',
    test: 'rejects duplicate restriction input at the transition boundary',
  },
  {
    group: 'normalization',
    id: 'restriction-input-rejects-unknown-values',
    file: 'src/services/auth/account-state.ts',
    search:
      "    !restrictions.every(\n      (item): item is CustomerCapabilityRestriction =>\n        typeof item === 'string' &&\n        (CUSTOMER_CAPABILITY_RESTRICTIONS as readonly string[]).includes(item),\n    )\n",
    replacement: '    false\n',
    test: 'rejects unknown restriction input at the transition boundary',
  },
  {
    group: 'normalization',
    id: 'restriction-request-errors-fail-closed',
    file: 'src/services/auth/account-state.ts',
    search:
      "  } catch {\n    throw new AppError('ACCOUNT_RESTRICTIONS_INVALID', '账户能力限制请求无效', 400)\n  }\n",
    replacement: '  } catch {\n    return []\n  }\n',
    test: 'rejects non-array restriction input at the transition boundary',
  },
  {
    group: 'normalization',
    id: 'restrictions-are-canonicalized-before-comparison',
    file: 'src/services/auth/account-state.ts',
    search: '  return restrictions.sort()\n',
    replacement: '  return restrictions\n',
    test: 'canonicalizes restriction order before comparison and persistence',
  },
  {
    group: 'capability',
    id: 'capability-rejects-unknown-account-status',
    file: 'src/services/auth/account-state.ts',
    search: '  if (!isAccountStatus(account.status)) {\n',
    replacement: '  if (false) {\n',
    test: 'rejects an unknown account status snapshot and a missing account lookup',
  },
  {
    group: 'capability',
    id: 'capability-rejects-nonoperational-status',
    file: 'src/services/auth/account-state.ts',
    search: "  if (account.status !== 'active' && account.status !== 'restricted') {\n",
    replacement: '  if (false) {\n',
    test: 'fails closed for the suspended status with ACCOUNT_SUSPENDED',
  },
  {
    group: 'capability',
    id: 'capability-rejects-active-with-restrictions',
    file: 'src/services/auth/account-state.ts',
    search: "    (account.status === 'active' && restrictions.length > 0) ||\n",
    replacement: '    false ||\n',
    test: 'rejects inconsistent active/restricted records instead of silently broadening access',
  },
  {
    group: 'capability',
    id: 'capability-rejects-restricted-without-restrictions',
    file: 'src/services/auth/account-state.ts',
    search: "    (account.status === 'restricted' && restrictions.length === 0)\n",
    replacement: '    false\n',
    test: 'rejects inconsistent active/restricted records instead of silently broadening access',
  },
  {
    group: 'capability',
    id: 'capability-restriction-is-enforced',
    file: 'src/services/auth/account-state.ts',
    search: '  if (!restrictions.includes(restriction)) return\n',
    replacement: '  return\n',
    test: "fails closed with 'ACCOUNT_PURCHASE_DISABLED' for the 'purchase_disabled' restriction",
  },
  {
    group: 'capability',
    id: 'capability-missing-account-fails-closed',
    file: 'src/services/auth/account-state.ts',
    search: "    throw new AppError('ACCOUNT_NOT_FOUND', '未找到账号', 404)\n",
    replacement: '    return\n',
    test: 'rejects an unknown account status snapshot and a missing account lookup',
  },
  ...[
    ['login', 'login_disabled', 'purchase_disabled', "fails closed with 'ACCOUNT_LOGIN_DISABLED'"],
    [
      'purchase',
      'purchase_disabled',
      'login_disabled',
      "fails closed with 'ACCOUNT_PURCHASE_DISABLED'",
    ],
    [
      'balance_spend',
      'balance_spend_disabled',
      'login_disabled',
      "fails closed with 'ACCOUNT_BALANCE_SPEND_DISABLED'",
    ],
    [
      'domain_write',
      'domain_write_disabled',
      'login_disabled',
      "fails closed with 'ACCOUNT_DOMAIN_WRITE_DISABLED'",
    ],
    [
      'identity_change',
      'identity_change_disabled',
      'login_disabled',
      "fails closed with 'ACCOUNT_IDENTITY_CHANGE_DISABLED'",
    ],
    [
      'refund',
      'refund_review',
      'login_disabled',
      "fails closed with 'ACCOUNT_REFUND_REVIEW_REQUIRED'",
    ],
  ].map(([capability, original, replacement, test]) => ({
    group: 'capability',
    id: `capability-map-${capability}`,
    file: 'src/services/auth/account-state.ts',
    search: `  ${capability}: '${original}',\n`,
    replacement: `  ${capability}: '${replacement}',\n`,
    test,
  })),
  {
    group: 'effects',
    id: 'cas-miss-throws-conflict',
    file: 'src/services/auth/account-state.ts',
    search: '    if (row?.id === undefined) {\n',
    replacement: '    if (false) {\n',
    test: 'keeps the account-state CAS expected status predicate behaviorally necessary',
  },
  {
    group: 'effects',
    id: 'closing-sets-deletion-requested-at',
    file: 'src/services/auth/account-state.ts',
    search:
      "          WHEN ${input.status} = 'closing' THEN COALESCE(deletion_requested_at, ${changedAt})\n",
    replacement: '          WHEN FALSE THEN COALESCE(deletion_requested_at, ${changedAt})\n',
    test: 'sets deletionRequestedAt on closing and clears it only when closing returns to active',
  },
  {
    group: 'effects',
    id: 'closing-to-active-clears-deletion-requested-at',
    file: 'src/services/auth/account-state.ts',
    search:
      "          WHEN ${input.expectedStatus} = 'closing' AND ${input.status} = 'active' THEN NULL\n",
    replacement: '          WHEN FALSE THEN NULL\n',
    test: 'sets deletionRequestedAt on closing and clears it only when closing returns to active',
  },
  {
    group: 'effects',
    id: 'nonoperational-result-revokes-sessions',
    file: 'src/services/auth/account-state.ts',
    search: "      (input.status !== 'active' && input.status !== 'restricted') ||\n",
    replacement: '      false ||\n',
    test: 'revokes sessions when a non-operational state blocks login',
  },
  {
    group: 'effects',
    id: 'login-disabled-result-revokes-sessions',
    file: 'src/services/auth/account-state.ts',
    search: "      restrictions.includes('login_disabled')\n",
    replacement: '      false\n',
    test: 'revokes sessions when restricted gains login_disabled',
  },
  {
    group: 'effects',
    id: 'login-blocked-branch-executes',
    file: 'src/services/auth/account-state.ts',
    search: '    if (loginBlocked) {\n',
    replacement: '    if (false) {\n',
    test: 'revokes sessions when a non-operational state blocks login',
  },
  {
    group: 'effects',
    id: 'state-change-records-security-event',
    file: 'src/services/auth/account-state.ts',
    search:
      "    await recordCustomerSecurityEvent(req, input.customerId, 'account_state_changed', metadata)\n",
    replacement: '',
    test: 'records reason, operator, evidence, time, prior state, and resulting restrictions append-only',
  },
  {
    group: 'effects',
    id: 'state-change-records-audit-event',
    file: 'src/services/auth/account-state.ts',
    search:
      "    await recordAuditEvent(req, {\n      action: 'customer.account_state.changed',\n      actor: input.actor,\n      metadata,\n      targetId: input.customerId,\n    })\n",
    replacement: '',
    test: 'records reason, operator, evidence, time, prior state, and resulting restrictions append-only',
  },
  {
    group: 'effects',
    id: 'automatic-session-revocation-records-audit',
    file: 'src/services/auth/account-state.ts',
    search:
      "      await recordAuditEvent(req, {\n        action: 'customer.account_sessions.revoked',\n        actor: input.actor,\n        metadata: {\n          evidence: input.evidence,\n          reason: 'account_access_disabled',\n          scope: 'all',\n        },\n        targetId: input.customerId,\n      })\n",
    replacement: '',
    test: 'revokes sessions when a non-operational state blocks login',
  },
  {
    group: 'effects',
    id: 'automatic-session-revocation-invokes-revoke-all',
    file: 'src/services/auth/account-state.ts',
    search:
      "      await revokeAllCustomerSessions(req, input.customerId, 'account_access_disabled')\n",
    replacement: '',
    test: 'revokes sessions when a non-operational state blocks login',
  },
  {
    group: 'effects',
    id: 'explicit-session-security-action-records-audit',
    file: 'src/services/auth/account-state.ts',
    search:
      "    await recordAuditEvent(req, {\n      action: 'customer.account_sessions.revoked',\n      actor: input.actor,\n      metadata: {\n        evidence: input.evidence,\n        reason: input.reason,\n        revokedCount,\n        scope: 'all',\n      },\n      targetId: input.customerId,\n    })\n",
    replacement: '',
    test: 'revokes every target session in one security action without touching another customer',
  },
  {
    group: 'effects',
    id: 'revoke-all-records-security-event',
    file: 'src/services/auth/customer-sessions.ts',
    search:
      "    await recordCustomerSecurityEvent(req, customerId, 'sessions_revoked', {\n      reason,\n      revokedCount,\n      scope: 'all',\n    })\n",
    replacement: '',
    test: 'revokes every target session in one security action without touching another customer',
  },
  {
    group: 'effects',
    id: 'logout-all-uses-all-session-branch',
    file: 'src/services/auth/otp.ts',
    search: "  if (scope === 'all') {\n",
    replacement: '  if (false) {\n',
    test: 'keeps logout-all routed through the all-session revocation branch',
  },
  {
    group: 'surface',
    id: 'verified-login-capability-call',
    file: 'src/services/auth/customer-identities.ts',
    search: "  assertCustomerAccountCapabilityFromSnapshot(customer, 'login')\n",
    replacement: '',
    test: 'enforces the login capability at verified-login, strategy, and request restoration points',
  },
  {
    group: 'surface',
    id: 'bind-identity-capability-call',
    file: 'src/services/auth/customer-identities.ts',
    search: "    await assertCustomerAccountCapability(req, customer.id, 'identity_change')\n",
    replacement: '',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'blocks existing purchase, identity, and domain-write entry points before partial work',
  },
  {
    group: 'surface',
    id: 'unbind-identity-capability-call',
    file: 'src/services/auth/customer-identities.ts',
    search: "    await assertCustomerAccountCapability(req, customer.id, 'identity_change')\n",
    replacement: '',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'blocks existing purchase, identity, and domain-write entry points before partial work',
  },
  {
    group: 'surface',
    id: 'strategy-login-capability-call',
    file: 'src/services/auth/customer-strategy.ts',
    search: "      assertCustomerAccountCapabilityFromSnapshot(customer, 'login')\n",
    replacement: '',
    test: 'enforces the login capability at verified-login, strategy, and request restoration points',
  },
  {
    group: 'surface',
    id: 'authenticated-request-login-capability-call',
    file: 'src/services/auth/otp.ts',
    search: "  assertCustomerAccountCapabilityFromSnapshot(customer, 'login')\n",
    replacement: '',
    test: 'allows restricted login while denying login_disabled sessions with a stable code',
  },
  {
    group: 'surface',
    id: 'order-create-purchase-capability-call',
    file: 'src/services/commerce/order-creation.ts',
    search: "    await assertCustomerAccountCapability(req, options.customer.id, 'purchase')\n",
    replacement: '',
    test: 'blocks existing purchase, identity, and domain-write entry points before partial work',
  },
  {
    group: 'surface',
    id: 'payment-create-purchase-capability-call',
    file: 'src/services/commerce/payments.ts',
    search: "  await assertCustomerAccountCapability(req, options.customer.id, 'purchase')\n",
    replacement: '',
    test: 'blocks existing purchase, identity, and domain-write entry points before partial work',
  },
  {
    group: 'surface',
    id: 'domain-read-login-capability-call',
    file: 'src/services/domains/domain-assets.ts',
    search: "  assertCustomerAccountCapabilityFromSnapshot(req.user, 'login')\n",
    replacement: '',
    test: 'blocks domain reads and both real-name customer surfaces when login is disabled',
  },
  {
    group: 'surface',
    id: 'realname-document-login-capability-call',
    file: 'src/services/realname/documents.ts',
    search: "  assertCustomerAccountCapabilityFromSnapshot(req.user, 'login')\n",
    replacement: '',
    test: 'blocks domain reads and both real-name customer surfaces when login is disabled',
  },
  {
    group: 'surface',
    id: 'realname-template-login-capability-call',
    file: 'src/services/realname/templates.ts',
    search: "  assertCustomerAccountCapabilityFromSnapshot(req.user, 'login')\n",
    replacement: '',
    test: 'blocks domain reads and both real-name customer surfaces when login is disabled',
  },
  {
    group: 'surface',
    id: 'nameserver-domain-write-capability-call',
    file: 'src/services/domains/nameserver-changes.ts',
    search: "    await assertCustomerAccountCapability(req, options.customer.id, 'domain_write')\n",
    replacement: '',
    test: 'blocks existing purchase, identity, and domain-write entry points before partial work',
  },
  {
    group: 'surface',
    id: 'nameserver-step-up-call',
    file: 'src/services/domains/nameserver-changes.ts',
    search:
      "    await authorizeStepUpGrant(req, {\n      customerId: options.customer.id,\n      deviceId: input.deviceId,\n      headers: req.headers,\n      purpose: 'nameserver_change',\n      stepUpToken: input.stepUpToken,\n    })\n",
    replacement: '',
    test: 'requires step-up before account deletion or Name Server work can begin',
  },
  {
    group: 'surface',
    id: 'deletion-source-state-early-guard',
    file: 'src/services/auth/otp.ts',
    search:
      "    if (customer.status !== 'active' && customer.status !== 'restricted') {\n      throw new AppError('ACCOUNT_STATE_TRANSITION_INVALID', '当前账号状态不可申请注销', 409)\n    }\n",
    replacement: '',
    test: 'rejects deletion source states before attempting step-up authorization',
  },
  {
    group: 'surface',
    id: 'deletion-step-up-call',
    file: 'src/services/auth/otp.ts',
    search:
      "    const grant = await authorizeStepUpGrant(req, {\n      customerId: customer.id,\n      deviceId: input.deviceId,\n      headers: req.headers,\n      purpose: 'account_deletion',\n      stepUpToken: input.stepUpToken,\n    })\n",
    replacement: "    const grant = { grantId: 'mutation-without-step-up' }\n",
    test: 'requires step-up before account deletion or Name Server work can begin',
  },
  {
    group: 'surface',
    id: 'deletion-uses-account-transition-service',
    file: 'src/services/auth/otp.ts',
    search:
      "    const updated = await transitionCustomerAccount(req, {\n      actor: { id: customer.id, type: 'customer' },\n      changedAt: now,\n      customerId: customer.id,\n      evidence: {\n        observedAt: now,\n        reference: `step-up-grant:${grant.grantId}`,\n        source: 'customer_request',\n      },\n      expectedRestrictions: accountRestrictions(customer),\n      expectedStatus: customer.status,\n      reason: 'customer_requested_account_closure',\n      restrictions: [],\n      status: 'closing',\n    })\n",
    replacement: '    const updated = { deletionRequestedAt: now }\n',
    test: 'persists a valid restricted self-closure through the account-state transition service',
  },
  {
    group: 'surface',
    id: 'registration-uses-pending-to-active-transition',
    file: 'src/services/auth/customer-identities.ts',
    search:
      "      const activated = await transitionCustomerAccount(req, {\n        actor: { type: 'system' },\n        changedAt: now,\n        customerId: customer.id,\n        evidence: {\n          observedAt: now,\n          reference: `registration-intent:${primary.id}`,\n          source: 'registration',\n        },\n        expectedRestrictions: [],\n        expectedStatus: 'pending_registration',\n        reason: 'explicit_registration_completed',\n        restrictions: [],\n        status: 'active',\n      })\n",
    replacement:
      "      const activated = { capabilityRestrictions: [], status: 'active' as const }\n",
    testFile: registrationTest,
    test: 'does not create an account at OTP verification and records two real registration consents',
  },
  {
    group: 'surface',
    id: 'expiry-reminder-skips-suspended',
    file: 'src/services/domains/expiry-reminders.ts',
    search: "    if (customer.status !== 'active' && customer.status !== 'restricted') continue\n",
    replacement: '    if (false) continue\n',
    testFile: domainIntegrationTest,
    test: 'sends expiry reminders to restricted accounts but skips suspended accounts',
  },
  {
    group: 'surface',
    id: 'expiry-reminder-includes-restricted',
    file: 'src/services/domains/expiry-reminders.ts',
    search: "    if (customer.status !== 'active' && customer.status !== 'restricted') continue\n",
    replacement: "    if (customer.status !== 'active') continue\n",
    testFile: domainIntegrationTest,
    test: 'sends expiry reminders to restricted accounts but skips suspended accounts',
  },
  {
    group: 'boundary',
    id: 'customer-field-requires-array',
    file: 'src/collections/identity.ts',
    search: "        if (!Array.isArray(value)) return '账户能力限制必须为数组'\n",
    replacement: '        if (!Array.isArray(value)) return true\n',
    test: 'rejects non-array restrictions at the persisted customer field boundary',
  },
  {
    group: 'boundary',
    id: 'customer-field-rejects-duplicates',
    file: 'src/collections/identity.ts',
    search: "        if (new Set(value).size !== value.length) return '账户能力限制不得重复'\n",
    replacement: '        if (false) return true\n',
    test: 'rejects duplicate restrictions at the persisted customer field boundary',
  },
  {
    group: 'boundary',
    id: 'customer-field-rejects-unknown-values',
    file: 'src/collections/identity.ts',
    search:
      "        return value.every(\n          (item) =>\n            typeof item === 'string' &&\n            (CUSTOMER_CAPABILITY_RESTRICTIONS as readonly string[]).includes(item),\n        )\n          ? true\n          : '账户能力限制包含未知值'\n",
    replacement: '        return true\n',
    test: 'rejects unknown restrictions at the persisted customer field boundary',
  },
  {
    group: 'boundary',
    id: 'admin-route-requires-json',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search:
      "  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {\n",
    replacement: '  if (false) {\n',
    testFile: routeTest,
    test: 'rejects non-JSON bodies before authentication',
  },
  {
    group: 'boundary',
    id: 'admin-route-bounds-declared-length',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search: '  if (declaredLength > MAX_BODY_BYTES) {\n',
    replacement: '  if (false) {\n',
    testFile: routeTest,
    test: 'rejects an oversized declared content length before reading the body',
  },
  {
    group: 'boundary',
    id: 'admin-route-bounds-actual-length',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search: '  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {\n',
    replacement: '  if (false) {\n',
    testFile: routeTest,
    test: 'rejects an oversized actual UTF-8 body even without a declared length',
  },
  {
    group: 'boundary',
    id: 'admin-route-maps-invalid-json',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search: "  } catch {\n    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)\n  }\n",
    replacement: '  } catch (error) {\n    throw error\n  }\n',
    testFile: routeTest,
    test: 'maps malformed JSON to the stable invalid-request response',
  },
  {
    group: 'boundary',
    id: 'admin-route-requires-positive-customer-id',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search: 'const customerIdSchema = z.coerce.number().int().positive()\n',
    replacement: 'const customerIdSchema = z.coerce.number().int()\n',
    testFile: routeTest,
    test: 'rejects a non-positive customer id before authentication',
  },
  {
    group: 'boundary',
    id: 'admin-route-invokes-system-admin-gate',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search: '    const { req, user } = await systemAdminRequest(payload, request)\n',
    replacement:
      "    const { req, user } = { req: { payload }, user: { id: 'mutation-admin' } } as never\n",
    testFile: routeTest,
    test: 'fails closed when the system-admin request gate rejects',
  },
  {
    group: 'boundary',
    id: 'admin-route-revoke-action-branch',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search: "    if (input.action === 'revoke_sessions') {\n",
    replacement: '    if (false) {\n',
    testFile: routeTest,
    test: 'routes revoke_sessions only to the session security action',
  },
  {
    group: 'boundary',
    id: 'admin-route-change-state-action-branch',
    file: 'src/app/api/v1/admin/customers/[customerId]/account-security/route.ts',
    search: "    if (input.action === 'revoke_sessions') {\n",
    replacement: '    if (true) {\n',
    testFile: routeTest,
    test: 'routes change_state only to the atomic transition service',
  },
  {
    group: 'boundary',
    id: 'admin-schema-rejects-duplicate-restrictions',
    file: 'src/schemas/auth.ts',
    search: ".refine((value) => new Set(value).size === value.length, '账户能力限制不得重复')\n",
    replacement: ".refine(() => true, '账户能力限制不得重复')\n",
    testFile: routeTest,
    test: 'rejects duplicate account restrictions at the admin schema boundary',
  },
  {
    group: 'boundary',
    id: 'admin-schema-rejects-unknown-account-status',
    file: 'src/schemas/auth.ts',
    search: 'export const customerAccountStatusSchema = z.enum(CUSTOMER_ACCOUNT_STATUSES)\n',
    replacement: 'export const customerAccountStatusSchema = z.string()\n',
    testFile: routeTest,
    test: 'rejects unknown account states at the admin schema boundary',
  },
  {
    group: 'boundary',
    id: 'admin-schema-requires-evidence-source',
    file: 'src/schemas/auth.ts',
    search: '    source: z.enum([\n',
    replacement: '    source: z.enum([\n',
    transform: (source) =>
      source.replace(
        "      'written_confirmation',\n    ]),\n  })\n  .strict()",
        "      'written_confirmation',\n    ]).optional(),\n  })\n  .strict()",
      ),
    testFile: routeTest,
    test: 'rejects incomplete or unstructured account-state evidence',
  },
  {
    group: 'boundary',
    id: 'admin-schema-evidence-is-strict',
    file: 'src/schemas/auth.ts',
    search: 'export const customerAccountEvidenceSchema = z\n  .object({\n',
    replacement: 'export const customerAccountEvidenceSchema = z\n  .object({\n',
    transform: (source) => {
      const marker = 'export const adminCustomerAccountActionSchema'
      const before = source.slice(0, source.indexOf(marker))
      const after = source.slice(source.indexOf(marker))
      return `${before.replace(/\.strict\(\)\n\n$/u, '.passthrough()\n\n')}${after}`
    },
    testFile: routeTest,
    test: 'rejects incomplete or unstructured account-state evidence',
  },
  {
    group: 'boundary',
    id: 'admin-change-state-action-is-strict',
    file: 'src/schemas/auth.ts',
    search: '      status: customerAccountStatusSchema,\n    })\n    .strict(),\n',
    replacement: '      status: customerAccountStatusSchema,\n    })\n    .passthrough(),\n',
    testFile: routeTest,
    test: 'rejects unexpected admin account-action fields',
  },
  {
    group: 'boundary',
    id: 'deletion-schema-requires-confirmation',
    file: 'src/schemas/auth.ts',
    search: "    confirmation: z.literal('DELETE_MY_ACCOUNT'),\n",
    replacement: '    confirmation: z.string(),\n',
    testFile: routeTest,
    test: 'requires deletion confirmation at the strict request schema boundary',
  },
  {
    group: 'boundary',
    id: 'deletion-schema-requires-device-id',
    file: 'src/schemas/auth.ts',
    search: '    deviceId: z.string().min(16).max(128),\n',
    replacement: '    deviceId: z.string().min(16).max(128).optional(),\n',
    occurrence: 5,
    expectedOccurrences: 5,
    testFile: routeTest,
    test: 'requires deletion deviceId at the strict request schema boundary',
  },
  {
    group: 'boundary',
    id: 'deletion-schema-requires-step-up-token',
    file: 'src/schemas/auth.ts',
    search: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n',
    replacement: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),\n',
    testFile: routeTest,
    test: 'requires deletion stepUpToken at the strict request schema boundary',
  },
  {
    group: 'boundary',
    id: 'deletion-schema-is-strict',
    file: 'src/schemas/auth.ts',
    search: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n  })\n  .strict()\n',
    replacement:
      '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n  })\n  .passthrough()\n',
    testFile: routeTest,
    test: 'requires deletion unknown field at the strict request schema boundary',
  },
  {
    group: 'boundary',
    id: 'nameserver-schema-requires-confirmation',
    file: 'src/schemas/domains.ts',
    search: '  confirmed: z.literal(true),\n',
    replacement: '  confirmed: z.boolean(),\n',
    testFile: domainRouteTest,
    test: 'rejects a Name Server request without valid explicit confirmation',
  },
  {
    group: 'boundary',
    id: 'nameserver-schema-requires-device-id',
    file: 'src/schemas/domains.ts',
    search: '  deviceId: z.string().min(16).max(128),\n',
    replacement: '  deviceId: z.string().min(16).max(128).optional(),\n',
    testFile: domainRouteTest,
    test: 'rejects a Name Server request without valid device id',
  },
  {
    group: 'boundary',
    id: 'nameserver-schema-requires-step-up-token',
    file: 'src/schemas/domains.ts',
    search: '  stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n',
    replacement: '  stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),\n',
    testFile: domainRouteTest,
    test: 'rejects a Name Server request without valid step-up token',
  },
]

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

  let mutated = replaceOccurrence(
    original,
    mutation.search,
    mutation.replacement,
    mutation.occurrence ?? 1,
  )
  if (mutation.transform) mutated = mutation.transform(original)
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
        mutation.testFile ?? accountStateTest,
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
  process.stdout.write(`TEST ${mutation.testFile ?? accountStateTest} :: ${mutation.test}\n`)
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
