# D9-B-5 高风险审批与通知 outbox 验证矩阵

## 1. 范围与不变量

本切片只实现 16.7 B5 四项和 16.13 的通知 outbox、交易类通知不可退订/投递失败不改变业务状态、后台与日志脱敏三项。未实现 16.13 反滥用监控，也未实现 B-6 第四 ledger 对账或任何占位入口。

固定不变量如下：

- 高风险操作只能按 `pending_approval → approved → executing → executed` 完成；拒绝或执行失败进入终态，不能通过 Payload 通用写接口推进；
- 生产 migration 默认 `requiresDifferentApprover=true`、`cooldownSeconds=900`；冷静期下限为 1 秒；执行资格只由数据库 `created_at + cooldown_seconds` 计算；
- 配置允许同一人审批时，自批仍只能在完整冷静期后执行；配置要求第二人时，JS 预检和数据库 CAS 都拒绝自批；
- 决策、执行认领和投递认领均使用同事务 `UPDATE ... WHERE ... RETURNING`；最终写入再次绑定 request/delivery、状态、claim 和 actor/attempt；
- 大额调整金额只从受约束的 `amount_fen` 读取，不在 JSON 中保存第二份金额；目标索引与操作快照执行前重新校验；
- 审批请求/执行结果与通知 outbox 在同一业务事务内写入；投递任务只更新 delivery/receipt，不更新订单、钱包、客户或域名资产；
- 外部状态不明不盲重试；已发出但 worker 中断的 lease 进入 DLQ；只有“状态已知且明确 retryable”才重试；
- 交易类通知没有偏好存储模型；偏好表 enum 只含营销类型；消息快照、回执、已读事实和管理员访问事件均为追加式；
- 完整手机号、证件号和凭据在写入审批/通知前拒绝或脱敏，管理员出口只返回掩码值。

## 2. 八类操作的三步覆盖

| 操作                 | 本切片授权入口与复用边界                                                                                                                          | 三步行为证据                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 大额余额调整         | `large_balance_adjustment`；credit 复用 B-1 `postWalletCredit`，recovery 复用 B-4 `recoverWalletBalance`                                          | `runs large_balance_adjustment through request, approval, cooldown, and execution`                              |
| 原路退款             | `original_refund`；执行复用 D5-04/B-3 `requestAutomaticRegistrationFailureRefund`，按订单冻结渠道分派                                             | `runs original_refund through request, approval, cooldown, and execution`                                       |
| 人工账户找回         | `account_recovery`；唯一领域决定入口仍为 A5 `decideAccountRecovery`                                                                               | `runs account_recovery through request, approval, cooldown, and execution`；`blocks direct account-recovery...` |
| 身份冲突处理         | `identity_conflict_resolution`；复用 A2 身份与 `ManualReviews`，领域决定 CAS 在 `customer-identities.ts`                                          | `runs identity_conflict_resolution...`；`blocks direct account-recovery and identity-conflict decisions...`     |
| VIP 欺诈纠错         | `vip_fraud_correction`；B5 只提供授权生命周期，E2 尚未实现，通用 HTTP 执行入口 fail-closed，不预建 E2 状态或 `tierCorrection`                     | `runs vip_fraud_correction through request, approval, cooldown, and execution`                                  |
| 解冻高风险账户       | `high_risk_account_unfreeze`；复用 A3 `transitionCustomerAccount`，直接 admin 解冻被领域守卫拒绝                                                  | `runs high_risk_account_unfreeze...`；`blocks direct admin unfreeze...`                                         |
| 人工处置域名管理凭据 | `domain_management_credential_disposition`；B5 不绕过 D9-D-2 的 customer ownership、step-up、绑定渠道和上游归属门，通用 HTTP 执行入口 fail-closed | `runs domain_management_credential_disposition through request, approval, cooldown, and execution`              |
| 批量影响用户资产     | `bulk_customer_asset_operation`；B5 不绕过 D9-D-1/D9-D-3 的 preview、step-up、owner 和离线状态机，通用 HTTP 执行入口 fail-closed                  | `runs bulk_customer_asset_operation through request, approval, cooldown, and execution`                         |

后三类没有在本切片创建空领域实现：审批服务提供真实的发起、审批、冷静期、原子认领、通知和审计生命周期；在相应领域能力未提供安全 executor 时，浏览器通用执行入口明确拒绝。后续 E2 或域名人工处置接入时必须从领域服务调用 `executeAdminApprovalRequest`，不能把 B5 executor 当作绕过 A4 的管理员后门。

