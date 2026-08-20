# D9-B-6 余额第四 ledger 对账判定与变异矩阵

## 范围与不变量

本切片只扩展 D5-04 既有 `reconciliation.ts`、`reconciliations`、`reconciliationKey`、
`manualReviews` 和审计，不建立平行对账表或任务框架。任务是 system-only 的只读观察流程：
只写对账证据、人工复核与审计，绝不写余额事实、订单状态、充值状态或退款状态。任何资金纠正仍须进入
D9-B-5 三步审批。

`postedBalance` 与 `heldBalance` 的真值只由追加式 `walletEntries` 聚合；
`wallet_accounts.posted_balance_cache_fen` 与 `held_balance_cache_fen` 只是可变快照。快照与聚合值不同
本身就是差异，不能把快照替换为真源，也不能由对账任务自动刷新快照。

四方口径如下：

| 余额 ledger 事实                           | 对应 ledger/事实           | 绑定条件                                                     | 不比较的组合                                     |
| ------------------------------------------ | -------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `wallet-top-up:*:credit` 充值入账          | `wechat_funds` 支付        | B-2 充值单号、微信交易号、充值单状态与金额均匹配             | 普通订单微信支付、非充值 credit                  |
| `order-balance-payment:*` 余额支付 capture | `internal_orders` 订单     | 订单号/hold key、`payment_channel=balance`、冻结订单金额匹配 | Native/H5 订单、非订单 hold/capture              |
| B-4 `wallet-top-up-payment-recovery:*`     | `wechat_funds` 反向追回    | recovery key、充值单、追回类型/时间、微信反向金额均匹配      | 原路退款、没有 B-4 追回事实的任意负向流水        |
| 全量 `walletEntries` 聚合                  | `wallet_accounts` 缓存快照 | 同一钱包账户；只用于发现缓存漂移                             | `westdigital_prepaid` 与余额账本之间没有直接关系 |

因此 `wallet_balance` 不直接与 `westdigital_prepaid` 比较；未列出的组合不产生“推测式”差异。

## 行为用例

`apps/web/tests/integration/d9b6-wallet-reconciliation.integration.test.ts` 的 11 个用例彼此独立，
且所有计数断言都带账期、ledger、业务键、关联对象或 trace 范围：

1. `records all four ledgers as matched without manufacturing differences for unmapped combinations`：
   四个 ledger 一致时无差异，同时证明无对应关系的 hold 不制造假差异。
2. `reports a top-up versus WeChat difference, creates one review, and never changes wallet funds`：
   充值/微信不一致只产生差异、复核和审计，余额零变化。
3. `reports a balance payment versus internal-order difference without changing the order or wallet`：
   余额支付/订单不一致只上报，订单和余额零变化。
4. `reports a payment recovery versus WeChat reversal difference without changing recovery facts`：
   争议追回/微信反向金额不一致只上报，追回事实和余额零变化。
5. `derives balances from walletEntries and reports a wallet_accounts cache mismatch without correcting it`：
   独立验证 `walletEntries` 真源、缓存漂移上报和禁止自动纠正。
6. `fails closed for independently de-correlated WeChat identity, payment channel, and recovery-record facts`：
   微信交易号、余额支付渠道和 B-4 追回事实三个绑定条件分别失败关闭。
7. `replays the same period and business difference with one reconciliation and one review`：
   同账期、ledger、业务键重放只生成一条对账和复核。
8. `binds reconciliation idempotency independently to both period boundaries`：账期起止分别进入幂等键。
9. `rejects an invalid period and a non-array upstream result before reconciliation writes`：
   输入和上游数据形状失败关闭。
10. `records and retries an upstream read failure while leaving wallet and order state unchanged`：
    上游失败只记录一次 retryable 审计并重试一次，资金与订单零变化。
11. `serializes concurrent runs for one period into one difference and one manual review`：
    六路并发仍只有一条差异和一条复核。

## 应用层调用点变异（37/37）

