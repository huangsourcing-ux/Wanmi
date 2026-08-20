# D9-E-3 永久 VIP 等级判定点、变异与风险对照

日期：2026-08-20

## 1. 范围与结果

本切片只实现开发计划 16.10 E2 的永久 VIP 等级八项。最终判定点按实际调用点计数：

| 层级                                  | 数量 | 可执行清单                                                        | 最终结果 |
| ------------------------------------- | ---: | ----------------------------------------------------------------- | -------- |
| service / collection / coupling       |   51 | `node apps/web/scripts/mutate-d9e3-vip-decisions.mjs --list`      | 51/51    |
| SQL / 数据来源 / 作用域 / 顺序 / 互斥 |   35 | `node apps/web/scripts/mutate-d9e3-vip-sql-predicates.mjs --list` | 35/35    |
| migration / release / down            |   70 | `node apps/web/scripts/mutate-d9e3-vip-migration.mjs --list`      | 70/70    |
| 合计                                  |  156 | 三份清单逐行输出 ID、判定与指定行为用例                           | 156/156  |

每个变异只在内存或单次测试进程中替换一个判定点，测试完成后恢复源码。计入结果必须同时满足：变异进程非零退出、输出包含指定 `AssertionError`，且不是编译错误、SQL 语法错误或非目标异常。所有计数断言均带 customer、order、event type、source、approval 或 event key 等 `where` 限定。

## 2. Service、Collection 与耦合判定点（51）

以下每个 ID 都是独立变异项；完整文件、指定用例与原始失败由 `mutate-d9e3-vip-decisions.mjs --list` 输出。

### 2.1 权限、输入与规则发布（20）

1. `configuration-scope`
2. `publish-schema`
3. `promotion-schema`
4. `appeal-schema`
5. `rule-rank-canonical-order`
6. `rule-rank-contiguous`
7. `rule-code-unique`
8. `rule-threshold-strict`
9. `rule-effective-not-past`
10. `rule-previous-rank-retained`
11. `rule-previous-code-retained`
12. `notice-display-name`
13. `notice-service-content`
14. `notice-quota-benefits`
15. `notice-quota-key-order`
16. `notice-lead-time`
17. `rule-publication-serialization`
18. `advance-notification-branch`
19. `advance-notification-each-holder`
20. `publish-audit`

### 2.2 累计、达成、提升与纠错（18）

1. `natural-order-status`
2. `natural-payment-channel`
3. `natural-no-rule-no-achievement`
4. `natural-skip-achieved-rank`
5. `natural-threshold`
6. `promotion-must-raise`
7. `correction-approval-context`
8. `correction-source`
9. `correction-safe-amount`
10. `correction-nonnegative-amount`
11. `correction-current-tier-exists`
12. `correction-target-exists`
13. `correction-must-lower`
14. `correction-not-over-spend`
15. `correction-zero-does-not-invent-debit`
16. `status-customer-auth`
17. `appeal-customer-auth`
18. `appeal-correction-only`

### 2.3 数据契约、追加式保护与既有能力耦合（13）

1. `bigint-threshold-comparison`
2. `generic-write-deny`
3. `append-update-hook`
4. `append-delete-hook`
5. `four-source-enum`
6. `independent-identity-field`
7. `transactional-notification-type`
8. `not-marketing-notification`
9. `succeeded-transition-coupling`
10. `refunded-transition-coupling`
11. `approval-context-binding`
12. `approval-domain-executor`
13. `approval-correction-source-binding`

## 3. SQL、权威来源、互斥与确定性判定点（35）

每一行删除或短路后只由所列行为断言杀死；这包括重点要求的“把等级来源从事件高水位替换为当前累计额”。