## 3. A4 风险分级逐项复核（9/9）

B5 是管理员侧的附加授权层，不替代、不降低客户侧 A4。逐项结果：

| A4 操作                                | 冻结保护档位                                                                   | B5 影响                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 添加普通子域解析                       | 当前会话 + 审计                                                                | 不变；仅批量管理员处置额外进入 B5                                 |
| 根域 A/CNAME/AAAA、全部主机 MX/TXT、NS | step-up + 二次确认                                                             | 不变；B5 批量授权不能替代 purpose-bound grant 和确认预览          |
| 批量删除解析                           | step-up + 变更预览                                                             | 不变；管理员批量影响资产还需 B5 三步                              |
| 关闭域名锁                             | step-up + 通知                                                                 | 不变；B5 未新增锁状态入口                                         |
| 修改实名信息                           | step-up + 二次确认                                                             | 不变；B5 未新增实名修改入口                                       |
| 获取/修改域名管理密码                  | step-up + active 绑定渠道存在性 + 成功后全 active 渠道通知/逐 provider outcome | 不变；管理员凭据处置类型不能通过通用 executor 绕过 D9-D-2         |
| 交互式余额消费                         | step-up                                                                        | 不变；B5 管理员余额调整另走审批、冷静期和告警                     |
| 注销申请                               | step-up + 冷静期                                                               | 不变；B5 未修改注销状态机                                         |
| 找回或换绑后的身份风险                 | 冷静期内禁止上述全部高风险操作                                                 | 不变；账户找回决定本身增加 B5 三步，成功后的 A5/A4 冷静期继续生效 |

## 4. 数据来源与 fixture 去相关自查

| 判定事实                   | 易混淆的相关字段                                                   | 去相关用例                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行冷静期                 | `createdAt`、`approvedAt`、当前 policy cooldown、请求冻结 cooldown | `uses request creation time rather than approval time...` 把 `approved_at` 改到前一天；`uses the stored server creation time and policy snapshot...` 在创建后修改当前 policy，并提交伪造客户端时间 |
| 审批人不同                 | pre-read policy 与数据库列、requester 与 actor                     | `rechecks different-approver identity in SQL when the pre-read source is stale` 伪造 pre-read 为 false，数据库仍拒绝                                                                               |
| 决策/执行目标              | target 与 decoy 的 id、创建时间                                    | 两个 `limits ... to the exact request id` 用例令 target/decoy 都满足其他谓词，执行时间取较晚 decoy 的冷静期后                                                                                      |
| 操作类型与目标             | caller expected type、stored type、target index、JSON snapshot     | `rejects a stored operation type...`；`fails closed when a de-correlated target index disagrees...`                                                                                                |
| 大额金额                   | `amount_fen` 与 JSON                                               | `stores a large adjustment amount in the constrained fen column rather than duplicating its source in JSON`                                                                                        |
| persisted policy           | 更新请求 schema 与数据库已有 value                                 | `fails closed when the persisted cooldown source is corrupted independently...` 直接制造 persisted cooldown 0                                                                                      |
| delivery 候选              | pre-read status/due time 与 CAS 当前行                             | `rechecks claimable status atomically...`、`rechecks the due timestamp atomically...` 在候选读取后改变权威行                                                                                       |
| delivery finalize          | `attempt_count`、`claimed_at`                                      | 两个 `binds delivery finalization...` 用例分别只改变一个事实                                                                                                                                       |
| provider receipt 时间      | 当前 retry time 与首次 accepted receipt time                       | `queries SMS receipts with the immutable accepted-at fact rather than the retry time`                                                                                                              |
| provider 失败              | `retryable` 与 `statusKnown`                                       | `never retries a known non-retryable...` 和 `never retries an external failure whose upstream status is unknown` 分别打破两个布尔值的相关性                                                        |
| migration delivery attempt | attempt integer/max 与 pending state                               | verifier 使用 `sending + claimed_at` 的有效状态，只分别破坏小数 attempt 或 `attempt > max`                                                                                                         |

## 5. 应用层判定点（按调用点，53/53）

下列 ID 的可执行定义、源码替换和唯一具名用例位于 `apps/web/scripts/mutate-d9b5-approval-notification-decisions.mjs --list`。每个 ID 单独替换、单独启动指定测试；最终完整重跑结果为 `TOTAL 53/53`。

