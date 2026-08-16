# D9-A A5 账户找回安全判定变异对照表

- 日期：2026-08-16
- 分支：`codex/d9-a5-account-recovery`
- 可重复执行入口：`node apps/web/scripts/mutate-a5-security-decisions.mjs [group|mutation-id]`
- 完整逐点清单：`node apps/web/scripts/mutate-a5-security-decisions.mjs --list`
- 计入标准：定向 Vitest 必须非零退出且输出 `AssertionError:`；编译、装载、变异定位或其他非行为失败不计为杀死。
- 运行规则：每次只写入一个变异，运行唯一能杀死它的行为用例，并在 `finally` 恢复原文件。全部源码恢复后，A5 定向套件 39/39 通过。
- 结果：140/140 `KILLED_BY_BEHAVIOR`；无 survivor，无非行为失败被计入结果。

## 汇总

| 分组                  |    数量 | 主要文件                                            | 结果               |
| --------------------- | ------: | --------------------------------------------------- | ------------------ |
| schema                |      32 | `apps/web/src/schemas/auth.ts`                      | 32/32 KILLED       |
| route                 |      15 | A5 公共申请/管理员审核路由                          | 15/15 KILLED       |
| request-guards        |       7 | `apps/web/src/services/auth/account-recovery.ts`    | 7/7 KILLED         |
| request-recording     |      10 | `apps/web/src/services/auth/account-recovery.ts`    | 10/10 KILLED       |
| reviewer              |       4 | `apps/web/src/services/auth/account-recovery.ts`    | 4/4 KILLED         |
| state                 |       9 | `apps/web/src/services/auth/account-recovery.ts`    | 9/9 KILLED         |
| decision              |      22 | `apps/web/src/services/auth/account-recovery.ts`    | 22/22 KILLED       |
| sql-evidence          |      10 | 证据联表查询                                        | 10/10 KILLED       |
| sql-state             |      13 | 审核 claim、请求记录、冷静期 CAS                    | 13/13 KILLED       |
| sql-session           |       2 | `apps/web/src/services/auth/customer-sessions.ts`   | 2/2 KILLED         |
| identity-notification |       2 | `apps/web/src/services/auth/customer-identities.ts` | 2/2 KILLED         |
| cooldown-gate         |       4 | `apps/web/src/services/auth/step-up.ts`             | 4/4 KILLED         |
| append-access         |       6 | `apps/web/src/collections/identity.ts`              | 6/6 KILLED         |
| audit                 |       4 | `apps/web/src/services/audit/record-audit-event.ts` | 4/4 KILLED         |
| **合计**              | **140** |                                                     | **140/140 KILLED** |

## 逐点清单

下列每个 ID 都是一次独立的删除或短路变异；脚本中的同名项同时固定了精确文件、替换片段和唯一行为用例。组级结果不是抽样：该组所列每个 ID 都实际运行并得到 `KILLED_BY_BEHAVIOR`。

### schema（32/32）

`request-full-name-required`, `request-full-name-trimmed`, `request-full-name-minimum`, `request-full-name-maximum`, `request-order-number-required`, `request-order-number-trimmed`, `request-order-number-minimum`, `request-order-number-maximum`, `request-document-number-required`, `request-document-number-trimmed`, `request-document-number-minimum`, `request-document-number-maximum`, `request-payment-transaction-required`, `request-payment-transaction-trimmed`, `request-payment-transaction-minimum`, `request-payment-transaction-maximum`, `request-phone-required`, `request-phone-trimmed`, `request-phone-minimum`, `request-phone-maximum`, `request-phoneUnavailable-required`, `request-phoneUnavailable-must-be-true`, `request-wechatUnavailable-required`, `request-wechatUnavailable-must-be-true`, `request-schema-strict`, `decision-conclusion-required`, `decision-conclusion-enum`, `decision-note-required`, `decision-note-trimmed`, `decision-note-minimum`, `decision-note-maximum`, `decision-schema-strict`。

行为用例：`requires every evidence field, both unavailable-channel declarations, and no unknown fields`；`requires one approved/rejected conclusion, a bounded note, and no unknown fields`。

### route（15/15）

`public-content-type`, `public-declared-finite`, `public-declared-nonnegative`, `public-declared-maximum`, `public-actual-maximum`, `public-malformed-json`, `admin-content-type`, `admin-declared-finite`, `admin-declared-nonnegative`, `admin-declared-maximum`, `admin-actual-maximum`, `admin-malformed-json`, `admin-review-id-integer`, `admin-review-id-positive`, `admin-system-role-gate`。

行为用例：`rejects non-JSON request bodies before creating a Payload request`、`rejects invalid or oversized declared request lengths before reading evidence`、`rejects an oversized actual UTF-8 account-recovery body`、`maps malformed JSON to the stable invalid-request response`、`rejects non-JSON, malformed, and oversized review bodies before authentication`、`rejects invalid review ids before authentication`、`fails closed when the system-admin request gate rejects`。

### request-guards（7/7）

`positive-id-safe-integer`, `positive-id-positive`, `phone-channel-unavailable`, `wechat-channel-unavailable`, `phone-normalization-fails-before-query`, `evidence-query-error-fails-closed`, `evidence-row-required`。

行为用例覆盖非法 ID、手机/微信两个独立声明、手机号规范化前置拒绝、证据存储故障关闭和缺失证据行稳定错误映射。

### request-recording（10/10）