每个 ID 都会临时删除、短路或替换一个调用点，并只运行右列行为用例；脚本只把
`AssertionError` 计为“被行为杀死”，编译/SQL/环境失败不计数。

| #   | 调用点 ID                                          | 必须保持的判定                                      | 独立杀死它的用例（上节编号） |
| --- | -------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| 1   | `input/wallet-period-validation`                   | wallet 入口先校验账期，非法账期不得访问上游         | 9                            |
| 2   | `input/upstream-retry-count`                       | 上游失败恰好重试一次                                | 10                           |
| 3   | `input/upstream-array-shape`                       | 上游结果必须是账单数组                              | 9                            |
| 4   | `input/upstream-failure-audit`                     | 重试耗尽必须记录 retryable、fundsChanged=false 审计 | 10                           |
| 5   | `idempotency/key-period-start`                     | 幂等键绑定账期起点                                  | 8                            |
| 6   | `idempotency/key-period-end`                       | 幂等键绑定账期终点                                  | 8                            |
| 7   | `idempotency/key-record-key`                       | 幂等键绑定业务键                                    | 1                            |
| 8   | `idempotency/key-excludes-run-trace`               | 重试 trace 不进入幂等身份                           | 7                            |
| 9   | `idempotency/top-up-business-key`                  | 充值差异使用稳定充值单号                            | 7                            |
| 10  | `idempotency/atomic-conflict-insert`               | 唯一 `reconciliationKey` 的原子冲突只允许一个创建者 | 11                           |
| 11  | `difference-escalation/difference-status`          | 非零差异写成 `difference`                           | 2                            |
| 12  | `difference-escalation/difference-branch`          | 非零差异进入升级分支                                | 2                            |
| 13  | `difference-escalation/manual-review-create`       | 差异复用既有 `manualReviews`                        | 2                            |
| 14  | `difference-escalation/difference-audit`           | 差异复用 `recordAuditEvent`                         | 2                            |
| 15  | `difference-escalation/correction-applied-false`   | 对账证据明确没有自动纠正                            | 2                            |
| 16  | `difference-escalation/review-reconciliation-link` | 复核关联准确的对账记录                              | 2                            |
| 17  | `difference-escalation/review-top-up-link`         | 充值差异复核关联准确充值单                          | 2                            |
| 18  | `difference-escalation/review-order-link`          | 余额支付差异复核关联准确订单                        | 3                            |
| 19  | `difference-escalation/review-wallet-account-link` | 缓存漂移复核关联准确钱包账户                        | 5                            |
| 20  | `wechat-mapping/top-up-wechat-transaction-id`      | 充值与微信账单绑定微信交易号                        | 6                            |
| 21  | `wechat-mapping/top-up-exclusive-source`           | 身份不匹配的充值不能成为唯一微信资金真源            | 6                            |
| 22  | `wechat-mapping/payment-evidence-business-key`     | 充值 credit 按充值单号查微信证据                    | 2                            |
| 23  | `wechat-mapping/recovery-evidence-business-key`    | 追回按 recovery key 查微信反向证据                  | 4                            |
| 24  | `four-way-mapping/top-up-only-credit-prefix`       | 只有充值 credit 前缀参与充值/微信映射               | 1                            |
| 25  | `four-way-mapping/balance-payment-channel`         | 只有 balance 渠道订单参与余额支付映射               | 6                            |
| 26  | `four-way-mapping/balance-payment-order-amount`    | capture 对比冻结订单金额                            | 3                            |
| 27  | `four-way-mapping/top-up-wechat-observed-amount`   | 充值入账对比微信实际观察金额                        | 2                            |
| 28  | `four-way-mapping/recovery-wechat-observed-amount` | 追回对比微信反向实际观察金额                        | 4                            |
| 29  | `ledger-source/posted-source-wallet-entries`       | posted 真源是 `walletEntries` 聚合而不是账户缓存    | 5                            |
| 30  | `ledger-source/held-source-wallet-entries`         | held 真源是 `walletEntries` 聚合而不是账户缓存      | 5                            |
| 31  | `ledger-source/cache-posted-difference`            | 缓存差异包含 posted 分量                            | 5                            |
| 32  | `ledger-source/cache-held-difference`              | 缓存差异包含 held 分量                              | 5                            |
| 33  | `read-only/cache-no-auto-correction`               | 对账不得自动改缓存或余额                            | 5                            |
| 34  | `ledger-source/cache-summary-source-label`         | 证据显式标记聚合来源为 `wallet_entries_aggregate`   | 5                            |
| 35  | `cache-snapshot/mutation-posted-cache-refresh`     | 正常钱包写事务以账本推导结果刷新 posted 快照        | 1                            |
| 36  | `cache-snapshot/settlement-held-cache-refresh`     | capture/release 以账本推导结果刷新 held 快照        | 1                            |
| 37  | `cache-snapshot/hold-cache-refresh`                | hold 以账本推导结果刷新 held 快照，但快照仍不是真源 | 1                            |

