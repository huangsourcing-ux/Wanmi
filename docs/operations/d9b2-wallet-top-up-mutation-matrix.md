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
| 服务、调用点、查单、通知、审计与 Collection |         62 | 62/62   |
| 状态迁移与互斥 SQL 谓词                     |         13 | 13/13   |
| CHECK、状态耦合、唯一键、外键与 down 清理   |         68 | 68/68   |
| release policy / manifest                   |          7 | 7/7     |
| **合计**                                    |    **150** | 150/150 |

## 1. 服务与调用点（62/62）

同一认证、A3 能力和 A5 冷静期守卫在创建充值单、创建支付单、确认入账三个调用点分别计数；同一
`recordAuditEvent` 在生命周期四个调用点也分别计数。下表每个反引号 ID 都是一次独立运行。

| 组                        | 独立变异 ID                                                                                                                                                                                                        | 唯一行为用例                                                                                                                                                     | 结果 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| input                     | `amount-requires-safe-integer`; `amount-requires-positive`; `amount-requires-safe-maximum`                                                                                                                         | `rejects every non-positive, fractional, and unsafe top-up amount before writes`                                                                                 | 3/3  |
| funding-source            | `create-rejects-balance-funding`                                                                                                                                                                                   | `rejects using wallet balance as the funding source before creating an order`                                                                                    | 1/1  |
| auth-callpoint            | `create-auth-callpoint`; `payment-auth-callpoint`; `query-auth-callpoint`                                                                                                                                          | `enforces customer authentication at create, payment, and query callpoints`                                                                                      | 3/3  |
| capability-callpoint      | `confirmation-capability-callpoint`; `create-capability-callpoint`; `payment-capability-callpoint`                                                                                                                 | 对应 create/payment/confirmation 的三条 purchase capability 用例                                                                                                 | 3/3  |
| cooldown-callpoint        | `confirmation-cooldown-callpoint`; `create-cooldown-callpoint`; `payment-cooldown-callpoint`                                                                                                                       | 对应 create/payment/confirmation 的三条 identity-risk cooldown 用例                                                                                              | 3/3  |
| shared guards             | `purchase-capability-guard`; `identity-risk-cooldown-guard`                                                                                                                                                        | `enforces purchase capability at the create-order callpoint`; `enforces identity-risk cooldown at the create-order callpoint`                                    | 2/2  |
| query-state               | `unknown-query-keeps-current-state`; `failed-query-keeps-current-state`                                                                                                                                            | `keeps the current state and balance when the active query state is unknown`; `keeps the current state and records unavailable evidence when active query fails` | 2/2  |
| query-shape               | `paid-query-requires-paid-state`; `paid-query-requires-transaction-id`; `paid-query-requires-paid-at`; `paid-query-requires-cny`; `paid-query-requires-safe-integer-amount`; `paid-query-requires-positive-amount` | `rejects a not-paid query even when it carries success-like fields`; 六个 `requires every paid-query evidence dimension: ...` 用例                               | 6/6  |
| query-match               | `merchant-order-match`; `provider-amount-match`; `notification-match-callpoint`; `direct-query-does-not-require-notification`                                                                                      | merchant、amount、notification/query 独立不一致及主动查单成功用例                                                                                                | 4/4  |
| notification-match        | `notification-transaction-match`; `notification-amount-match`; `notification-paid-at-match`                                                                                                                        | `rejects each notification/query disagreement independently: ...`                                                                                                | 3/3  |
| manual-review             | `amount-mismatch-manual-review-callpoint`; `mismatch-reason-uses-amount-result`                                                                                                                                    | `rejects an active-query amount mismatch and creates one scoped manual review`                                                                                   | 2/2  |
| audit                     | `unknown-query-audit-callpoint`; `not-paid-query-audit-callpoint`; `mismatch-query-audit-callpoint`                                                                                                                | unknown、not-paid、amount mismatch 三个 observation 用例                                                                                                         | 3/3  |
| audit                     | `created-audit-callpoint`; `payment-started-audit-callpoint`; `credited-audit-callpoint`; `refunded-audit-callpoint`                                                                                               | `records each top-up lifecycle audit callpoint against the top-up`                                                                                               | 4/4  |
| credit-callpoint          | `post-wallet-credit-callpoint`; `credited-state-update-callpoint`                                                                                                                                                  | `makes repeated confirmation of one top-up add exactly one ledger credit`                                                                                        | 2/2  |
| idempotency               | `credited-replay-transaction-match`                                                                                                                                                                                | `rejects a different WeChat transaction on an already credited top-up`                                                                                           | 1/1  |
| refund-race               | `refunded-state-blocks-late-credit`                                                                                                                                                                                | `serializes credit and original-refund marking to one refunded nonnegative result`                                                                               | 1/1  |
| payment-create            | `payment-create-cas-callpoint`                                                                                                                                                                                     | `claims payment creation once from the created state`                                                                                                            | 1/1  |
| query-precondition        | `active-query-requires-payment-session`                                                                                                                                                                            | `requires an authenticated owner and an existing payment session for active query`                                                                               | 1/1  |
| notification-routing      | `notification-top-up-lookup-callpoint`                                                                                                                                                                             | `does not credit from a payment notification alone when the active query is not paid`                                                                            | 1/1  |
| notification-query-source | `notification-must-query-provider`                                                                                                                                                                                 | `queries WeChat once and rejects a correct paid notification when the active query is not paid`                                                                  | 1/1  |
| refund-guard              | `refund-system-only`; `refund-number-nonblank`; `refund-number-maximum`; `refund-timestamp-valid`; `refund-order-required`                                                                                         | `rejects unauthorized, malformed, missing, and invalid-state refund markers`                                                                                     | 5/5  |
| refund-idempotency        | `refund-replay-number-match`                                                                                                                                                                                       | `makes one original refund number idempotent and rejects a conflicting number`                                                                                   | 1/1  |
| refund-ledger             | `credited-refund-requires-ledger-reversal`; `refund-hold-callpoint`; `refund-capture-callpoint`; `consumed-balance-rejected`; `refunded-state-update-callpoint`                                                    | 未消费余额扣回、已消费余额拒绝两条用例                                                                                                                           | 5/5  |
| collection                | `collection-generic-mutations-denied`; `collection-owner-scoped-read`; `collection-update-hook`; `collection-delete-hook`                                                                                          | `denies generic mutations and preserves top-up orders through hooks`; `scopes reads to the owning customer and links existing evidence collections`              | 4/4  |

