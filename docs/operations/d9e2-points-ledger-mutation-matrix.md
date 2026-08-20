# D9-E-2 米币账本安全与正确性变异矩阵

## 1. 范围与结论

本切片只实现 16.10 E1 的五项：独立追加式米币账本、确定性批次分配、赚取幂等与原子消耗、工具额度兑换、米币与余额数据层隔离。没有实现或留桩 VIP 等级、邀请体系、反滥用监控、等级加速、订单折扣或米币/余额兑换。

最终定向结果：

| 层                                    | 按调用点计数 |    结果 | 执行器                                                   |
| ------------------------------------- | -----------: | ------: | -------------------------------------------------------- |
| 服务、Collection、Job 判定            |           81 |   81/81 | `apps/web/scripts/mutate-d9e2-points-decisions.mjs`      |
| SQL 作用域、来源、CAS、原子授权、排序 |           52 |   52/52 | `apps/web/scripts/mutate-d9e2-points-sql-predicates.mjs` |
| migration、约束、外键、release、down  |          101 | 101/101 | `apps/web/scripts/mutate-d9e2-points-migration.mjs`      |
| 合计                                  |          234 | 234/234 | 每个变异均出现指定行为 `AssertionError`                  |

恢复全部源码后，D9-E-2 聚焦基线为 2 个文件、40/40 用例通过（集成 33、单元 7）。所有测试数据均为本地 PostgreSQL fixture，没有调用真实 provider、生产环境或任何外部写接口。

## 2. 指定独立行为用例

| 要求                 | 独立用例与行为断言                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a. 消耗原子不透支    | `atomically consumes to the exact boundary under N concurrent redemptions without overdraft`：N 路同时消费到边界，只有额度允许的请求成功，按限定 customer/account 的账本重算不为负。    |
| b. 赚取幂等          | `concurrently earns one pending entry for one earning idempotency key`：N 路同键只留下一个 batch 和一条 pending fact。                                                                  |
| c. 分配确定性        | `allocates deterministically by earliest expiry and then ascending batch id on replay`：同一 redemption 重放逐条比较 allocation，按 expiry ASC、id ASC 完全一致。                       |
| d. pending 退款反转  | `reverses a refunded pending reward without ever creating available points`：只追加 reversed，不出现 available。                                                                        |
| e. 过期只追加        | `expires only by appending an expired entry and leaves every historical row unchanged`：过期前后历史行快照逐字段一致且 delete/update 为零。                                             |
| f. allocation 可重算 | `recomputes remaining expirable points from cross-batch allocations`：跨批次消费后，以 allocation 重算各批次剩余值并与过期量核对。                                                      |
| g. 米币与余额无兑换  | `has no points-wallet conversion path in either direction` 和单元用例 `keeps points and wallet isolated in distinct collections and fields`：服务依赖、表、字段和业务入口均无互转路径。 |
| h. 不影响订单金额    | `does not change an order payable amount when points are redeemed`：兑换前后订单冻结应付金额及支付字段逐项不变。                                                                        |

并发用例彼此独立：同 earning key N 路赚取；边界 N 路兑换；N 路消费与 N 路 expiration runner 同时执行；另有 N 路 pending 确认。所有结果均使用带 customer、account、batch、redemption、entry type 或 key 的 `where` 计数，测试 helper 拒绝无 `where` 的计数调用。

## 3. 数据来源替换与 fixture 去相关

| 被判定字段                                               | 可能误相关的字段            | 去相关 fixture / 用例                                                                                                                  |
| -------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| order.customer_id                                        | batch/customer 输入         | `reads order owner and status independently and applies A3 before earning` 让请求 customer 与订单 owner 可独立变化。                   |
| entry.customer_id/account_id/batch_id                    | batch 的同名归属            | `fails closed for every independently corruptible points-balance invariant` 分别只改一条 entry 关联。                                  |
| allocation.customer_id/account_id/redemption_id/batch_id | redemption/batch 的同名归属 | 同一用例逐字段制造孤立损坏；计数限定目标 allocation。                                                                                  |
| 剩余批次的 allocation 合计                               | consumed entry 合计         | `uses allocations rather than correlated consumed entries as the remaining-batch source` 故意让两者数值不同。                          |
| pending/available/held/consumed/expired/reversed 来源    | 同批次其他生命周期列        | 生命周期来源替换变异逐列交换；fixture 单独破坏 terminal/transition fact。                                                              |
| quota target                                             | 同账户其他 quota target     | `fails closed for each quota-ledger invariant and scopes balance to the requested target` 同时放入不同 target、不同余额。              |
| ledger_version                                           | quota_ledger_version        | `scopes every points and quota CAS update to the exact account at equal versions` 使用两个账户和相等版本，避免版本差异替代账户作用域。 |
| expiry                                                   | job 已扫描状态              | `excludes elapsed but unswept batches in both allocation and atomic reservation` 构造已过期但尚未 job 冲销的批次。                     |
| allocation 外键                                          | redemption+batch 唯一键     | migration verifier 为数值约束和 customer/account/redemption/batch 四个外键分别使用不冲突批次，避免唯一键先行拒绝。                     |
| 小数约束                                                 | 最小值约束                  | migration verifier 使用 1.5 测整数性，使用 0 测下界，分别杀死两个约束。                                                                |