| ID                                      | 判定                                       | 指定行为用例                                                                           |
| --------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `rule-effective-window`                 | 排除未来规则                               | `counts a successful order but creates no achievement before the first effective rule` |
| `rule-inclusive-boundary`               | 精确生效时刻包含规则                       | `selects the highest version when two rules have the same effective time`              |
| `rule-version-tie-breaker`              | 同生效时间取最高 version                   | 同上                                                                                   |
| `levels-rule-id-scope`                  | level 属于所选 rule row                    | `iterates physically reversed rule rows by rank and records every crossed tier`        |
| `levels-version-binding`                | level 重复绑定不可变 version number        | `fails closed when a rule level carries another version number`                        |
| `levels-rank-order`                     | 跨越等级按 rank 升序追加                   | `iterates physically reversed rule rows by rank and records every crossed tier`        |
| `holder-customer-order`                 | 通知持有人按 customer 升序                 | `notifies current holders in deterministic ascending customer order`                   |
| `holder-customer-present`               | 通知排除已匿名化、无 customer 关系的历史   | 同上                                                                                   |
| `holder-current-event-id-tie`           | 同时刻持有人状态按较高 event id            | `does not notify a corrected-to-zero former holder when event timestamps tie`          |
| `holder-positive-current-tier`          | 只通知当前 rank > 0                        | 同上                                                                                   |
| `customer-lock-scope`                   | 互斥锁定准确 customer 且为排他锁           | `serializes different succeeded orders so one customer reaches each rank exactly once` |
| `spend-credit-source`                   | 只把 `succeeded_order` 作为正向累计        | `counts the frozen payable amount for successful native orders`                        |
| `spend-order-reversal-source`           | 普通退款冲销从累计额扣除                   | `subtracts an independently recorded reversal before evaluating a later achievement`   |
| `spend-data-correction-source`          | 数据纠错扣减累计额                         | `records data correction as an approved append-only event and matching audit fact`     |
| `spend-fraud-reversal-source`           | 欺诈撤销扣减累计额                         | `records fraud reversal as an approved append-only event and matching audit fact`      |
| `spend-customer-scope`                  | 累计事实限定 customer                      | `scopes cumulative spend and tier history to the authenticated customer`               |
| `tier-event-customer-scope`             | 等级事件限定 customer                      | 同上                                                                                   |
| `tier-event-latest-time-source`         | 当前等级先取最新事件时间                   | `orders current tier by event time before using the id tie-breaker`                    |
| `tier-source-replaced-by-current-spend` | 当前等级只读追加式事件，不按当前累计额重算 | `keeps the achieved historical high-water tier after an ordinary refund reversal`      |
| `order-authoritative-table`             | 权威来源为 commerce `orders`，不是充值订单 | `excludes a wallet top-up itself from cumulative VIP spend`                            |
| `order-id-scope`                        | 读取准确 order id                          | `counts the frozen payable amount for successful native orders`                        |
| `order-frozen-amount-source`            | 金额取冻结 `amount_minor`                  | 同上                                                                                   |
| `order-payment-channel-source`          | 渠道取订单 `payment_channel`               | `counts the frozen payable amount for successful h5 orders`                            |
| `order-native-channel`                  | native 纳入                                | native 用例                                                                            |
| `order-h5-channel`                      | h5 纳入                                    | h5 用例                                                                                |
| `order-balance-channel`                 | balance 纳入                               | balance 用例                                                                           |
| `order-share-lock`                      | 资格读取对并发状态写持共享锁               | `waits for an in-flight order-state write before deciding succeeded eligibility`       |
| `spend-entry-idempotency`               | 成功订单事实唯一冲突键                     | `records exactly one achievement when the same customer triggers it concurrently`      |
| `reversal-source-order`                 | 冲销读取准确 source order                  | `records a refunded-order reversal once while preserving the achieved tier`            |
| `reversal-success-fact`                 | 冲销要求先有成功事实                       | 同上                                                                                   |
| `reversal-refunded-order-state`         | 冲销要求权威订单已为 `refunded`            | `does not reverse a VIP spend fact before the order is actually refunded`              |
| `reversal-entry-idempotency`            | 冲销事实唯一冲突键                         | refunded-order reversal 用例                                                           |
| `history-event-time-order`              | 当前等级和用户历史先按时间降序             | event-time 用例                                                                        |
| `history-event-id-tie-breaker`          | 同时间按较高 ID 确定性兜底                 | same-event-time 用例                                                                   |
| `appeal-local-api-access`               | 申诉目标使用 `user + overrideAccess:false` | `rejects an appeal for another customer correction record`                             |

## 4. Migration 与发布判定点（70）

完整 predicate 由 `mutate-d9e3-vip-migration.mjs --list` 逐项输出。这里按调用点保留全部 ID，防止把多个数据库围栏合并成一项计数。

### 4.1 表、枚举与通知类别（20）

`table-vip-tier-rule-versions`、`table-vip-tier-rule-levels`、`table-vip-spend-entries`、`table-vip-tier-events`、`table-vip-tier-appeals`、`event-source-natural-achievement`、`event-source-operational-promotion`、`event-source-data-correction`、`event-source-fraud-reversal`、`spend-type-succeeded-order`、`spend-type-order-reversal`、`spend-type-data-correction`、`spend-type-fraud-reversal`、`payment-channel-native`、`payment-channel-h5`、`payment-channel-balance`、`event-type-tier-achievement`、`event-type-tier-correction`、`notification-type`、`notification-transactional-category`。

### 4.2 唯一性与幂等（8）

`rule-version-unique`、`tier-rank-unique`、`tier-code-unique`、`spend-entry-key-unique`、`spend-order-type-unique`、`tier-event-key-unique`、`appeal-key-unique`、`appeal-customer-event-unique`。

### 4.3 规则、累计、事件与申诉值域及历史保留（36）

`rule-version-integer`、`rule-schema-version`、`rule-notice-before-effect`、`rule-publisher-required`、`rule-change-note-required`、`level-version-integer`、`level-rank-positive`、`level-threshold-positive`、`level-code-format`、`level-display-name-required`、`level-service-required`、`level-benefits-object`、`spend-amount-integer`、`spend-reference-required`、`spend-success-channel`、`spend-reversal-no-channel`、`spend-correction-approval`、`achievement-source`、`spend-source-order-set-null`、`tier-trigger-order-set-null`、`tier-rule-version-set-null`、`spend-customer-set-null`、`tier-customer-set-null`、`appeal-customer-set-null`、`promotion-no-order`、`zero-tier-no-code`、`correction-source`、`correction-lowers-tier`、`correction-approval`、`correction-visible-reference`、`event-tier-name-required`、`event-service-required`、`event-reason-required`、`event-benefits-object`、`event-cumulative-nonnegative`、`appeal-statement-minimum`。