- 角色调用点：`admin-role-change-detection`、`admin-scope-change-detection`、`create-funds-scope`、`decision-funds-scope`、`execution-funds-scope`、`approval-list-funds-scope`、`delivery-list-funds-scope`、`policy-read-system-scope`、`policy-update-system-scope`。
- 冷静期输入/持久化：`persisted-cooldown-positive`、`updated-cooldown-positive`。
- 审批决定 CAS：`different-approver-js`、`different-approver-sql`、`decision-request-id`、`decision-pending-state`、`initiator-self-reject`。
- 执行认领 CAS：`execution-request-id`、`execution-operation-type`、`execution-approved-state`、`cooldown-clock-source`、`cooldown-eligibility`。
- 快照与最终确认：`snapshot-index-binding`、`finalize-executing-state`、`finalize-claim-key`、`finalize-actor`。
- 领域绕过：`account-recovery-approval-context`、`identity-conflict-approval-context`、`unfreeze-approval-context`。
- 隐私出口：`approval-sensitive-payload`、`approval-reason-sanitization`、`outbox-sensitive-content`。
- 渠道目标：`all-verified-channels`、`no-channel-in-app`。
- 投递 CAS：`claim-status-cas`、`claim-due-cas`、`delivery-attempt-binding`、`delivery-claim-time-binding`。
- 重试/回执：`retry-known-only`、`unknown-outcome-source`、`retry-attempt-limit`、`receipt-poll-limit`、`interrupted-send-no-replay`、`receipt-sent-at-source`。
- 偏好与用户认证：`transactional-unsubscribe`、`marketing-type-allowlist`、`preference-customer-auth`、`notification-list-customer-auth`、`notification-read-customer-auth`。
- 追加式边界：`approval-service-context`、`admin-access-append-only`、`outbox-append-only`、`receipt-append-only`、`read-state-append-only`。

## 6. migration 判定点（35/35）

可执行定义位于 `apps/web/scripts/mutate-d9b5-approval-notification-migration.mjs --list`，验证器为 `scripts/verify-d9b5-approval-notification-migration.mjs`。每项使用全新临时 PostgreSQL 数据库执行 up、行为写入和安全 down。

- enum/结构：`operation-list`、`marketing-preference-types`。
- 生产默认：`policy-different-approver`、`policy-positive-cooldown`、`request-different-approver`。
- 角色回填：`funds-scope`、`configuration-scope`。
- 审批数值/状态：`cooldown-integer`、`cooldown-positive`、`amount-integer`、`amount-positive`、`non-balance-amount-null`、`different-approver-row`、`pending-evidence`、`executing-claim-evidence`。
- outbox 快照：`category-type-coupling`、`template-version-positive`、`subject-nonblank`、`message-hash-length`。
- delivery/receipt：`attempt-integer`、`attempt-maximum`、`external-recipient`、`in-app-recipient`、`pending-attempt-evidence`、`delivered-time-evidence`、`receipt-attempt-positive`。
- 幂等唯一键：`approval-request-key`、`admin-access-event-key`、`outbox-event-key`、`delivery-key`、`receipt-key`、`read-event-customer`、`marketing-preference-customer`。
- 安全 down：`changed-policy`、`missing-admin-scope`。

首轮 verifier 新增默认值断言时错误地把 `psql` 命令尾行纳入 scalar，造成共同假阳性；该结果被废弃。拆成写入与独立 `SELECT` 后，可信重跑先得到 33/35，并发现 attempt fixture 同时违反 pending-state 的相关性；改用有效 `sending + claimed_at` fixture 后两个幸存项 2/2 被独立杀死。最终完整矩阵以修正后的 35/35 重跑为准。

## 7. 定向与完整门禁

- D9-B-5 单元 + integration：`60/60`（单元 8/8、integration 52/52）；
- 应用层变异：`53/53`；migration 变异：`35/35`；
- 并发：同一审批 8 路批准恰好 1 次，同一请求 8 路执行恰好 1 次，同一 delivery 8 路 worker 只发送/落回执 1 次；
- 所有数量断言均通过 customer、request、event、delivery、action/type 等 `where` 限定；
- 最终代码状态本地 `make check` 退出 0：115 文件 838/838 单元、43 文件 709/709 主 integration、1 文件 37/37 wallet-ledger integration，以及 migration、lint、TypeScript strict、Next.js、linux/amd64 镜像和安全门禁全部通过；精确 commit CI 结论在 PR 中记录；
- 全程 fixture，`ALLOW_REAL_*` 写闸为 false；没有部署或生产写入。