### 1.1 通知与主动查单用例承重点复核

以下逐条覆盖以通知或主动查单判定为目标的用例。并发、账本、权限和退款用例虽然也会调用查单，目标是
另一判定点，不作为“通知必须触发服务端主动查单”的证据。三条新增来源证明用例的通知金额均明确设置为
本地充值单金额；故意制造通知/查单不一致的用例则要求查单返回金额与本地金额一致，并断言精确人工复核
原因，避免由金额 CAS 或查单金额不一致分支以错误原因拦下。

| 用例                                                                                            | 真正验证的判定点                                                    | 防止因错误原因通过的行为断言                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `does not credit from a payment notification alone when the active query is not paid`           | D5-04 验签/归档后能路由到充值单，未支付查单不入账                   | 归档 1 条、`not_paid` observation、目标账户 credit 0；该用例不再单独承担“实际调用查单”的证明                                  |
| `queries WeChat once and rejects a correct paid notification when the active query is not paid` | 通知路径必须调用 `queryOrder`，且只认查单 `not_paid`                | 通知金额与本地完全一致；精确断言一次查询及 merchant/trace 参数、`not_paid` observation、人工复核 0、credit 0                  |
| `queries WeChat once and rejects a correct paid notification when the active query is unknown`  | 通知路径必须调用 `queryOrder`，unknown 保持当前状态                 | 同额通知与同额查单；精确断言一次查询、`status_unknown/unknown` observation、人工复核 0、credit 0                              |
| `queries WeChat once and rejects a correct paid notification when the active query fails`       | 通知路径必须调用 `queryOrder`，失败/超时视为 unavailable            | 同额通知；精确断言一次查询、`status_unknown/unavailable` observation、人工复核 0、credit 0                                    |
| `keeps the current state and balance when the active query state is unknown`                    | 客户主动查单的 unknown 分支                                         | `source=query`、`status_unknown/unknown` observation、原状态和 credit 0                                                       |
| `keeps the current state and records unavailable evidence when active query fails`              | 客户主动查单失败分支                                                | 调用结果必须 resolve 为 pending，且 `source=query`、`status_unknown/unavailable` observation 和 credit 0                      |
| `rejects a not-paid query even when it carries success-like fields`                             | `paidQuery` 必须要求 `state=paid`                                   | 其余交易号、时间、CNY 和同额证据均提供；仍保持 pending 且 credit 0                                                            |
| 六个 `requires every paid-query evidence dimension: ...`                                        | 交易号、支付时间、CNY、金额存在、安全整数、正数六个独立 paid 证据门 | 每次只破坏一个维度；断言 `not_paid` observation、pending 和 credit 0                                                          |
| `rejects an active-query amount mismatch and creates one scoped manual review`                  | 服务端查单金额必须等于充值单金额                                    | 查单明确 paid 且 merchant 正确；精确断言 `payment_amount_mismatch` review/observation 和 credit 0                             |
| `requires the active-query merchant order number to match the top-up`                           | 服务端查单商户单号必须匹配                                          | 查单明确 paid、CNY、同额；精确断言 `payment_identifier_mismatch` review 和 credit 0                                           |
| `does not credit when a verified notification disagrees with the active paid query`             | 完整 D5 验签/归档路径中的通知金额与查单金额比较                     | 查单实际调用 1 次且查单金额等于本地；通知才为 `+1`，精确要求 `payment_identifier_mismatch`，因此金额复核/CAS 不能让用例误通过 |
| `rejects each notification/query disagreement independently: transaction id`                    | 通知与查单交易号耦合                                                | 查询 1 次、查单金额等于本地、精确 `payment_identifier_mismatch` review、pending/credit 0                                      |
| `rejects each notification/query disagreement independently: amount`                            | 通知与查单金额耦合                                                  | 查询 1 次且查单金额等于本地；通知才为 `+1`，精确要求 identifier 而非 amount mismatch review                                   |
| `rejects each notification/query disagreement independently: paid timestamp`                    | 通知与查单支付时间耦合                                              | 查询 1 次、查单金额等于本地、精确 `payment_identifier_mismatch` review、pending/credit 0                                      |
| `makes repeated confirmation of one top-up add exactly one ledger credit`                       | 客户主动查单不依赖通知，且重放只入账一次                            | 明确 paid 查单，断言目标 top-up/账户下恰好 1 条 credit 与精确余额                                                             |

