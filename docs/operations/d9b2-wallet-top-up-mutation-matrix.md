# D9-B-2 钱包充值入账安全与正确性判定变异对照表

本表覆盖 D9-B-2 最终源码中的服务调用点、查单证据、通知一致性、人工复核、审计、原路退款判定、
Collection 权限与追加式 Hook、全部原子 SQL 谓词、migration 约束和发布元数据。每次只应用一个删除或
短路变异，运行表中指定的行为用例，并在 `finally` 中恢复原文件。只有非零退出且包含行为断言失败的
运行才计为杀死；编译、装载和变异定位失败均不计入。

可重复执行入口：

```bash
node apps/web/scripts/mutate-d9b2-wallet-top-up-decisions.mjs [group|mutation-id]
node apps/web/scripts/mutate-d9b2-wallet-top-up-sql-predicates.mjs [mutation-id]
node apps/web/scripts/mutate-d9b2-wallet-top-up-migration.mjs [group|mutation-id]
```

最终实跑汇总：

| 层级                                        | 独立变异数 | 结果    |
| ------------------------------------------- | ---------: | ------- |
| 服务、调用点、查单、通知、审计与 Collection |         61 | 61/61   |
| 状态迁移与互斥 SQL 谓词                     |         13 | 13/13   |
| CHECK、状态耦合、唯一键、外键与 down 清理   |         68 | 68/68   |
| release policy / manifest                   |          7 | 7/7     |
| **合计**                                    |    **149** | 149/149 |

## 1. 服务与调用点（61/61）

同一认证、A3 能力和 A5 冷静期守卫在创建充值单、创建支付单、确认入账三个调用点分别计数；同一
`recordAuditEvent` 在生命周期四个调用点也分别计数。下表每个反引号 ID 都是一次独立运行。

| 组                   | 独立变异 ID                                                                                                                                                                                                        | 唯一行为用例                                                                                                                                                     | 结果 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| input                | `amount-requires-safe-integer`; `amount-requires-positive`; `amount-requires-safe-maximum`                                                                                                                         | `rejects every non-positive, fractional, and unsafe top-up amount before writes`                                                                                 | 3/3  |
| funding-source       | `create-rejects-balance-funding`                                                                                                                                                                                   | `rejects using wallet balance as the funding source before creating an order`                                                                                    | 1/1  |
| auth-callpoint       | `create-auth-callpoint`; `payment-auth-callpoint`; `query-auth-callpoint`                                                                                                                                          | `enforces customer authentication at create, payment, and query callpoints`                                                                                      | 3/3  |
| capability-callpoint | `confirmation-capability-callpoint`; `create-capability-callpoint`; `payment-capability-callpoint`                                                                                                                 | 对应 create/payment/confirmation 的三条 purchase capability 用例                                                                                                 | 3/3  |
| cooldown-callpoint   | `confirmation-cooldown-callpoint`; `create-cooldown-callpoint`; `payment-cooldown-callpoint`                                                                                                                       | 对应 create/payment/confirmation 的三条 identity-risk cooldown 用例                                                                                              | 3/3  |
| shared guards        | `purchase-capability-guard`; `identity-risk-cooldown-guard`                                                                                                                                                        | `enforces purchase capability at the create-order callpoint`; `enforces identity-risk cooldown at the create-order callpoint`                                    | 2/2  |
| query-state          | `unknown-query-keeps-current-state`; `failed-query-keeps-current-state`                                                                                                                                            | `keeps the current state and balance when the active query state is unknown`; `keeps the current state and records unavailable evidence when active query fails` | 2/2  |
| query-shape          | `paid-query-requires-paid-state`; `paid-query-requires-transaction-id`; `paid-query-requires-paid-at`; `paid-query-requires-cny`; `paid-query-requires-safe-integer-amount`; `paid-query-requires-positive-amount` | `rejects a not-paid query even when it carries success-like fields`; 六个 `requires every paid-query evidence dimension: ...` 用例                               | 6/6  |
| query-match          | `merchant-order-match`; `provider-amount-match`; `notification-match-callpoint`; `direct-query-does-not-require-notification`                                                                                      | merchant、amount、notification/query 独立不一致及主动查单成功用例                                                                                                | 4/4  |
| notification-match   | `notification-transaction-match`; `notification-amount-match`; `notification-paid-at-match`                                                                                                                        | `rejects each notification/query disagreement independently: ...`                                                                                                | 3/3  |
| manual-review        | `amount-mismatch-manual-review-callpoint`; `mismatch-reason-uses-amount-result`                                                                                                                                    | `rejects an active-query amount mismatch and creates one scoped manual review`                                                                                   | 2/2  |
| audit                | `unknown-query-audit-callpoint`; `not-paid-query-audit-callpoint`; `mismatch-query-audit-callpoint`                                                                                                                | unknown、not-paid、amount mismatch 三个 observation 用例                                                                                                         | 3/3  |
| audit                | `created-audit-callpoint`; `payment-started-audit-callpoint`; `credited-audit-callpoint`; `refunded-audit-callpoint`                                                                                               | `records each top-up lifecycle audit callpoint against the top-up`                                                                                               | 4/4  |
| credit-callpoint     | `post-wallet-credit-callpoint`; `credited-state-update-callpoint`                                                                                                                                                  | `makes repeated confirmation of one top-up add exactly one ledger credit`                                                                                        | 2/2  |
| idempotency          | `credited-replay-transaction-match`                                                                                                                                                                                | `rejects a different WeChat transaction on an already credited top-up`                                                                                           | 1/1  |
| refund-race          | `refunded-state-blocks-late-credit`                                                                                                                                                                                | `serializes credit and original-refund marking to one refunded nonnegative result`                                                                               | 1/1  |
| payment-create       | `payment-create-cas-callpoint`                                                                                                                                                                                     | `claims payment creation once from the created state`                                                                                                            | 1/1  |
| query-precondition   | `active-query-requires-payment-session`                                                                                                                                                                            | `requires an authenticated owner and an existing payment session for active query`                                                                               | 1/1  |
| notification-routing | `notification-top-up-lookup-callpoint`                                                                                                                                                                             | `does not credit from a payment notification alone when the active query is not paid`                                                                            | 1/1  |
| refund-guard         | `refund-system-only`; `refund-number-nonblank`; `refund-number-maximum`; `refund-timestamp-valid`; `refund-order-required`                                                                                         | `rejects unauthorized, malformed, missing, and invalid-state refund markers`                                                                                     | 5/5  |
| refund-idempotency   | `refund-replay-number-match`                                                                                                                                                                                       | `makes one original refund number idempotent and rejects a conflicting number`                                                                                   | 1/1  |
| refund-ledger        | `credited-refund-requires-ledger-reversal`; `refund-hold-callpoint`; `refund-capture-callpoint`; `consumed-balance-rejected`; `refunded-state-update-callpoint`                                                    | 未消费余额扣回、已消费余额拒绝两条用例                                                                                                                           | 5/5  |
| collection           | `collection-generic-mutations-denied`; `collection-owner-scoped-read`; `collection-update-hook`; `collection-delete-hook`                                                                                          | `denies generic mutations and preserves top-up orders through hooks`; `scopes reads to the owning customer and links existing evidence collections`              | 4/4  |

