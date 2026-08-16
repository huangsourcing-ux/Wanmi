# D9-A A3 安全与正确性变异矩阵

本文件记录 PR #89 A3 补测的可重复变异证据。生产实现只做了一项行为等价化简：
admin 分支移除被 `hasRole(system_admin)` 完全覆盖的重复 collection 判断；授权结果不变。
其余变更均为测试、变异运行器和证据。

## 运行结论

| 组            | 杀死/总数 |
| ------------- | --------: |
| actor         |     11/11 |
| invariant     |       5/5 |
| transition    |       6/6 |
| normalization |       5/5 |
| capability    |     12/12 |
| effects       |     13/13 |
| surface       |     18/18 |
| boundary      |     23/23 |
| JS 合计       |     93/93 |
| SQL WHERE     |       5/5 |
| 总计          |     98/98 |

运行命令：

```sh
node apps/web/scripts/mutate-a3-security-decisions.mjs
node apps/web/scripts/mutate-a3-sql-predicates.mjs
```

第一个命令只把目标行为断言产生的 `AssertionError` 记为
`KILLED_BY_BEHAVIOR`；编译、加载、worker 或 setup 失败不会算通过。每项运行后在
`finally` 中恢复源码。完整逐项原始报错由命令直接输出。

## 审核指定判定点的原始失败

| 要求                                      | 独立行为用例                                                                 | 本次短路后的原始失败首行                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| admin 必须有 system_admin                 | rejects an admin actor without the system_admin role                         | `AssertionError: promise resolved "{ …(4) }" instead of rejecting`                             |
| customer 只能操作本人 customerId          | rejects a customer changing another customerId even with a matching actor id | `AssertionError: promise resolved "{ capabilityRestrictions: [], …(4) }" instead of rejecting` |
| customer 目标只能是 closing               | rejects customer targets other than closing                                  | `AssertionError: promise resolved "{ …(4) }" instead of rejecting`                             |
| customer 来源只能 active/restricted       | rejects customer self-service from non active or restricted source states    | `AssertionError: promise resolved "{ capabilityRestrictions: [], …(4) }" instead of rejecting` |
| system actor 不得携带 req.user            | rejects a system actor whenever req.user is present                          | `AssertionError: promise resolved "{ …(4) }" instead of rejecting`                             |
| 整个 assertActorAllowed 掏空              | rejects an admin actor without the system_admin role                         | `AssertionError: promise resolved "{ …(4) }" instead of rejecting`                             |
| restricted 必须有至少一项限制             | rejects an empty restriction set for a restricted target state               | `AssertionError: promise resolved "{ capabilityRestrictions: [], …(3) }" instead of rejecting` |
| 非 restricted 不得保存限制                | rejects restrictions on a non-restricted target state                        | `AssertionError: promise resolved "{ …(4) }" instead of rejecting`                             |
| 整个 assertStateRestrictionInvariant 掏空 | rejects an empty restriction set for a restricted target state               | `AssertionError: promise resolved "{ capabilityRestrictions: [], …(3) }" instead of rejecting` |

## SQL WHERE 谓词原始失败

| 谓词                                                       | 行为用例                                                                           | 本次删除后的原始失败                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| state CAS `id = customerId`                                | keeps the account-state CAS target id predicate behaviorally necessary             | `AssertionError: promise resolved "{ capabilityRestrictions: [], …(3) }" instead of rejecting` |
| state CAS `status = expectedStatus`                        | keeps the account-state CAS expected status predicate behaviorally necessary       | `AssertionError: promise resolved "{ …(4) }" instead of rejecting`                             |
| state CAS `capability_restrictions = expectedRestrictions` | keeps the account-state CAS expected restrictions predicate behaviorally necessary | `AssertionError: promise resolved "{ capabilityRestrictions: [], …(3) }" instead of rejecting` |
| session revoke `customer_id = customerId`                  | keeps the revoke-all customer id predicate behaviorally necessary                  | `AssertionError: expected 58 to be +0 // Object.is equality`                                   |
| session revoke `revoked_at IS NULL`                        | keeps the revoke-all active-session predicate behaviorally necessary               | `AssertionError: expected 1 to be +0 // Object.is equality`                                    |

## 全部 JS 判定点对照表

下表由 `mutate-a3-security-decisions.mjs --list` 的 manifest 逐行生成。
每行对应一次独立删除/短路、一个指定行为用例和一次真实运行。