数据库行为验证额外发现并修复了 PostgreSQL `CHECK` 对 NULL 返回 unknown 会放行的问题：纠错事件现同时要求 `correction_reference IS NOT NULL` 和 trim 后非空，不能只依赖 `length(trim(...)) > 0`。

### 4.4 回滚与发布（6）

`down-notification-drain-guard`、`release-phase`、`release-new-code-compatibility`、`release-old-code-compatibility`、`release-retain-rollback`、`release-manifest-exactly-once`。

## 5. 用户指定的独立行为证据

| 要求                   | 独立用例                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 达成后普通退款不降级   | `keeps the achieved historical high-water tier after an ordinary refund reversal`                          |
| 门槛提高保留旧等级     | `keeps an achieved tier after a later rule raises its threshold`                                           |
| 排除充值               | `excludes a wallet top-up itself from cumulative VIP spend`                                                |
| 排除取消               | `excludes a cancelled order from cumulative VIP spend`                                                     |
| 排除失败/退款状态订单  | `excludes a failed and refunded order from cumulative VIP spend`，并由其它状态参数化用例逐状态保护         |
| 排除已冲销金额         | `subtracts an independently recorded reversal before evaluating a later achievement`                       |
| 只计 succeeded         | `counts only succeeded orders and independently excludes status <status>` 对其它八态逐态运行               |
| 三渠道与冻结金额       | native / h5 / balance 三个独立 `counts the frozen payable amount...` 用例                                  |
| 未审批不能降级         | `requires B-5 request, approval, cooldown and execution for a corrective downgrade`                        |
| 历史记录零修改         | `never modifies the original achievement when a correction is appended` 对达成记录逐字段比较               |
| 四类来源与审计         | 四个 `records <source> as an append-only event and matching audit fact` 用例                               |
| 无独立 VIP 身份字段    | `contains no independent VIP identity field in collections or generated customer types`                    |
| 同用户并发达成恰好一条 | `records exactly one achievement when the same customer triggers it concurrently` 与 12 个不同订单并发用例 |

## 6. 排序与迭代确定性

- 规则选择：`effective_at DESC, version DESC`，同时间 version 兜底单独变异；
- 等级迭代：输入先按 `tierRank`、`tierCode` 规范化，数据库 level 按 rank 升序；反转输入与反转物理行分别验证；
- 当前等级/历史：先取最大 `occurredAt`，同时间以较高 event ID 兜底；时间与 ID 各一条行为变异；
- 通知持有人：最新事件按 `occurredAt DESC, id DESC`，客户按 ID 升序；两类兜底各自变异；
- quota JSON：key 顺序规范化，避免仅键序不同误触发权益调整通知。

## 7. A4 风险分级逐项对照

| A4 操作                                | 本切片影响                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| 添加普通子域解析                       | 不涉及；保持当前会话 + 审计                                             |
| 根域 A/CNAME/AAAA、全部主机 MX/TXT、NS | 不涉及；不改变 step-up + 二次确认                                       |
| 批量删除解析                           | 不涉及；不改变 step-up + 变更预览                                       |
| 关闭域名锁                             | 不涉及；不改变 step-up + 通知                                           |
| 修改实名信息                           | 不涉及；不改变 step-up + 二次确认                                       |
| 获取/修改域名管理密码                  | 不涉及；不改变 purpose-bound step-up、active 渠道存在性与事后全渠道告知 |
| 交互式余额消费                         | 不涉及；VIP 只读订单冻结金额和追加式事实，不发起余额消费                |
| 注销申请                               | 不涉及；不改变 step-up + 冷静期                                         |
| 找回/换绑后的冷静期                    | 不涉及；不新增可绕过冷静期的域名操作                                    |

本切片新增操作的实际档位：自然达成为系统侧订单状态后置记账；等级/权益发布与运营提升要求 active `system_admin` 的 `system_configuration` scope 并审计；纠错性降级属于 B-5 `vip_fraud_correction`，必须经过发起、异人审批、冷静延迟、执行四个状态门；客户等级读取和申诉为当前已认证会话，申诉只能引用本人可见的纠错事件。它们均不属于 A4 九项交互式域名/资金动作，没有新增或降低 A4 step-up 档位。

## 8. Fixture 与真实闸门

最终测试使用独立本地 PostgreSQL fixture 数据库；`ALLOW_REAL_PROVIDER_WRITES=false`、`ALLOW_REAL_SMS_SEND=false`。没有部署、生产访问、真实支付、真实域名、真实短信或真实微信写入。迁移 verifier 每次创建精确命名的临时数据库并在 `finally` 删除；变异只注入 base64 内存源码，不改生产配置。