首轮变异发现 16 个服务谓词与 6 个 SQL 谓词被更强的不变量完全蕴含；这些谓词已从生产源码删除，而不是从报告中静默忽略。包括重复的 held/consumed/allocation 非负判断、重复 batch 生命周期检查、由唯一 account 关系蕴含的 customer 判断，以及 spendable 与 reservation 中重复的 account/expiry 预筛选。剩余联合授权条件以组合变异验证，避免把一个业务决定重复计数。

## 4. A4 风险分级逐项对照

本切片不新增 A4 表中的高风险域名、余额或注销操作，也不改变任何既有 step-up/cooldown。米币不是人民币余额：米币兑换只产生不可变现的工具额度，因此不能沿用“余额消费（交互式）”来暗示存在资金兑换；它使用 A3 purchase 能力、owner 校验和审计。工具额度实际使用走 A3 login；订单奖励确认同样重新检查 A3 purchase；expiration 是系统 Job。

| A4 操作                                    | D9-E-2 影响与档位结论                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 添加普通子域解析                           | 无调用点；既有“当前会话 + 审计”不变。                                                                  |
| 修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS | 无调用点；既有 step-up + 二次确认不变。                                                                |
| 批量删除解析                               | 无调用点；既有 step-up + 变更预览不变。                                                                |
| 关闭域名锁                                 | 无调用点；既有 step-up + 通知不变。                                                                    |
| 修改实名信息                               | 无调用点；既有 step-up + 二次确认不变。                                                                |
| 获取/修改域名管理密码                      | 无调用点；既有 step-up、active 渠道存在性及事后全渠道告知不变。                                        |
| 余额消费（交互式）                         | 无钱包调用点；米币兑换不涉及 fen、currency、wallet 表或余额函数，不能抵扣订单。既有余额 step-up 不变。 |
| 注销申请                                   | 无调用点；既有 step-up + 冷静期不变。                                                                  |
| 找回/换绑冷静期                            | 本切片没有上述高风险动作；A3 账户能力仍在赚取确认、兑换、额度使用各调用点独立执行。                    |

因此本切片操作分为：系统奖励 pending/确认/反转和系统过期（系统 actor + A3/审计）；客户米币兑换工具额度（owner + A3 purchase + 审计）；客户消耗工具额度（owner + A3 login + 审计）。均不落入 A4 九行的 step-up 动作，未新增或降低风险档。

## 5. 服务/Collection/Job 判定点（81）

分组计数：input 7、expiration-input 4、actor 8、A3 4、order-fact 3、earning-idempotency 4、entry-callpoint 7、points-derived 6、allocation 1、redemption-idempotency 4、redemption-replay 6、quota-idempotency 3、quota-derived 4、target 1、audit 5、collection 7、job 7。每行是一个真实调用点变异；同一 helper 的不同调用方分别计数。