其中第 29、30 项是强制的“数据来源被替换”变异：把表面等价的余额来源换成
`wallet_accounts` 缓存后，第 5 个用例分别在 posted/held 行为断言失败。第 33 项向对账路径注入自动缓存
更新，第 5 个用例以对账后的原始缓存值断言单独杀死。

## 迁移判定变异（21/21）

迁移 verifier 每次创建独立 PostgreSQL 数据库，执行旧 schema、fixture、UP、行为断言、受保护 DOWN
和干净 DOWN，最后删除一次性数据库。

| #   | 调用点 ID                                       | 行为断言                                                    |
| --- | ----------------------------------------------- | ----------------------------------------------------------- |
| 1   | `migration-enum/wallet-kind`                    | `wallet` 是既有 kind enum 的第四项                          |
| 2   | `migration-enum/wallet-balance-ledger`          | `wallet_balance` 是既有 ledger enum 的第四项                |
| 3   | `cache-default/posted-cache-zero-default`       | 新账户 posted 快照默认 0                                    |
| 4   | `cache-default/held-cache-zero-default`         | 新账户 held 快照默认 0                                      |
| 5   | `cache-backfill/posted-backfill-wallet-entries` | posted 回填从 `wallet_entries` 聚合                         |
| 6   | `cache-backfill/posted-credit-sign`             | credit 增加 posted                                          |
| 7   | `cache-backfill/posted-debit-sign`              | capture/recovery 减少 posted                                |
| 8   | `cache-backfill/held-backfill-wallet-entries`   | held 回填从 `wallet_entries` 聚合                           |
| 9   | `cache-backfill/held-hold-sign`                 | hold 增加 held                                              |
| 10  | `cache-backfill/held-settlement-sign`           | capture/release 减少 held                                   |
| 11  | `cache-constraint/posted-cache-integer`         | posted 只接受整数分                                         |
| 12  | `cache-constraint/posted-cache-lower-bound`     | posted 不低于安全整数下界                                   |
| 13  | `cache-constraint/posted-cache-upper-bound`     | posted 不高于安全整数上界                                   |
| 14  | `cache-constraint/held-cache-integer`           | held 只接受整数分                                           |
| 15  | `cache-constraint/held-cache-nonnegative`       | held 不得为负                                               |
| 16  | `cache-constraint/held-cache-upper-bound`       | held 不高于安全整数上界                                     |
| 17  | `review-link/wallet-account-foreign-key`        | 钱包关联不可悬空                                            |
| 18  | `review-link/reconciliation-foreign-key`        | 对账关联不可悬空                                            |
| 19  | `review-link/wallet-account-index`              | 钱包关联保留运维查询索引                                    |
| 20  | `review-link/one-review-per-reconciliation`     | 每条对账差异至多一条人工复核                                |
| 21  | `migration-down/fourth-ledger-facts-block-down` | 存在第四 ledger 事实时 DOWN 必须失败，干净 DOWN 恢复旧 enum |

## A4 风险分级逐项复核（9/9）