审核指定变异把通知路径中的 `provider.queryOrder(...)` 整段替换为由通知字段伪造的 paid 结果。用例
`queries WeChat once and rejects a correct paid notification when the active query is not paid` 单独失败原文为：

```text
RAW_FAILURE AssertionError: expected [] to deeply equal [ { …(2) } ]
RESULT KILLED_BY_BEHAVIOR
TOTAL 1/1
```

恢复实现后新增三条用例 3/3、D9-B-2 integration 51/51 通过；通知/查单相关 `query-state`、
`query-shape`、`query-match`、`notification-match`、`notification-query-source`、
`notification-routing`、`manual-review` 与 `audit` 变异合计 26/26 被指定行为断言杀死。

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

全部变异恢复后，D9-B-2 单元/集成为 60/60，D5 支付通知与 D9-B-1 账本回归合并定向为 114/114；
独立迁移验证为 53 个 CHECK 判定、4 个全局唯一索引、4 个外键及 down 清理全部通过。三个并发用例
分别证明同一充值单 N 路确认只入账一次、同一微信交易号跨 N 个账户恰好一个成功、入账与退款标记
竞争后确定为 refunded 且余额不为负。所有 provider 均为 fixture，`ALLOW_REAL_WECHATPAY*` 和总写闸
保持 false；没有部署、生产访问或真实支付。