| 组                     | 判定点 ID                       | 生产文件                        | 单独杀死它的用例                                                                        |
| ---------------------- | ------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| input                  | `integer-safe-number`           | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| input                  | `integer-positive`              | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| input                  | `integer-safe-maximum`          | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| input                  | `key-nonblank`                  | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| input                  | `key-maximum`                   | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| input                  | `expiry-valid-date`             | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| input                  | `new-batch-expiry-future`       | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| expiration-input       | `expiration-cutoff-finite`      | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| expiration-input       | `expiration-limit-safe-integer` | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| expiration-input       | `expiration-limit-positive`     | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| expiration-input       | `expiration-limit-maximum`      | `src/services/points/ledger.ts` | rejects invalid integer, key, expiry, and expiration-job boundaries before writes       |
| actor                  | `earn-system-actor`             | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| actor                  | `transition-system-actor`       | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| actor                  | `expiration-system-actor`       | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| actor                  | `redemption-owner`              | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| actor                  | `quota-consumption-owner`       | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| actor                  | `balance-read-owner`            | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| actor                  | `batch-read-owner`              | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| actor                  | `quota-read-owner`              | `src/services/points/ledger.ts` | enforces system, customer-owner, and read ownership at every service callpoint          |
| a3                     | `earn-a3-purchase`              | `src/services/points/ledger.ts` | reads order owner and status independently and applies A3 before earning                |
| a3                     | `confirm-a3-purchase`           | `src/services/points/ledger.ts` | applies A3 independently before a pending reward can become available                   |
| a3                     | `redemption-a3-purchase`        | `src/services/points/ledger.ts` | applies A3 independently at points redemption and tool-quota consumption callpoints     |
| a3                     | `quota-a3-login`                | `src/services/points/ledger.ts` | applies A3 independently at points redemption and tool-quota consumption callpoints     |
| order-fact             | `order-exists`                  | `src/services/points/ledger.ts` | reads order owner and status independently and applies A3 before earning                |
| order-fact             | `order-owner`                   | `src/services/points/ledger.ts` | reads order owner and status independently and applies A3 before earning                |
| order-fact             | `order-status`                  | `src/services/points/ledger.ts` | reads order owner and status independently and applies A3 before earning                |
| earning-idempotency    | `batch-account`                 | `src/services/points/ledger.ts` | rejects every earning idempotency dimension mismatch without another entry              |
| earning-idempotency    | `batch-order`                   | `src/services/points/ledger.ts` | rejects every earning idempotency dimension mismatch without another entry              |
| earning-idempotency    | `batch-points`                  | `src/services/points/ledger.ts` | rejects every earning idempotency dimension mismatch without another entry              |
| earning-idempotency    | `batch-expiry`                  | `src/services/points/ledger.ts` | rejects every earning idempotency dimension mismatch without another entry              |
| points-derived         | `points-account-version`        | `src/services/points/ledger.ts` | fails closed for every independently corruptible points-balance invariant               |
| points-derived         | `points-contiguous-sequence`    | `src/services/points/ledger.ts` | fails closed for every independently corruptible points-balance invariant               |
| points-derived         | `points-batch-links`            | `src/services/points/ledger.ts` | fails closed for every independently corruptible points-balance invariant               |
| points-derived         | `points-entry-links`            | `src/services/points/ledger.ts` | fails closed for every independently corruptible points-balance invariant               |
| points-derived         | `points-allocation-links`       | `src/services/points/ledger.ts` | fails closed for every independently corruptible points-balance invariant               |
| points-derived         | `points-lifecycle`              | `src/services/points/ledger.ts` | fails closed for every independently corruptible points-balance invariant               |
| quota-derived          | `quota-account-version`         | `src/services/points/ledger.ts` | fails closed for each quota-ledger invariant and scopes balance to the requested target |
| quota-derived          | `quota-contiguous-sequence`     | `src/services/points/ledger.ts` | fails closed for each quota-ledger invariant and scopes balance to the requested target |
| quota-derived          | `quota-links`                   | `src/services/points/ledger.ts` | fails closed for each quota-ledger invariant and scopes balance to the requested target |
| quota-derived          | `quota-nonnegative`             | `src/services/points/ledger.ts` | fails closed for each quota-ledger invariant and scopes balance to the requested target |
| redemption-idempotency | `redemption-account`            | `src/services/points/ledger.ts` | rejects global earning and redemption key reuse across otherwise valid customer facts   |
| redemption-idempotency | `redemption-target`             | `src/services/points/ledger.ts` | rejects every redemption and quota-use idempotency dimension mismatch                   |
| redemption-idempotency | `redemption-points`             | `src/services/points/ledger.ts` | rejects every redemption and quota-use idempotency dimension mismatch                   |
| redemption-idempotency | `redemption-quota`              | `src/services/points/ledger.ts` | rejects every redemption and quota-use idempotency dimension mismatch                   |
| quota-idempotency      | `quota-use-account`             | `src/services/points/ledger.ts` | rejects global earning and redemption key reuse across otherwise valid customer facts   |
| quota-idempotency      | `quota-use-target`              | `src/services/points/ledger.ts` | rejects every redemption and quota-use idempotency dimension mismatch                   |
| quota-idempotency      | `quota-use-units`               | `src/services/points/ledger.ts` | rejects every redemption and quota-use idempotency dimension mismatch                   |
| redemption-replay      | `replay-allocation-total`       | `src/services/points/ledger.ts` | fails closed when replay facts are reassigned across otherwise valid equal-cost batches |
| redemption-replay      | `replay-held-count`             | `src/services/points/ledger.ts` | fails closed when a redemption replay lacks exact held, consumed, or quota evidence     |
| redemption-replay      | `replay-consumed-count`         | `src/services/points/ledger.ts` | fails closed when a redemption replay lacks exact held, consumed, or quota evidence     |
| redemption-replay      | `replay-fact-links`             | `src/services/points/ledger.ts` | fails closed when replay facts are reassigned across otherwise valid equal-cost batches |
| redemption-replay      | `replay-one-quota-entry`        | `src/services/points/ledger.ts` | fails closed when a redemption replay lacks exact held, consumed, or quota evidence     |
| redemption-replay      | `replay-quota-units`            | `src/services/points/ledger.ts` | fails closed when a redemption replay lacks exact held, consumed, or quota evidence     |
| target                 | `approved-tool-targets-only`    | `src/services/points/ledger.ts` | grants only approved tool quotas and atomically prevents quota over-consumption         |
| allocation             | `allocation-minimum`            | `src/services/points/ledger.ts` | allocates deterministically by earliest expiry and then ascending batch id on replay    |
| entry-callpoint        | `earn-entry-type-pending`       | `src/services/points/ledger.ts` | keeps a succeeded-order reward pending and unavailable until confirmation               |
| entry-callpoint        | `transition-entry-type`         | `src/services/points/ledger.ts` | lets exactly one of N concurrent confirmations append the available transition          |
| entry-callpoint        | `redemption-held-entry`         | `src/services/points/ledger.ts` | recomputes remaining expirable points from cross-batch allocations                      |
| entry-callpoint        | `redemption-consumed-entry`     | `src/services/points/ledger.ts` | recomputes remaining expirable points from cross-batch allocations                      |
| entry-callpoint        | `expiration-entry`              | `src/services/points/ledger.ts` | expires only by appending an expired entry and leaves every historical row unchanged    |
| entry-callpoint        | `quota-grant-entry`             | `src/services/points/ledger.ts` | grants only approved tool quotas and atomically prevents quota over-consumption         |
| entry-callpoint        | `quota-consume-entry`           | `src/services/points/ledger.ts` | grants only approved tool quotas and atomically prevents quota over-consumption         |
| audit                  | `earn-audit`                    | `src/services/points/ledger.ts` | records audit evidence at every points mutation callpoint                               |
| audit                  | `transition-audit`              | `src/services/points/ledger.ts` | records audit evidence at every points mutation callpoint                               |
| audit                  | `redemption-audit`              | `src/services/points/ledger.ts` | records audit evidence at every points mutation callpoint                               |
| audit                  | `quota-consumption-audit`       | `src/services/points/ledger.ts` | records audit evidence at every points mutation callpoint                               |
| audit                  | `expiration-audit`              | `src/services/points/ledger.ts` | records audit evidence at every points mutation callpoint                               |
| collection             | `append-only-update-hook`       | `src/collections/points.ts`     | rejects updates and deletes at every append-only collection hook callpoint              |
| collection             | `append-only-delete-hook`       | `src/collections/points.ts`     | rejects updates and deletes at every append-only collection hook callpoint              |
| collection             | `generic-create-denied`         | `src/collections/points.ts`     | denies generic creates, updates, and deletes at every points collection callpoint       |
| collection             | `generic-delete-denied`         | `src/collections/points.ts`     | denies generic creates, updates, and deletes at every points collection callpoint       |
| collection             | `generic-update-denied`         | `src/collections/points.ts`     | denies generic creates, updates, and deletes at every points collection callpoint       |
| collection             | `owner-scoped-read`             | `src/collections/points.ts`     | scopes every points collection read to the customer owner                               |
| collection             | `approved-target-enum`          | `src/collections/points.ts`     | exposes only the three approved tool-quota redemption targets                           |
| job                    | `job-exclusive`                 | `src/jobs/config.ts`            | runs points expiration with one exclusive background concurrency key and no retries     |
| job                    | `job-key`                       | `src/jobs/config.ts`            | runs points expiration with one exclusive background concurrency key and no retries     |
| job                    | `job-supersedes`                | `src/jobs/config.ts`            | runs points expiration with one exclusive background concurrency key and no retries     |
| job                    | `job-queue`                     | `src/jobs/config.ts`            | runs points expiration with one exclusive background concurrency key and no retries     |
| job                    | `job-retries`                   | `src/jobs/config.ts`            | runs points expiration with one exclusive background concurrency key and no retries     |
| job                    | `job-schedule-cron`             | `src/jobs/config.ts`            | runs points expiration with one exclusive background concurrency key and no retries     |
| job                    | `job-schedule-queue`            | `src/jobs/config.ts`            | runs points expiration with one exclusive background concurrency key and no retries     |