本切片新增的是无人值守、system-only、只读对账观察，不是用户交互操作，不消费 step-up，也不创建
`renewalMandate`。异常只写对账证据、人工复核与审计；资金纠正必须另走 B-5 审批。因此它没有新增 A4
风险表操作，也没有降低任何现有操作的保护档位：

| A4 操作                                    | 既有保护档位                                                               | 本切片结论                                            |
| ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| 添加普通子域解析                           | 当前会话 + 审计                                                            | 不调用 DNS 写入口，档位不变                           |
| 修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS | step-up + 二次确认                                                         | 不调用 DNS/NS 写入口，档位不变                        |
| 批量删除解析                               | step-up + 变更预览                                                         | 不调用批量删除入口，档位不变                          |
| 关闭域名锁                                 | step-up + 通知                                                             | 不调用域名锁入口，档位不变                            |
| 修改实名信息                               | step-up + 二次确认                                                         | 只读充值/订单/账本事实，不修改实名，档位不变          |
| 获取/修改域名管理密码                      | step-up + active 渠道存在性 + 成功后全 active 渠道逐 provider 告知 outcome | 不调用管理密码入口，已批准档位及其事后通知语义不变    |
| 余额消费（交互式）                         | step-up                                                                    | 对账不 hold/capture/release，不消费余额；交互档位不变 |
| 注销申请                                   | step-up + 冷静期                                                           | 不调用注销入口，档位不变                              |
| 账号刚完成找回或换绑                       | 冷静期禁止上述全部高风险操作                                               | 对账不是高风险交互入口，不绕过或改变任何冷静期判断    |

## 执行命令与真实闸门

- 应用层：`node apps/web/scripts/mutate-d9b6-wallet-reconciliation-decisions.mjs`
- 迁移层：`node apps/web/scripts/mutate-d9b6-wallet-reconciliation-migration.mjs`
- 迁移 verifier：`node scripts/verify-d9b6-wallet-reconciliation-migration.mjs`
- 所有执行均显式保持 `ALLOW_REAL_WECHATPAY*`、`ALLOW_REAL_WESTDIGITAL*` 与
  `ALLOW_REAL_PROVIDER_WRITES=false`，只使用 fixture 和隔离本地 PostgreSQL。

## 最终验证记录

- 指定 D9-B-6 integration：11/11 通过；应用层调用点变异 37/37、migration 变异 21/21 均由上表指定的
  行为断言杀死，恢复态再次 11/11 通过。
- 最终代码状态在 disposable fixture 数据库 `wanmi_d9b6_gate_20260819` 上完整运行一次 `make check` 并退出
  0：migration、生成物/schema drift、release/Nginx/运维/重建契约、lint、TypeScript strict、115 文件
  838/838 unit、43 文件 709/709 主 integration、D9-B-1 隔离 37/37、D9-B-6 隔离 11/11（integration
  合计 757/757）、Next.js 宿主生产构建、linux/amd64 同镜像、依赖审计、工作树与完整 227 commits
  Gitleaks、Trivy 全部通过；Trivy 仅保留已批准的镜像尺寸 advisory。
- 收口过程如实保留：旧 D5 verifier 固定假设三个 ledger，已改为历史 migration 验三项、当前 schema 验
  四项；首次环境缺 `SESSION_PEPPER`/有效本地微信证书路径，补安全 fixture 后继续；release policy/manifest
  与审计 action 目录漏登记均由门禁发现并补齐。集成并行时 D9-B-1 的全局账户扫描与本文件 fixture 相互污染，
  因而将两份会扫描全量钱包账户的集成文件各自隔离运行，并将本切片计数按 trace/ledger 限定；恢复态及最终
  完整门禁均通过。
- `wanmi_d9b6_104757`、`wanmi_d9b6_final_20260819`、`wanmi_d9b6_gate_20260819` 三个专用数据库均在精确
  名称、存在性和零活动连接检查后删除；删除不可恢复，但只含本地 fixture。未部署、未访问生产、未发送真实
  微信/西部数码/资金写请求，全部真实闸始终为 false。