## 2. 原子 SQL 谓词（13/13）

| 独立变异 ID                      | 删除/短路的谓词                                | 唯一行为用例                                                                   | 结果   |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| `confirmation-order-number`      | provider confirmation 按平台充值订单号限定     | `rejects stale order-number and amount snapshots at the confirmation CAS`      | killed |
| `confirmation-expected-state`    | `status = payment_pending`                     | `makes repeated confirmation of one top-up add exactly one ledger credit`      | killed |
| `confirmation-provider-amount`   | 存储金额等于主动查单金额                       | `rejects stale order-number and amount snapshots at the confirmation CAS`      | killed |
| `credited-commit-order-id`       | credited commit 按已认领充值单 id 限定         | `scopes the credited-state commit to the claimed top-up`                       | killed |
| `credited-commit-expected-state` | `status = provider_confirmed`                  | `rolls back credit if the claimed state changes before the credited-state CAS` | killed |
| `payment-create-order-id`        | payment create 按目标充值单 id 限定            | `scopes payment creation and known-failure closing to exactly one top-up`      | killed |
| `payment-create-expected-state`  | `status = created`                             | `claims payment creation once from the created state`                          | killed |
| `payment-close-order-id`         | known-failure close 按目标充值单 id 限定       | `scopes payment creation and known-failure closing to exactly one top-up`      | killed |
| `payment-close-expected-state`   | `status = payment_pending`                     | `does not close a top-up whose state changed during a failed provider create`  | killed |
| `refund-claim-order-id`          | refund claim 按目标充值单 id 限定              | `scopes refund claim and finalization to exactly one top-up`                   | killed |
| `refund-claim-eligible-state`    | refund claim 只接受 pending/confirmed/credited | `rejects unauthorized, malformed, missing, and invalid-state refund markers`   | killed |
| `refund-final-order-id`          | refunded commit 按目标充值单 id 限定           | `scopes refund claim and finalization to exactly one top-up`                   | killed |
| `refund-final-expected-state`    | `status = refund_pending`                      | `rolls back a refund if the claimed state changes before finalization`         | killed |

TOCTOU 用例在 provider query 回调中改变订单号或金额；final commit 用例用本地 PostgreSQL trigger 在
`postWalletCredit` / `captureWalletHold` 与最终状态提交之间改变目标状态，确保每个 SQL 谓词都由运行时
行为承重，而不是源码文本断言。