`manual-review-reason`, `manual-review-open-status`, `request-record-event`, `request-record-unavailable-providers`, `request-record-realname-evidence`, `request-record-order-evidence`, `request-record-payment-evidence`, `request-record-occurred-at`, `request-security-event`, `request-audit-action`。

行为用例：`submits verified real-name, historical-order, and confirmed-payment evidence to manualReviews`；所有计数断言均限定 customer、reason、event/action 或 request key。

### reviewer（4/4）

`reviewer-system-admin-role`, `reviewer-principal-id-match`, `reviewer-id-safe-integer`, `reviewer-id-positive`。

行为用例：`rejects non-system-admin and mismatched reviewer identities before consuming a conclusion`，分别覆盖错误角色、禁用管理员、principal 不匹配、非整数及非正 ID。

### state（9/9）

`state-query-error-fails-closed`, `state-row-required`, `state-row-customer-match`, `state-status-whitelist`, `state-restrictions-parse-error`, `restricted-state-requires-restrictions`, `nonrestricted-state-forbids-restrictions`, `cooldown-timestamp-finite`, `approved-status-whitelist`。

行为用例覆盖查询失败、缺行/错行、未知状态、限制损坏、状态/限制不变量、无效冷静期时间和允许恢复状态白名单。

### decision（22/22）

`claim-miss-fails-closed`, `request-key-required`, `approved-branch-required`, `rejected-branch-has-no-approval-effects`, `suspended-restores-through-a3`, `cooldown-duration`, `revoke-all-sessions-invoked`, `old-identities-loaded`, `old-identities-required`, `decision-record-event`, `decision-record-conclusion`, `decision-record-reviewer`, `decision-record-note`, `decision-record-occurred-at`, `decision-record-cooldown-start`, `decision-record-cooldown-end`, `decision-record-request-key`, `decision-record-revoked-count`, `decision-security-event`, `decision-audit-action`, `approved-notification-branch`, `notify-every-old-identity`。

行为用例覆盖一次性 claim、A3 恢复、批准/拒绝分支、撤销旧会话、所有旧渠道、追加式结论字段、审计/安全事件和通知全量性。

### sql-evidence（10/10）

`evidence-realname-owner-join`, `evidence-order-owner-join`, `evidence-payment-order-join`, `evidence-customer-phone`, `evidence-realname-full-name`, `evidence-realname-document`, `evidence-order-number`, `evidence-payment-transaction`, `evidence-payment-signature`, `evidence-payment-confirmed`。

行为用例：`keeps every evidence ownership and proof predicate behaviorally necessary`。三个 JOIN 所有权谓词和七个 WHERE 证据谓词逐个删除；每次仅对应错配证据被错误接受，因而由行为断言单独杀死。

### sql-state（13/13）

`claim-review-id`, `claim-recovery-reason`, `claim-open-status`, `state-select-customer-id`, `request-record-review-id`, `request-record-submitted-event`, `request-record-realname-evidence`, `request-record-order-evidence`, `request-record-payment-evidence`, `cooldown-customer-id`, `cooldown-expected-status`, `cooldown-expected-restrictions`, `cooldown-expected-prior-value`。

行为用例覆盖审核结论 `UPDATE … WHERE … RETURNING` 的三项 claim 谓词、锁定状态的 customer 谓词、不可变申请记录的五项谓词，以及冷静期 CAS 的四项谓词。

### sql-session（2/2）

`session-revoke-customer-id`, `session-revoke-active-only`。

主批准用例同时创建其他客户的活动会话与目标客户已撤销会话，分别杀死 customer 范围和 `revoked_at IS NULL` 谓词删除。

### identity-notification（2/2）

`identity-selection-customer`, `identity-selection-active-status`。

主批准用例同时存在其他客户身份和目标客户已解绑身份，分别杀死 customer 与 active 状态筛选删除；通知结果按 provider 追加记录并限定目标 customer 计数。

### cooldown-gate（4/4）

`cooldown-domain-management-password`, `cooldown-domain-lock-disable`, `cooldown-name-server-change`, `cooldown-real-name-information-change`。

四次分别删除同一个 A4 冷静期调用，但每次只运行一个 purpose：`domain_management_password`、`domain_lock_change`、`nameserver_change`、`realname_change`。每项都从“拒绝且 grant 未消费”变为放行，因此各自由独立行为断言杀死。

### append-access（6/6）

`record-create-access-denied`, `record-update-access-denied`, `record-delete-access-denied`, `record-read-system-admin-only`, `record-update-append-only-hook`, `record-delete-append-only-hook`。

行为用例分别验证 collection access 与 `beforeChange`/`beforeDelete`；overrideAccess 下仍不可改写或删除，普通用户不能创建、读取、更新或删除。

### audit（4/4）

`requested-audit-actor-type`, `decided-audit-actor-type`, `requested-audit-target-type`, `decided-audit-target-type`。

行为用例验证申请只允许 anonymous actor、结论只允许 admin actor，且两者 target type 均为 customer。

## 最终恢复验证

变异完成后执行：

```text
pnpm --filter @wanmi/web typecheck
pnpm --filter @wanmi/web exec vitest run --config vitest.config.mts \
  tests/unit/account-recovery-route.test.ts \
  tests/integration/d9a-account-recovery.integration.test.ts
```

结果：2 个文件、39 个用例全部通过；`git diff --check` 通过。完整 `make check` 结果记录在开发日志和 PR 报告中。