## 6. SQL/CAS/来源判定点（52）

分组计数：scope 10、source 11、atomic 22、expiration 9。source 组全部属于“数据来源被替换”变异；atomic 组逐调用点覆盖 `UPDATE ... WHERE ... RETURNING` 的 account/version/evidence/amount/状态/返回行判断。

| 组         | 判定点 ID                                   | 判定                                                                 | 单独杀死它的用例                                                                           |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| scope      | `exclusive-lock-customer`                   | FOR UPDATE locks only the requested customer account                 | scopes locks, balances, allocations, and batch reads to one customer account               |
| scope      | `shared-lock-customer`                      | FOR SHARE locks only the requested customer account                  | scopes locks, balances, allocations, and batch reads to one customer account               |
| scope      | `points-aggregate-account`                  | points aggregate is scoped to the locked account                     | scopes locks, balances, allocations, and batch reads to one customer account               |
| scope      | `quota-aggregate-account`                   | quota aggregate is scoped to the locked account                      | scopes locks, balances, allocations, and batch reads to one customer account               |
| scope      | `order-id`                                  | reward source lookup uses the requested order id                     | reads order owner and status independently and applies A3 before earning                   |
| scope      | `earning-key-lookup`                        | earning idempotency lookup uses the requested global key             | rejects every earning idempotency dimension mismatch without another entry                 |
| scope      | `batch-id-lookup`                           | batch lookup uses the requested batch id                             | scopes locks, balances, allocations, and batch reads to one customer account               |
| scope      | `batch-lifecycle-id`                        | batch lifecycle facts use the requested batch id                     | lets exactly one of N concurrent confirmations append the available transition             |
| scope      | `redemption-key-lookup`                     | redemption idempotency lookup uses the requested global key          | allocates deterministically by earliest expiry and then ascending batch id on replay       |
| scope      | `quota-usage-key-lookup`                    | quota usage idempotency lookup uses the requested global key         | rejects every redemption and quota-use idempotency dimension mismatch                      |
| source     | `points-derived-allocation-source`          | points balance uses allocation rows rather than consumed entries     | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-derived-order-owner-source`         | batch ownership comes from the source order customer field           | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-derived-entry-customer-source`      | ledger link validation reads entry.customer_id                       | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-derived-allocation-customer-source` | allocation link validation reads allocation.customer_id              | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-lifecycle-pending-source`           | per-batch pending total reads pending entries                        | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-lifecycle-available-source`         | per-batch available total reads available entries                    | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-lifecycle-held-source`              | per-batch held total reads held entries                              | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-lifecycle-consumed-source`          | per-batch consumed total reads consumed entries                      | fails closed for every independently corruptible points-balance invariant                  |
| source     | `points-lifecycle-expired-source`           | per-batch expired total reads expired entries                        | fails closed for independently corrupted batch lifecycle and ownership links               |
| source     | `points-lifecycle-reversed-source`          | per-batch reversed total reads reversed entries                      | fails closed for every independently corruptible points-balance invariant                  |
| source     | `quota-target-balance-source`               | quota balance reads only the requested target                        | fails closed for each quota-ledger invariant and scopes balance to the requested target    |
| atomic     | `earn-version-update-account`               | earning version UPDATE is scoped to the locked account id            | scopes every points and quota CAS update to the exact account at equal versions            |
| atomic     | `earn-version-expected-source`              | earning version UPDATE compares the expected points version          | scopes every points and quota CAS update to the exact account at equal versions            |
| atomic     | `pending-claim-account`                     | pending transition claim is scoped to the locked account id          | scopes every points and quota CAS update to the exact account at equal versions            |
| atomic     | `pending-claim-version-source`              | pending transition claim compares the expected points version        | lets exactly one of N concurrent confirmations append the available transition             |
| atomic     | `pending-claim-batch`                       | pending evidence belongs to the target batch                         | lets exactly one of N concurrent confirmations append the available transition             |
| atomic     | `pending-claim-points`                      | pending evidence amount equals immutable batch points                | lets exactly one of N concurrent confirmations append the available transition             |
| atomic     | `pending-claim-terminal-exclusion`          | pending transition excludes available or reversed terminal evidence  | lets exactly one of N concurrent confirmations append the available transition             |
| atomic     | `spendable-order-expiry`                    | allocation orders by earliest expiry                                 | allocates deterministically by earliest expiry and then ascending batch id on replay       |
| atomic     | `spendable-order-id-tiebreak`               | allocation ties break by ascending batch id                          | allocates deterministically by earliest expiry and then ascending batch id on replay       |
| atomic     | `persisted-allocation-order`                | replayed allocations use expiry then batch id order                  | allocates deterministically by earliest expiry and then ascending batch id on replay       |
| atomic     | `redemption-reservation-account`            | points reservation UPDATE is scoped to the locked account id         | scopes locks, balances, allocations, and batch reads to one customer account               |
| atomic     | `redemption-reservation-version-source`     | points reservation compares the expected points version              | atomically consumes to the exact boundary under N concurrent redemptions without overdraft |
| atomic     | `redemption-reservation-cost-source`        | points reservation ceiling uses the requested points cost            | recomputes remaining expirable points from cross-batch allocations                         |
| atomic     | `quota-grant-update-account`                | quota grant version UPDATE is scoped to the locked account id        | scopes every points and quota CAS update to the exact account at equal versions            |
| atomic     | `quota-grant-version-source`                | quota grant compares the expected quota version                      | recomputes remaining expirable points from cross-batch allocations                         |
| atomic     | `quota-consume-update-account`              | quota consume reservation is scoped to the locked account id         | scopes every points and quota CAS update to the exact account at equal versions            |
| atomic     | `quota-consume-version-source`              | quota consume compares the expected quota version                    | grants only approved tool quotas and atomically prevents quota over-consumption            |
| atomic     | `quota-consume-units-source`                | quota reservation ceiling uses requested quota units                 | grants only approved tool quotas and atomically prevents quota over-consumption            |
| atomic     | `quota-consume-account-source`              | quota availability derives only the locked account                   | scopes locks, balances, allocations, and batch reads to one customer account               |
| atomic     | `quota-consume-target-source`               | quota availability derives only the requested target                 | fails closed for each quota-ledger invariant and scopes balance to the requested target    |
| atomic     | `redemption-account-authorization`          | allocation and atomic reservation both use the locked points account | scopes locks, balances, allocations, and batch reads to one customer account               |
| atomic     | `redemption-live-expiry-authorization`      | allocation and atomic reservation both exclude expired batches       | excludes elapsed but unswept batches in both allocation and atomic reservation             |
| expiration | `batch-remaining-allocation-source`         | remaining expiry amount subtracts allocations, not consumed entries  | uses allocations rather than correlated consumed entries as the remaining-batch source     |
| expiration | `batch-remaining-account`                   | remaining expiry facts match the immutable batch account             | recomputes remaining expirable points from cross-batch allocations                         |
| expiration | `batch-remaining-customer`                  | remaining expiry facts match the immutable batch customer            | recomputes remaining expirable points from cross-batch allocations                         |
| expiration | `expire-cutoff-recheck`                     | per-batch expiration rechecks immutable expiry against cutoff        | expires only by appending an expired entry and leaves every historical row unchanged       |
| expiration | `expire-claim-account`                      | expiration claim is scoped to the locked account id                  | scopes every points and quota CAS update to the exact account at equal versions            |
| expiration | `expire-claim-version-source`               | expiration claim compares the expected points version                | scopes every points and quota CAS update to the exact account at equal versions            |
| expiration | `expiration-order-expiry`                   | expiration candidates order by earliest expiry                       | expires equal-time batches by ascending id and honors the exact batch limit                |
| expiration | `expiration-order-id-tiebreak`              | equal-expiry candidates order by ascending batch id                  | expires equal-time batches by ascending id and honors the exact batch limit                |
| expiration | `expiration-limit`                          | expiration candidate query honors the exact configured batch limit   | expires equal-time batches by ascending id and honors the exact batch limit                |

## 7. Migration/release 判定点（101）

分组计数：release 5、enum 16、required 6、check 35、unique 9、foreign-key 17、down 13。每个变异都在独立临时 PostgreSQL 数据库实跑 up、行为写入和 down；不是源码文本断言。

| 组          | 判定点 ID                                                                           | 判定                                                                                               | 目标      |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------- |
| release     | `release-policy-phase`                                                              | release policy fixes phase                                                                         | policy    |
| release     | `release-policy-newCodeCompatibleBeforeUp`                                          | release policy fixes newCodeCompatibleBeforeUp                                                     | policy    |
| release     | `release-policy-oldCodeCompatible`                                                  | release policy fixes oldCodeCompatible                                                             | policy    |
| release     | `release-policy-rollback`                                                           | release policy fixes rollback                                                                      | policy    |
| release     | `release-manifest-migration`                                                        | release manifest contains the D9-E-2 migration exactly once                                        | manifest  |
| enum        | `points_batches_source_type-order-reward`                                           | enum_points_batches_source_type contains order_reward                                              | migration |
| enum        | `points_ledger_entry_type-pending`                                                  | enum_points_ledger_entry_type contains pending                                                     | migration |
| enum        | `points_ledger_entry_type-available`                                                | enum_points_ledger_entry_type contains available                                                   | migration |
| enum        | `points_ledger_entry_type-held`                                                     | enum_points_ledger_entry_type contains held                                                        | migration |
| enum        | `points_ledger_entry_type-consumed`                                                 | enum_points_ledger_entry_type contains consumed                                                    | migration |
| enum        | `points_ledger_entry_type-expired`                                                  | enum_points_ledger_entry_type contains expired                                                     | migration |
| enum        | `points_ledger_entry_type-reversed`                                                 | enum_points_ledger_entry_type contains reversed                                                    | migration |
| enum        | `points_redemptions_target-advanced-whois`                                          | enum_points_redemptions_target contains advanced_whois                                             | migration |
| enum        | `points_redemptions_target-bulk-query`                                              | enum_points_redemptions_target contains bulk_query                                                 | migration |
| enum        | `points_redemptions_target-ai-domain-analysis`                                      | enum_points_redemptions_target contains ai_domain_analysis                                         | migration |
| enum        | `tool_quota_ledger_entry_type-grant`                                                | enum_tool_quota_ledger_entry_type contains grant                                                   | migration |
| enum        | `tool_quota_ledger_entry_type-consume`                                              | enum_tool_quota_ledger_entry_type contains consume                                                 | migration |
| enum        | `tool_quota_ledger_target-advanced-whois`                                           | enum_tool_quota_ledger_target contains advanced_whois                                              | migration |
| enum        | `tool_quota_ledger_target-bulk-query`                                               | enum_tool_quota_ledger_target contains bulk_query                                                  | migration |
| enum        | `tool_quota_ledger_target-ai-domain-analysis`                                       | enum_tool_quota_ledger_target contains ai_domain_analysis                                          | migration |
| enum        | `workflow-points-expiration-up`                                                     | up migration registers the pointsExpiration workflow                                               | migration |
| required    | `points-accounts-required-columns`                                                  | points_accounts fact dimensions are required                                                       | migration |
| required    | `points-batches-required-columns`                                                   | points_batches fact dimensions are required                                                        | migration |
| required    | `points-redemptions-required-columns`                                               | points_redemptions fact dimensions are required                                                    | migration |
| required    | `points-ledger-required-columns`                                                    | points_ledger fact dimensions are required                                                         | migration |
| required    | `points-consumption-allocations-required-columns`                                   | points_consumption_allocations fact dimensions are required                                        | migration |
| required    | `tool-quota-ledger-required-columns`                                                | tool_quota_ledger fact dimensions are required                                                     | migration |
| check       | `points-accounts-ledger-version-integer`                                            | points_accounts.ledger_version is integral                                                         | migration |
| check       | `points-accounts-ledger-version-lower-bound`                                        | points_accounts.ledger_version is at least 0                                                       | migration |
| check       | `points-accounts-ledger-version-upper-bound`                                        | points_accounts.ledger_version is at most Number.MAX_SAFE_INTEGER                                  | migration |
| check       | `points-accounts-quota-ledger-version-integer`                                      | points_accounts.quota_ledger_version is integral                                                   | migration |
| check       | `points-accounts-quota-ledger-version-lower-bound`                                  | points_accounts.quota_ledger_version is at least 0                                                 | migration |
| check       | `points-accounts-quota-ledger-version-upper-bound`                                  | points_accounts.quota_ledger_version is at most Number.MAX_SAFE_INTEGER                            | migration |
| check       | `points-batches-points-integer`                                                     | points_batches.points is integral                                                                  | migration |
| check       | `points-batches-points-lower-bound`                                                 | points_batches.points is at least 1                                                                | migration |
| check       | `points-batches-points-upper-bound`                                                 | points_batches.points is at most Number.MAX_SAFE_INTEGER                                           | migration |
| check       | `points-redemptions-points-cost-integer`                                            | points_redemptions.points_cost is integral                                                         | migration |
| check       | `points-redemptions-points-cost-lower-bound`                                        | points_redemptions.points_cost is at least 1                                                       | migration |
| check       | `points-redemptions-points-cost-upper-bound`                                        | points_redemptions.points_cost is at most Number.MAX_SAFE_INTEGER                                  | migration |
| check       | `points-redemptions-quota-units-integer`                                            | points_redemptions.quota_units is integral                                                         | migration |
| check       | `points-redemptions-quota-units-lower-bound`                                        | points_redemptions.quota_units is at least 1                                                       | migration |
| check       | `points-redemptions-quota-units-upper-bound`                                        | points_redemptions.quota_units is at most Number.MAX_SAFE_INTEGER                                  | migration |
| check       | `points-ledger-points-integer`                                                      | points_ledger.points is integral                                                                   | migration |
| check       | `points-ledger-points-lower-bound`                                                  | points_ledger.points is at least 1                                                                 | migration |
| check       | `points-ledger-points-upper-bound`                                                  | points_ledger.points is at most Number.MAX_SAFE_INTEGER                                            | migration |
| check       | `points-ledger-ledger-sequence-integer`                                             | points_ledger.ledger_sequence is integral                                                          | migration |
| check       | `points-ledger-ledger-sequence-lower-bound`                                         | points_ledger.ledger_sequence is at least 1                                                        | migration |
| check       | `points-ledger-ledger-sequence-upper-bound`                                         | points_ledger.ledger_sequence is at most Number.MAX_SAFE_INTEGER                                   | migration |
| check       | `points-consumption-allocations-points-integer`                                     | points_consumption_allocations.points is integral                                                  | migration |
| check       | `points-consumption-allocations-points-lower-bound`                                 | points_consumption_allocations.points is at least 1                                                | migration |
| check       | `points-consumption-allocations-points-upper-bound`                                 | points_consumption_allocations.points is at most Number.MAX_SAFE_INTEGER                           | migration |
| check       | `tool-quota-ledger-quota-units-integer`                                             | tool_quota_ledger.quota_units is integral                                                          | migration |
| check       | `tool-quota-ledger-quota-units-lower-bound`                                         | tool_quota_ledger.quota_units is at least 1                                                        | migration |
| check       | `tool-quota-ledger-quota-units-upper-bound`                                         | tool_quota_ledger.quota_units is at most Number.MAX_SAFE_INTEGER                                   | migration |
| check       | `tool-quota-ledger-ledger-sequence-integer`                                         | tool_quota_ledger.ledger_sequence is integral                                                      | migration |
| check       | `tool-quota-ledger-ledger-sequence-lower-bound`                                     | tool_quota_ledger.ledger_sequence is at least 1                                                    | migration |
| check       | `tool-quota-ledger-ledger-sequence-upper-bound`                                     | tool_quota_ledger.ledger_sequence is at most Number.MAX_SAFE_INTEGER                               | migration |
| check       | `points-batches-expiry-after-creation`                                              | a points batch expires after it is created                                                         | migration |
| check       | `points-ledger-nonredemption-state-link`                                            | pending, available, expired, and reversed facts have no redemption link                            | migration |
| check       | `points-ledger-redemption-state-link`                                               | held and consumed facts require a redemption link                                                  | migration |
| check       | `tool-quota-grant-redemption-link`                                                  | quota grants require their redemption link                                                         | migration |
| check       | `tool-quota-consume-redemption-link`                                                | quota consumption has no redemption link                                                           | migration |
| unique      | `unique-customer-idx`                                                               | customer_idx rejects duplicate facts                                                               | migration |
| unique      | `unique-points-batches-earning-key-idx`                                             | points_batches_earning_key_idx rejects duplicate facts                                             | migration |
| unique      | `unique-points-redemptions-redemption-key-idx`                                      | points_redemptions_redemption_key_idx rejects duplicate facts                                      | migration |
| unique      | `unique-points-ledger-entry-key-idx`                                                | points_ledger_entry_key_idx rejects duplicate facts                                                | migration |
| unique      | `unique-account-ledgerSequence-1-idx`                                               | account_ledgerSequence_1_idx rejects duplicate facts                                               | migration |
| unique      | `unique-points-consumption-allocations-allocation-key-idx`                          | points_consumption_allocations_allocation_key_idx rejects duplicate facts                          | migration |
| unique      | `unique-redemption-batch-idx`                                                       | redemption_batch_idx rejects duplicate facts                                                       | migration |
| unique      | `unique-tool-quota-ledger-entry-key-idx`                                            | tool_quota_ledger_entry_key_idx rejects duplicate facts                                            | migration |
| unique      | `unique-account-ledgerSequence-2-idx`                                               | account_ledgerSequence_2_idx rejects duplicate facts                                               | migration |
| foreign-key | `foreign-key-points-accounts-customer-id-customers-id-fk`                           | points_accounts_customer_id_customers_id_fk rejects a dangling fact link                           | migration |
| foreign-key | `foreign-key-points-batches-customer-id-customers-id-fk`                            | points_batches_customer_id_customers_id_fk rejects a dangling fact link                            | migration |
| foreign-key | `foreign-key-points-batches-account-id-points-accounts-id-fk`                       | points_batches_account_id_points_accounts_id_fk rejects a dangling fact link                       | migration |
| foreign-key | `foreign-key-points-batches-source-order-id-orders-id-fk`                           | points_batches_source_order_id_orders_id_fk rejects a dangling fact link                           | migration |
| foreign-key | `foreign-key-points-redemptions-customer-id-customers-id-fk`                        | points_redemptions_customer_id_customers_id_fk rejects a dangling fact link                        | migration |
| foreign-key | `foreign-key-points-redemptions-account-id-points-accounts-id-fk`                   | points_redemptions_account_id_points_accounts_id_fk rejects a dangling fact link                   | migration |
| foreign-key | `foreign-key-points-ledger-customer-id-customers-id-fk`                             | points_ledger_customer_id_customers_id_fk rejects a dangling fact link                             | migration |
| foreign-key | `foreign-key-points-ledger-account-id-points-accounts-id-fk`                        | points_ledger_account_id_points_accounts_id_fk rejects a dangling fact link                        | migration |
| foreign-key | `foreign-key-points-ledger-batch-id-points-batches-id-fk`                           | points_ledger_batch_id_points_batches_id_fk rejects a dangling fact link                           | migration |
| foreign-key | `foreign-key-points-ledger-redemption-id-points-redemptions-id-fk`                  | points_ledger_redemption_id_points_redemptions_id_fk rejects a dangling fact link                  | migration |
| foreign-key | `foreign-key-points-consumption-allocations-customer-id-customers-id-fk`            | points_consumption_allocations_customer_id_customers_id_fk rejects a dangling fact link            | migration |
| foreign-key | `foreign-key-points-consumption-allocations-account-id-points-accounts-id-fk`       | points_consumption_allocations_account_id_points_accounts_id_fk rejects a dangling fact link       | migration |
| foreign-key | `foreign-key-points-consumption-allocations-redemption-id-points-redemptions-id-fk` | points_consumption_allocations_redemption_id_points_redemptions_id_fk rejects a dangling fact link | migration |
| foreign-key | `foreign-key-points-consumption-allocations-batch-id-points-batches-id-fk`          | points_consumption_allocations_batch_id_points_batches_id_fk rejects a dangling fact link          | migration |
| foreign-key | `foreign-key-tool-quota-ledger-customer-id-customers-id-fk`                         | tool_quota_ledger_customer_id_customers_id_fk rejects a dangling fact link                         | migration |
| foreign-key | `foreign-key-tool-quota-ledger-account-id-points-accounts-id-fk`                    | tool_quota_ledger_account_id_points_accounts_id_fk rejects a dangling fact link                    | migration |
| foreign-key | `foreign-key-tool-quota-ledger-redemption-id-points-redemptions-id-fk`              | tool_quota_ledger_redemption_id_points_redemptions_id_fk rejects a dangling fact link              | migration |
| down        | `down-queued-job-cleanup`                                                           | down removes queued pointsExpiration jobs before shrinking the workflow enum                       | migration |
| down        | `down-drop-points-accounts`                                                         | down removes points_accounts                                                                       | migration |
| down        | `down-drop-points-batches`                                                          | down removes points_batches                                                                        | migration |
| down        | `down-drop-points-redemptions`                                                      | down removes points_redemptions                                                                    | migration |
| down        | `down-drop-points-ledger`                                                           | down removes points_ledger                                                                         | migration |
| down        | `down-drop-points-consumption-allocations`                                          | down removes points_consumption_allocations                                                        | migration |
| down        | `down-drop-tool-quota-ledger`                                                       | down removes tool_quota_ledger                                                                     | migration |
| down        | `down-drop-enum-points-batches-source-type`                                         | down removes enum_points_batches_source_type                                                       | migration |
| down        | `down-drop-enum-points-ledger-entry-type`                                           | down removes enum_points_ledger_entry_type                                                         | migration |
| down        | `down-drop-enum-points-redemptions-target`                                          | down removes enum_points_redemptions_target                                                        | migration |
| down        | `down-drop-enum-tool-quota-ledger-entry-type`                                       | down removes enum_tool_quota_ledger_entry_type                                                     | migration |
| down        | `down-drop-enum-tool-quota-ledger-target`                                           | down removes enum_tool_quota_ledger_target                                                         | migration |
| down        | `down-exact-workflow-enum`                                                          | down restores the exact workflow enum that preceded D9-E-2                                         | migration |

## 8. 复现命令

```bash
node apps/web/scripts/mutate-d9e2-points-decisions.mjs --validate
node apps/web/scripts/mutate-d9e2-points-sql-predicates.mjs --validate
node apps/web/scripts/mutate-d9e2-points-migration.mjs --validate

node apps/web/scripts/mutate-d9e2-points-decisions.mjs
node apps/web/scripts/mutate-d9e2-points-sql-predicates.mjs
node apps/web/scripts/mutate-d9e2-points-migration.mjs
```

服务和 SQL 变异命令需使用本地 fixture 数据库及测试主密钥环境；migration 变异器自行创建并清理精确命名的临时数据库。三个执行器都在每个变异后恢复源码，只有非零退出且输出行为 `AssertionError` 才计为 killed。