## 3. Migration 与发布元数据（75/75）

迁移验证器在独立临时数据库实际执行 UP、非法 UPDATE/INSERT 和 DOWN。每个 CHECK 条件删除后必须
出现 `accepted an invalid write`；唯一索引或外键删除后必须接受原本禁止的写入；DOWN 清理缺失必须
留下表、关系列或 enum。发布元数据变异由 release contract verifier 独立拒绝。

| 组                           | 独立变异 ID                                                                                                                                                                                                                                                                                             | 行为断言                                                         | 结果 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---- |
| check                        | `amount-integer`; `amount-positive`; `amount-safe-maximum`                                                                                                                                                                                                                                              | 金额必须为正安全整数分                                           | 3/3  |
| check                        | `platform-order-number-format`; `ledger-key-nonblank`; `wechat-transaction-nonblank`; `refund-number-nonblank`                                                                                                                                                                                          | 四类标识格式/非空                                                | 4/4  |
| created state                | `created-status`; `created-payment-channel-absent`; `created-payment-expiry-absent`; `created-transaction-absent`; `created-provider-paid-absent`; `created-provider-confirmation-absent`; `created-credit-absent`; `created-refund-number-absent`; `created-refund-time-absent`                        | created 状态证据必须全部为空                                     | 9/9  |
| pending/closed/unknown state | `pending-status`; `pending-payment-channel-present`; `pending-payment-expiry-present`; `pending-transaction-absent`; `pending-provider-paid-absent`; `pending-provider-confirmation-absent`; `pending-credit-absent`; `pending-refund-number-absent`; `pending-refund-time-absent`                      | 已创建支付会话且尚无成功、入账或退款证据                         | 9/9  |
| provider-confirmed state     | `confirmed-status`; `confirmed-payment-channel-present`; `confirmed-payment-expiry-present`; `confirmed-transaction-present`; `confirmed-provider-paid-present`; `confirmed-provider-confirmation-present`; `confirmed-credit-absent`; `confirmed-refund-number-absent`; `confirmed-refund-time-absent` | 主动查单成功证据齐全且尚未入账/退款                              | 9/9  |
| credited state               | `credited-status`; `credited-payment-channel-present`; `credited-payment-expiry-present`; `credited-transaction-present`; `credited-provider-paid-present`; `credited-provider-confirmation-present`; `credited-credit-present`; `credited-refund-number-absent`; `credited-refund-time-absent`         | 主动查单与入账证据齐全且尚未退款                                 | 9/9  |
| refund-pending state         | `refundPending-status`; `refundPending-payment-channel-present`; `refundPending-payment-expiry-present`; `refundPending-refund-number-present`; `refundPending-refund-time-absent`                                                                                                                      | 原路退款单号存在且退款时间尚无                                   | 5/5  |
| refunded state               | `refunded-status`; `refunded-payment-channel-present`; `refunded-payment-expiry-present`; `refunded-refund-number-present`; `refunded-refund-time-present`                                                                                                                                              | 原路退款单号和退款时间齐全                                       | 5/5  |
| unique                       | `platform-order-number-unique`; `wechat-transaction-unique`; `ledger-key-unique`; `refund-number-unique`                                                                                                                                                                                                | 四个标识均由数据库全局唯一索引保护                               | 4/4  |
| foreign-key                  | `top-up-customer-fk`; `top-up-account-fk`; `notification-archive-top-up-fk`; `manual-review-top-up-fk`                                                                                                                                                                                                  | customer/account/archive/review 引用完整性                       | 4/4  |
| down                         | `notification-archive-column`; `manual-review-column`; `top-up-table`; `currency-enum`; `funding_source-enum`; `payment_channel-enum`; `status-enum`                                                                                                                                                    | DOWN 精确清理新增结构                                            | 7/7  |
| release-metadata             | `release-policy-entry-exact`; `release-policy-new-code-compatible-before-up`; `release-policy-old-code-compatible`; `release-policy-expand-phase`; `release-policy-specific-reason`; `release-policy-retain-rollback`; `release-manifest-entry-exact`                                                   | additive expand、retain rollback、旧代码兼容和 manifest 精确顺序 | 7/7  |

## 4. 恢复后基线

全部变异恢复后，D9-B-2 单元/集成为 57/57，D5 支付通知与 D9-B-1 账本回归合并定向为 105/105；
独立迁移验证为 53 个 CHECK 判定、4 个全局唯一索引、4 个外键及 down 清理全部通过。三个并发用例
分别证明同一充值单 N 路确认只入账一次、同一微信交易号跨 N 个账户恰好一个成功、入账与退款标记
竞争后确定为 refunded 且余额不为负。所有 provider 均为 fixture，`ALLOW_REAL_WECHATPAY*` 和总写闸
保持 false；没有部署、生产访问或真实支付。