| 组              | 判定点/插入点                                         | 文件                                                                    | 行为用例                                                                                      | 结果               |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------ |
| `actor`         | `actor-system-requires-empty-req-user`                | `src/services/auth/account-state.ts`                                    | rejects a system actor whenever req.user is present                                           | KILLED_BY_BEHAVIOR |
| `actor`         | `actor-admin-requires-system-admin-role`              | `src/services/auth/account-state.ts`                                    | rejects an admin actor without the system_admin role                                          | KILLED_BY_BEHAVIOR |
| `actor`         | `actor-admin-id-matches-session`                      | `src/services/auth/account-state.ts`                                    | rejects an admin actor whose asserted id does not match the authenticated admin               | KILLED_BY_BEHAVIOR |
| `actor`         | `actor-customer-requires-customer-principal`          | `src/services/auth/account-state.ts`                                    | rejects a customer actor when the authenticated principal is not a customer                   | KILLED_BY_BEHAVIOR |
| `actor`         | `actor-customer-id-matches-session`                   | `src/services/auth/account-state.ts`                                    | rejects a customer actor id that does not match the authenticated customer                    | KILLED_BY_BEHAVIOR |
| `actor`         | `actor-customer-owns-target-customer-id`              | `src/services/auth/account-state.ts`                                    | rejects a customer changing another customerId even with a matching actor id                  | KILLED_BY_BEHAVIOR |
| `actor`         | `actor-customer-source-active-or-restricted`          | `src/services/auth/account-state.ts`                                    | rejects customer self-service from non active or restricted source states                     | KILLED_BY_BEHAVIOR |
| `actor`         | `actor-customer-target-closing-only`                  | `src/services/auth/account-state.ts`                                    | rejects customer targets other than closing                                                   | KILLED_BY_BEHAVIOR |
| `actor`         | `transition-invokes-actor-guard`                      | `src/services/auth/account-state.ts`                                    | rejects an admin actor without the system_admin role                                          | KILLED_BY_BEHAVIOR |
| `actor`         | `session-security-action-invokes-actor-guard`         | `src/services/auth/account-state.ts`                                    | rejects unauthorized use of the one-action security session revocation service                | KILLED_BY_BEHAVIOR |
| `actor`         | `whole-actor-guard-not-empty`                         | `src/services/auth/account-state.ts`                                    | rejects an admin actor without the system_admin role                                          | KILLED_BY_BEHAVIOR |
| `invariant`     | `restricted-state-requires-nonempty-restrictions`     | `src/services/auth/account-state.ts`                                    | rejects an empty restriction set for a restricted target state                                | KILLED_BY_BEHAVIOR |
| `invariant`     | `nonrestricted-state-requires-empty-restrictions`     | `src/services/auth/account-state.ts`                                    | rejects restrictions on a non-restricted target state                                         | KILLED_BY_BEHAVIOR |
| `invariant`     | `whole-state-restriction-invariant-not-empty`         | `src/services/auth/account-state.ts`                                    | rejects an empty restriction set for a restricted target state                                | KILLED_BY_BEHAVIOR |
| `invariant`     | `transition-validates-expected-state-invariant`       | `src/services/auth/account-state.ts`                                    | rejects an inconsistent expected state snapshot before CAS                                    | KILLED_BY_BEHAVIOR |
| `invariant`     | `transition-validates-target-state-invariant`         | `src/services/auth/account-state.ts`                                    | rejects an empty restriction set for a restricted target state                                | KILLED_BY_BEHAVIOR |
| `transition`    | `transition-invokes-whitelist-guard`                  | `src/services/auth/account-state.ts`                                    | rejects unlisted and no-op transitions before writing an audit event                          | KILLED_BY_BEHAVIOR |
| `transition`    | `transition-whitelist-rejects-unlisted-edge`          | `src/services/auth/account-state.ts`                                    | rejects unlisted and no-op transitions before writing an audit event                          | KILLED_BY_BEHAVIOR |
| `transition`    | `same-state-path-is-not-bypassed`                     | `src/services/auth/account-state.ts`                                    | rejects same-state no-op transitions with the stable no-op code                               | KILLED_BY_BEHAVIOR |
| `transition`    | `restricted-same-state-requires-changed-restrictions` | `src/services/auth/account-state.ts`                                    | atomically allows exactly one concurrent restricted capability-set replacement                | KILLED_BY_BEHAVIOR |
| `transition`    | `same-restrictions-compares-array-length`             | `src/services/auth/account-state.ts`                                    | allows a restricted replacement that only appends a capability restriction                    | KILLED_BY_BEHAVIOR |
| `transition`    | `same-restrictions-compares-each-value`               | `src/services/auth/account-state.ts`                                    | atomically allows exactly one concurrent restricted capability-set replacement                | KILLED_BY_BEHAVIOR |
| `normalization` | `restriction-input-requires-array`                    | `src/services/auth/account-state.ts`                                    | rejects a non-array persisted restriction snapshot with the stable storage error              | KILLED_BY_BEHAVIOR |
| `normalization` | `restriction-input-rejects-duplicates`                | `src/services/auth/account-state.ts`                                    | rejects duplicate restriction input at the transition boundary                                | KILLED_BY_BEHAVIOR |
| `normalization` | `restriction-input-rejects-unknown-values`            | `src/services/auth/account-state.ts`                                    | rejects unknown restriction input at the transition boundary                                  | KILLED_BY_BEHAVIOR |
| `normalization` | `restriction-request-errors-fail-closed`              | `src/services/auth/account-state.ts`                                    | rejects non-array restriction input at the transition boundary                                | KILLED_BY_BEHAVIOR |
| `normalization` | `restrictions-are-canonicalized-before-comparison`    | `src/services/auth/account-state.ts`                                    | canonicalizes restriction order before comparison and persistence                             | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-rejects-unknown-account-status`           | `src/services/auth/account-state.ts`                                    | rejects an unknown account status snapshot and a missing account lookup                       | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-rejects-nonoperational-status`            | `src/services/auth/account-state.ts`                                    | fails closed for the suspended status with ACCOUNT_SUSPENDED                                  | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-rejects-active-with-restrictions`         | `src/services/auth/account-state.ts`                                    | rejects inconsistent active/restricted records instead of silently broadening access          | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-rejects-restricted-without-restrictions`  | `src/services/auth/account-state.ts`                                    | rejects inconsistent active/restricted records instead of silently broadening access          | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-restriction-is-enforced`                  | `src/services/auth/account-state.ts`                                    | fails closed with 'ACCOUNT_PURCHASE_DISABLED' for the 'purchase_disabled' restriction         | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-missing-account-fails-closed`             | `src/services/auth/account-state.ts`                                    | rejects an unknown account status snapshot and a missing account lookup                       | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-map-login`                                | `src/services/auth/account-state.ts`                                    | fails closed with 'ACCOUNT_LOGIN_DISABLED'                                                    | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-map-purchase`                             | `src/services/auth/account-state.ts`                                    | fails closed with 'ACCOUNT_PURCHASE_DISABLED'                                                 | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-map-balance_spend`                        | `src/services/auth/account-state.ts`                                    | fails closed with 'ACCOUNT_BALANCE_SPEND_DISABLED'                                            | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-map-domain_write`                         | `src/services/auth/account-state.ts`                                    | fails closed with 'ACCOUNT_DOMAIN_WRITE_DISABLED'                                             | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-map-identity_change`                      | `src/services/auth/account-state.ts`                                    | fails closed with 'ACCOUNT_IDENTITY_CHANGE_DISABLED'                                          | KILLED_BY_BEHAVIOR |
| `capability`    | `capability-map-refund`                               | `src/services/auth/account-state.ts`                                    | fails closed with 'ACCOUNT_REFUND_REVIEW_REQUIRED'                                            | KILLED_BY_BEHAVIOR |
| `effects`       | `cas-miss-throws-conflict`                            | `src/services/auth/account-state.ts`                                    | keeps the account-state CAS expected status predicate behaviorally necessary                  | KILLED_BY_BEHAVIOR |
| `effects`       | `closing-sets-deletion-requested-at`                  | `src/services/auth/account-state.ts`                                    | sets deletionRequestedAt on closing and clears it only when closing returns to active         | KILLED_BY_BEHAVIOR |
| `effects`       | `closing-to-active-clears-deletion-requested-at`      | `src/services/auth/account-state.ts`                                    | sets deletionRequestedAt on closing and clears it only when closing returns to active         | KILLED_BY_BEHAVIOR |
| `effects`       | `nonoperational-result-revokes-sessions`              | `src/services/auth/account-state.ts`                                    | revokes sessions when a non-operational state blocks login                                    | KILLED_BY_BEHAVIOR |
| `effects`       | `login-disabled-result-revokes-sessions`              | `src/services/auth/account-state.ts`                                    | revokes sessions when restricted gains login_disabled                                         | KILLED_BY_BEHAVIOR |
| `effects`       | `login-blocked-branch-executes`                       | `src/services/auth/account-state.ts`                                    | revokes sessions when a non-operational state blocks login                                    | KILLED_BY_BEHAVIOR |
| `effects`       | `state-change-records-security-event`                 | `src/services/auth/account-state.ts`                                    | records reason, operator, evidence, time, prior state, and resulting restrictions append-only | KILLED_BY_BEHAVIOR |
| `effects`       | `state-change-records-audit-event`                    | `src/services/auth/account-state.ts`                                    | records reason, operator, evidence, time, prior state, and resulting restrictions append-only | KILLED_BY_BEHAVIOR |
| `effects`       | `automatic-session-revocation-records-audit`          | `src/services/auth/account-state.ts`                                    | revokes sessions when a non-operational state blocks login                                    | KILLED_BY_BEHAVIOR |
| `effects`       | `automatic-session-revocation-invokes-revoke-all`     | `src/services/auth/account-state.ts`                                    | revokes sessions when a non-operational state blocks login                                    | KILLED_BY_BEHAVIOR |
| `effects`       | `explicit-session-security-action-records-audit`      | `src/services/auth/account-state.ts`                                    | revokes every target session in one security action without touching another customer         | KILLED_BY_BEHAVIOR |
| `effects`       | `revoke-all-records-security-event`                   | `src/services/auth/customer-sessions.ts`                                | revokes every target session in one security action without touching another customer         | KILLED_BY_BEHAVIOR |
| `effects`       | `logout-all-uses-all-session-branch`                  | `src/services/auth/otp.ts`                                              | keeps logout-all routed through the all-session revocation branch                             | KILLED_BY_BEHAVIOR |
| `surface`       | `verified-login-capability-call`                      | `src/services/auth/customer-identities.ts`                              | enforces the login capability at verified-login, strategy, and request restoration points     | KILLED_BY_BEHAVIOR |
| `surface`       | `bind-identity-capability-call`                       | `src/services/auth/customer-identities.ts`                              | blocks existing purchase, identity, and domain-write entry points before partial work         | KILLED_BY_BEHAVIOR |
| `surface`       | `unbind-identity-capability-call`                     | `src/services/auth/customer-identities.ts`                              | blocks existing purchase, identity, and domain-write entry points before partial work         | KILLED_BY_BEHAVIOR |
| `surface`       | `strategy-login-capability-call`                      | `src/services/auth/customer-strategy.ts`                                | enforces the login capability at verified-login, strategy, and request restoration points     | KILLED_BY_BEHAVIOR |
| `surface`       | `authenticated-request-login-capability-call`         | `src/services/auth/otp.ts`                                              | allows restricted login while denying login_disabled sessions with a stable code              | KILLED_BY_BEHAVIOR |
| `surface`       | `order-create-purchase-capability-call`               | `src/services/commerce/order-creation.ts`                               | blocks existing purchase, identity, and domain-write entry points before partial work         | KILLED_BY_BEHAVIOR |
| `surface`       | `payment-create-purchase-capability-call`             | `src/services/commerce/payments.ts`                                     | blocks existing purchase, identity, and domain-write entry points before partial work         | KILLED_BY_BEHAVIOR |
| `surface`       | `domain-read-login-capability-call`                   | `src/services/domains/domain-assets.ts`                                 | blocks domain reads and both real-name customer surfaces when login is disabled               | KILLED_BY_BEHAVIOR |
| `surface`       | `realname-document-login-capability-call`             | `src/services/realname/documents.ts`                                    | blocks domain reads and both real-name customer surfaces when login is disabled               | KILLED_BY_BEHAVIOR |
| `surface`       | `realname-template-login-capability-call`             | `src/services/realname/templates.ts`                                    | blocks domain reads and both real-name customer surfaces when login is disabled               | KILLED_BY_BEHAVIOR |
| `surface`       | `nameserver-domain-write-capability-call`             | `src/services/domains/nameserver-changes.ts`                            | blocks existing purchase, identity, and domain-write entry points before partial work         | KILLED_BY_BEHAVIOR |
| `surface`       | `nameserver-step-up-call`                             | `src/services/domains/nameserver-changes.ts`                            | requires step-up before account deletion or Name Server work can begin                        | KILLED_BY_BEHAVIOR |
| `surface`       | `deletion-source-state-early-guard`                   | `src/services/auth/otp.ts`                                              | rejects deletion source states before attempting step-up authorization                        | KILLED_BY_BEHAVIOR |
| `surface`       | `deletion-step-up-call`                               | `src/services/auth/otp.ts`                                              | requires step-up before account deletion or Name Server work can begin                        | KILLED_BY_BEHAVIOR |
| `surface`       | `deletion-uses-account-transition-service`            | `src/services/auth/otp.ts`                                              | persists a valid restricted self-closure through the account-state transition service         | KILLED_BY_BEHAVIOR |
| `surface`       | `registration-uses-pending-to-active-transition`      | `src/services/auth/customer-identities.ts`                              | does not create an account at OTP verification and records two real registration consents     | KILLED_BY_BEHAVIOR |
| `surface`       | `expiry-reminder-skips-suspended`                     | `src/services/domains/expiry-reminders.ts`                              | sends expiry reminders to restricted accounts but skips suspended accounts                    | KILLED_BY_BEHAVIOR |
| `surface`       | `expiry-reminder-includes-restricted`                 | `src/services/domains/expiry-reminders.ts`                              | sends expiry reminders to restricted accounts but skips suspended accounts                    | KILLED_BY_BEHAVIOR |
| `boundary`      | `customer-field-requires-array`                       | `src/collections/identity.ts`                                           | rejects non-array restrictions at the persisted customer field boundary                       | KILLED_BY_BEHAVIOR |
| `boundary`      | `customer-field-rejects-duplicates`                   | `src/collections/identity.ts`                                           | rejects duplicate restrictions at the persisted customer field boundary                       | KILLED_BY_BEHAVIOR |
| `boundary`      | `customer-field-rejects-unknown-values`               | `src/collections/identity.ts`                                           | rejects unknown restrictions at the persisted customer field boundary                         | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-requires-json`                           | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | rejects non-JSON bodies before authentication                                                 | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-bounds-declared-length`                  | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | rejects an oversized declared content length before reading the body                          | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-bounds-actual-length`                    | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | rejects an oversized actual UTF-8 body even without a declared length                         | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-maps-invalid-json`                       | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | maps malformed JSON to the stable invalid-request response                                    | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-requires-positive-customer-id`           | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | rejects a non-positive customer id before authentication                                      | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-invokes-system-admin-gate`               | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | fails closed when the system-admin request gate rejects                                       | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-revoke-action-branch`                    | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | routes revoke_sessions only to the session security action                                    | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-route-change-state-action-branch`              | `src/app/api/v1/admin/customers/[customerId]/account-security/route.ts` | routes change_state only to the atomic transition service                                     | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-schema-rejects-duplicate-restrictions`         | `src/schemas/auth.ts`                                                   | rejects duplicate account restrictions at the admin schema boundary                           | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-schema-rejects-unknown-account-status`         | `src/schemas/auth.ts`                                                   | rejects unknown account states at the admin schema boundary                                   | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-schema-requires-evidence-source`               | `src/schemas/auth.ts`                                                   | rejects incomplete or unstructured account-state evidence                                     | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-schema-evidence-is-strict`                     | `src/schemas/auth.ts`                                                   | rejects incomplete or unstructured account-state evidence                                     | KILLED_BY_BEHAVIOR |
| `boundary`      | `admin-change-state-action-is-strict`                 | `src/schemas/auth.ts`                                                   | rejects unexpected admin account-action fields                                                | KILLED_BY_BEHAVIOR |
| `boundary`      | `deletion-schema-requires-confirmation`               | `src/schemas/auth.ts`                                                   | requires deletion confirmation at the strict request schema boundary                          | KILLED_BY_BEHAVIOR |
| `boundary`      | `deletion-schema-requires-device-id`                  | `src/schemas/auth.ts`                                                   | requires deletion deviceId at the strict request schema boundary                              | KILLED_BY_BEHAVIOR |
| `boundary`      | `deletion-schema-requires-step-up-token`              | `src/schemas/auth.ts`                                                   | requires deletion stepUpToken at the strict request schema boundary                           | KILLED_BY_BEHAVIOR |
| `boundary`      | `deletion-schema-is-strict`                           | `src/schemas/auth.ts`                                                   | requires deletion unknown field at the strict request schema boundary                         | KILLED_BY_BEHAVIOR |
| `boundary`      | `nameserver-schema-requires-confirmation`             | `src/schemas/domains.ts`                                                | rejects a Name Server request without valid explicit confirmation                             | KILLED_BY_BEHAVIOR |
| `boundary`      | `nameserver-schema-requires-device-id`                | `src/schemas/domains.ts`                                                | rejects a Name Server request without valid device id                                         | KILLED_BY_BEHAVIOR |
| `boundary`      | `nameserver-schema-requires-step-up-token`            | `src/schemas/domains.ts`                                                | rejects a Name Server request without valid step-up token                                     | KILLED_BY_BEHAVIOR |
