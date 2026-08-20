# D9-E-1 邀请体系与反滥用监控变异矩阵

## 1. 范围与结论

本切片只实现开发计划 16.10 E3 六项邀请能力和 16.13 一项反滥用监控：不可枚举且可停用的
邀请码、服务端一次性归因、版本化米币奖励规则、订单终态驱动的延迟发放、五类反作弊信号、只挂起与
告警/人工复核，以及五类脱敏速率指标。没有实现或留桩永久 VIP 等级，没有自动扣回米币、自动限制或
冻结账号、浏览器指纹、返现、余额奖励、部署或真实 provider 写入。

最终定向变异结果：

| 层                                       | 按调用点计数 | 结果    | 执行器                                                       |
| ---------------------------------------- | -----------: | ------- | ------------------------------------------------------------ |
| 服务、Collection、路由依赖与监控判定     |           71 | 71/71   | `apps/web/scripts/mutate-d9e1-invitation-decisions.mjs`      |
| SQL 作用域、状态证据、来源替换与确定顺序 |           44 | 44/44   | `apps/web/scripts/mutate-d9e1-invitation-sql-predicates.mjs` |
| migration、约束、release 与 down 保护    |           36 | 36/36   | `apps/web/scripts/mutate-d9e1-invitation-migration.mjs`      |
| 合计                                     |          151 | 151/151 | 每项均由指定行为 `AssertionError` 杀死                       |

执行器先以 `--validate` 要求全部变异精确命中当前源码；实跑只把指定行为断言失败计为 killed。编译、SQL
语法、环境、装载或变异定位失败不计通过。迁移首轮两项非行为失败已如实排除：告警约束变异括号不平衡、
邀请关系唯一索引在旧数据 `ON CONFLICT` 回填前被删除。两项改为迁移可执行而在回填后短路约束，再分别由
`accepted an invalid write` 行为断言杀死。

恢复源码后的邀请聚焦基线为单元 5/5、集成 21/21；最终状态在全新隔离 PostgreSQL fixture 库从头运行
`make check` 并退出 0：117 个文件 857/857 单元、45 个文件 766/766 主集成、钱包账本 37/37、钱包
对账 11/11，集成合计 814/814；全部 migration 往返与 D9-E-1 verifier、release policy、Nginx/运维/
rebuild、lint、TypeScript strict、Next.js 宿主构建、linux/amd64 同镜像、依赖审计、工作树与完整 230
commits Gitleaks、Trivy 均通过。全部数据来自 fixture 和 mock provider；真实短信、微信支付/退款、域名及
生产写闸保持 false。

## 2. 指定独立行为用例

| 要求                | 独立用例与行为断言                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a. 邀请码不可枚举   | `encodes all 128 random bits and produces non-enumerable invitation codes`：直接断言随机源请求 16 bytes、base64url 解码逐字节等于全部 128 输入 bit、长度固定 22、2,048 次无碰撞；15-byte 随机源失败关闭。旧 12 位大写字母数字 schema 全集只作为兼容输入，不再生成。 |
| b. 停用码拒绝       | `does not bind a disabled invitation code`：停用后绑定返回 `INVITATION_CODE_DISABLED`，目标 invitee 关系计数为 0，并限定 inviter 审计计数。                                                                                                                         |
| c1. 二次绑定拒绝    | `rejects a second binding and preserves the first immutable relationship`：第二 inviter 被拒，首个 inviter、首个 device HMAC 与单条关系不变，并记录拒绝审计。                                                                                                       |
| c2. 窗口外拒绝      | `rejects binding outside the server-computed window`：只把数据库 customer `created_at` 推到 73 小时前，关系为 0，拒绝审计 reason 为 `window_expired`。                                                                                                              |
| d. 客户端时间无效   | `rejects client-supplied registration time instead of expanding the server window`：严格 schema 拒绝 `registeredAt`；绑定 SQL只使用数据库 `NOW()` 与 customer `created_at`。                                                                                        |
| e. 被邀请人幂等     | `rewards one invitee only once across multiple succeeded orders`：两个成功订单仍只有一个 claim、一个 `invitation_reward` batch、一个 pending 与一个 available；计数分别限定 invitee、inviter、source type 和 entry type。                                           |
| f. 未成功只 pending | `keeps a paid but not succeeded order pending and does not expose available points`：paid 后 pending=1、available=0；用 paid event 手工确认被确切状态证据拒绝。                                                                                                     |
| g1～g4. 四类信号    | 参数化的四条 `independently withholds pending reward for <signal>` 分别只建立同 device HMAC、同实名主体、同手机号 `identifierHash`、同支付账户 HMAC；各自断言 withheld 仅含该信号、available=0、人工复核=1、outbox=1。                                              |
| 异常增长            | `withholds abnormal invitation growth at the configured aggregate boundary`：只让同 inviter 在窗口内关系数达到阈值，断言唯一信号与 outbox。                                                                                                                         |
| h. 已发放零变化     | `flags newly detected abuse after release without changing ledger or account state`：命中前后按 inviter 限定的完整 points ledger 条目数与可用余额逐值相等。                                                                                                         |
| i. 不自动改账号     | 同一用例直接断言 A3 `status` 与 `capabilityRestrictions` 前后相等；仅追加 `flagged_after_release`、manual review 与 outbox。                                                                                                                                        |
| j. 指标脱敏         | `collects five de-correlated abuse rates from their authoritative fields without identifiers` 与监控 PostgreSQL CAS 用例分别把手机号、deviceId、证件号、identifierHash 放入未选择字段，直接断言 snapshot/alert JSON 不含原文或敏感字段名。                          |
| k. 五阈值告警       | 五条参数化 `<指标> 单独越限时产生独立脱敏告警` 分别只让短信请求、注册、邀请增长、米币赚取、余额绝对变动达到阈值；每条只允许一个对应 abuse alert。                                                                                                                   |

注册携码路径由 D9-A 用例 `does not create an account at OTP verification and records explicit registration
consents` 独立证明：新 customer 邀请码满足 128-bit 格式，关系 source 为 `registration`，设备字段严格等于
`clientHashes(headers, deviceId).deviceHash` 且序列化内容不含 deviceId 原文。

## 3. 并发、确定性与迭代顺序

- `lets exactly one concurrent binding take effect` 同时提交两个不同 inviter，唯一 invitee 索引与
  `INSERT ... ON CONFLICT (invitee_customer_id) DO NOTHING` 使恰好一路成功、关系恰好一条；不使用
  `payload.update({ where })`。
- `concurrently triggering one invitee creates exactly one pending reward` 八路处理同一 order event，claim 的
  invitee 唯一索引、points earning key 唯一索引及 E-2 原子生命周期共同保证 claim=1、pending entry=1。
- 绑定窗口规则和奖励快照两个查询都固定 `effective_at DESC, version DESC`；
  `deterministically selects the highest version when effective times tie` 让两版 `effective_at` 完全相同，分别
  反转两个调用点的主排序和 version 兜底，四个 SQL 变异各自失败。
- `persists multiple abuse signals in the canonical deterministic order` 同时命中 device 与 phone，断言持久
  顺序严格为常量定义顺序。交换信号常量、反转 `.entries()` 输入、反转持久 `order` 值三个调用点分别
  失败；migration 另以 `(parent_id, order)` 和 `(parent_id, value)` 两个唯一索引拒绝重复事实。
- `scans released rewards by ascending claim id with an exact deterministic limit` 建立两个已发放 claim、后置
  加信号并以 `limit: 1` 扫描；反转 `claims.id ASC` 或把 exact limit 换成常量都由该用例独立杀死。
- 监控的五项 threshold 循环只产生互相独立、带 condition 的集合，不存在优先级或截断；每一项已有单独
  越限用例。告警写入循环使用由 window/category/condition 构成的独立 target，不因迭代先后改变结果。
  其它生产循环只累加整数或遍历已显式排序结果，未发现隐式 Map/Set/Object 优先级。

## 4. 数据来源替换与 fixture 去相关

| 判定依据                                      | 容易误相关的替代字段                         | 去相关 fixture / 独立变异                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新邀请码随机 bit                              | 字符串长度/表面随机                          | 固定 0～15 全字节输入并反解 16 bytes；随机长度和编码调用点分别变异。                                                                                                                                     |
| 服务端绑定窗口                                | 客户端 `registeredAt`                        | schema 明确拒绝客户端时间；DB `created_at` 单独移到窗口外。                                                                                                                                              |
| 提交的邀请码                                  | 数据库中另一个可用 code                      | fixture 同时有多个 inviter；把 `=` 改成 `<>` 会错误绑定 decoy 并被首关系断言杀死。                                                                                                                       |
| 关系 invitee / legacy projection              | 相同数值 id 或已有 projection                | 二次 inviter、projection inviter 和 requested inviter 三者不同；关系插入与 customer CAS 分开断言。                                                                                                       |
| 规则 `effective_at` / `version`               | 创建物理顺序                                 | 两版时间完全相同而 version 不同；主排序和兜底分别反转。                                                                                                                                                  |
| 订单 id、owner、status、event id/owner/status | 同 customer 的另一订单或同状态事件           | `rejects a transition event sourced from another customer and order` 同时建立跨 customer 订单、同 customer 另一订单、错误 customer event、错误 status event 和唯一正确 event，八个状态证据字段逐个替换。 |
| claim source customer/order                   | batch 的奖励接收 customer                    | inviter 与 invitee 始终不同；把 source customer 换成接收账户或把 order 换成 customer id 均失败。                                                                                                         |
| device 信号                                   | IP hash/deviceId 原文                        | 关系只保存 `clientHashes(...).deviceHash`；注册和后绑定分别把来源换成 `ipHash` 的两个变异独立失败。                                                                                                      |
| 实名主体                                      | order owner/模板状态/单一证件字段            | inviter 与 invitee 使用两个 approved 模板，只让 document type + number 相等；其它三类信号保持不同。                                                                                                      |
| 手机号信号                                    | customer 明文 phone                          | 只复制 `customerIdentities.identifier_hash`，两侧手机号明文字段不作为查询来源；替换 hash 列变异失败。                                                                                                    |
| 支付账户信号                                  | transaction id、merchant order 或 raw openid | provider 只从官方 `payer.openid` 取值，通知/查单、支付与充值各调用点 HMAC 变异；数据库只接受 64 位小写十六进制。                                                                                         |
| 异常邀请增长                                  | 全站关系数                                   | 多 inviter fixture；把 inviter scope 换成 invitee/错误来源时该 inviter 的阈值行为失败。                                                                                                                  |
| 短信/注册/邀请速率                            | 任意 `createdAt` 或其它 Collection           | 分别绑定 `smsChallenges.sentAt`、`customerSecurityEvents(event=registration_completed).occurredAt`、`invitationRelationships.boundAt`；集合、event 与时间字段共七个来源替换变异。                        |
| 米币赚取/余额变动                             | 条目数、缓存余额或其它金额列                 | points 使用 batch `points` 求和；wallet 只读取 credit/capture/recovery 的 `amountFen` 绝对流量。集合、类型与金额来源五个变异，fixture 数值互不相等。                                                     |
| 迁移旧数据与 source customer                  | 新 customer 或奖励接收账户                   | verifier 预置 legacy invitedBy 与 E-2 batch；回填 source 必须等于 batch customer，关系 source 必须为 `legacy_backfill` 且不旋转 code。                                                                   |

## 5. A4 风险分级逐项 9/9

本切片没有新增或降低 A4 高风险动作。邀请绑定、停用邀请码属于已认证客户的一次性归因元数据操作，走
A3 `login`、服务端窗口/CAS 与审计；规则配置只允许 active `system_admin` 并写审计；奖励处理和反作弊
巡检是订单事实触发的 system 路径；命中信号只追加 withheld/flagged、人工复核和通知，不调用
`transitionCustomerAccount`。五类监控是 D7 system-only 聚合读取，不产生业务写入。

| A4 操作                                    | D9-E-1 影响与档位结论                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 添加普通子域解析                           | 无调用点；既有“当前会话 + 审计”不变。                                                                  |
| 修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS | 无调用点；既有 step-up + 二次确认不变。                                                                |
| 批量删除解析                               | 无调用点；既有 step-up + 变更预览不变。                                                                |
| 关闭域名锁                                 | 无调用点；既有 step-up + 通知不变。                                                                    |
| 修改实名信息                               | 只读 approved 模板作反作弊比较，不修改模板；既有 step-up + 二次确认不变。                              |
| 获取/修改域名管理密码                      | 无调用点；既有 step-up、active 渠道存在性及事后全渠道告知不变。                                        |
| 余额消费（交互式）                         | 只读钱包追加事实的脱敏聚合；奖励只进 E-2 points，不写 wallet、不涉及 fen 消费，既有余额 step-up 不变。 |
| 注销申请                                   | 无调用点；既有 step-up + 冷静期不变。                                                                  |
| 找回/换绑冷静期                            | 不执行表中高风险操作；邀请入口只复用 A3 login，命中信号也不自动改变账户状态。                          |

## 6. 服务、Collection 与监控判定点（71）

下表按真实调用点列出全部 ID；同一 helper 的不同调用方分别计数。

| 组（数量）              | 全部判定点 ID                                                                                                                                                                                                                                                                                                                                 | 单独杀死它的行为用例                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| code (4)                | `code-random-byte-count`、`code-base64url-encoding`、`legacy-code-normalization`、`new-code-normalization`                                                                                                                                                                                                                                    | 128-bit 不可枚举用例；legacy 兼容用例                                                                 |
| schema (1)              | `bind-schema-client-time-strict`                                                                                                                                                                                                                                                                                                              | rejects client-supplied registration time instead of expanding the server window                      |
| collection-access (12)  | `InvitationRewardRuleVersions-create/delete/update`、`InvitationRelationships-create/delete/update`、`InvitationRewardClaims-create/delete/update`、`InvitationRewardEvents-create/delete/update`                                                                                                                                             | rejects generic mutations and both update/delete hook callpoints for append-only records              |
| collection-hooks (4)    | 四个 Collection 各自的 `append-only-hooks` 调用点                                                                                                                                                                                                                                                                                             | 同上；每个 Collection 的 update/delete Hook 均执行                                                    |
| authorization (5)       | `post-bind-customer-auth`、`disable-code-customer-auth`、`post-bind-a3-login`、`disable-code-a3-login`、`rule-system-admin`                                                                                                                                                                                                                   | enforces customer authentication, A3 login capability, and system-admin rule ownership                |
| rule-input (1)          | `rule-positive-window`                                                                                                                                                                                                                                                                                                                        | 同授权/规则输入用例中的 0 小时拒绝                                                                    |
| rule-version (1)        | `rule-version-increment`                                                                                                                                                                                                                                                                                                                      | deterministically selects the highest version when effective times tie                                |
| registration (3)        | `registration-new-code-generation`、`registration-invitation-binding`、`registration-device-hash-source`                                                                                                                                                                                                                                      | D9-A explicit registration 用例                                                                       |
| binding-source (1)      | `post-bind-device-hash-source`                                                                                                                                                                                                                                                                                                                | rejects a second binding and preserves the first immutable relationship                               |
| audit (5)               | `binding-success-audit`、`binding-rejection-audit`、`code-disable-audit`、`rule-created-audit`、`reward-event-audit`                                                                                                                                                                                                                          | 二次绑定、停用码、同时间规则、被邀请人单次奖励四组审计断言                                            |
| order-hook (3)          | `order-hook-paid`、`order-hook-fulfilling`、`order-hook-succeeded`                                                                                                                                                                                                                                                                            | paid 只 pending；多成功订单只奖励一次                                                                 |
| reward-branch (5)       | `reward-order-must-be-claimed-order`、`reward-not-available-before-succeeded`、`reward-signal-hold-branch`、`released-requires-available-event`、`released-no-signal-short-circuit`                                                                                                                                                           | 多订单幂等、paid pending、device hold、pending recheck、无信号 recheck                                |
| deterministic-order (3) | `signal-canonical-order`、`signal-event-iteration-order`、`signal-event-order-value`                                                                                                                                                                                                                                                          | canonical constant 单元用例；multiple signals 集成用例                                                |
| monitor-threshold (5)   | `threshold-smsRequestCount`、`threshold-registrationCount`、`threshold-invitationGrowthCount`、`threshold-pointsEarned`、`threshold-walletAbsoluteChangeFen`                                                                                                                                                                                  | 五条 `<指标> 单独越限时产生独立脱敏告警`                                                              |
| monitor-source (12)     | `sms-rate-collection`、`sms-rate-time-source`、`registration-rate-collection`、`registration-rate-event`、`registration-rate-time-source`、`invitation-rate-collection`、`invitation-rate-time-source`、`points-rate-collection`、`points-rate-value-source`、`wallet-rate-collection`、`wallet-rate-entry-types`、`wallet-rate-value-source` | collects five de-correlated abuse rates from their authoritative fields without identifiers           |
| payer-hash (6)          | `provider-payer-field-source`、`provider-notification-payer-callpoint`、`provider-query-payer-callpoint`、`payment-notification-hmac`、`top-up-payer-hmac`、`top-up-payer-hash-field-read`                                                                                                                                                    | provider、payment 与 top-up 各自既有行为用例直接断言 payer 事实/HMAC；客户视图不得返回稳定 payer hash |

## 7. SQL 作用域、来源、状态证据与顺序（44）

| 组（数量）        | 全部判定点 ID                                                                                                                                                                                                                                                                                                                                              | 行为保护                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| binding (11)      | `binding-rule-effective-order`、`binding-rule-version-tiebreak`、`binding-inviter-code`、`binding-code-active`、`binding-not-self`、`binding-server-window`、`binding-projection-target`、`binding-projection-null-cas`、`diagnose-existing-relationship`、`disable-code-customer-scope`、`disable-code-present`                                           | 同时间规则、停用、自邀/未知码、窗口外、二次绑定、projection 冲突各独立用例          |
| reward (13)       | `claim-lock-invitee`、`claim-order-id`、`claim-order-relationship-owner`、`claim-order-input-owner`、`claim-order-state`、`claim-relationship-invitee`、`claim-rule-effective-order`、`claim-rule-version-tiebreak`、`claim-rule-enabled`、`transition-order-id`、`recheck-claim-id`、`scan-id-tiebreak`、`scan-exact-limit`                               | 并发 reward、来源去相关、paid pending、disabled rule、released 零变化、确定扫描     |
| signal (5)        | `same_device_hash-decision`、`same_realname_subject-decision`、`same_phone_hash-decision`、`same_payment_account_hash-decision`、`abnormal-invitation-growth-decision`                                                                                                                                                                                     | 五类信号各自独立命中                                                                |
| signal-source (5) | `device-hash-source`、`realname-subject-source`、`phone-identifier-hash-source`、`payment-payer-hash-source`、`growth-inviter-source`                                                                                                                                                                                                                      | 对应五类信号的权威字段替换用例                                                      |
| points (10)       | `earn-transition-evidence-callpoint`、`confirm-transition-evidence-callpoint`、`transition-evidence-order-id`、`transition-evidence-order-customer`、`transition-evidence-order-state`、`transition-evidence-event-id`、`transition-evidence-event-customer`、`transition-evidence-event-state`、`batch-source-customer-write`、`batch-source-order-write` | paid/succeeded 分离、错误 order/customer/event/status、批次 source 快照与多订单幂等 |

## 8. Migration、release 与 down 判定点（36）

全部由 `scripts/verify-d9e1-invitations-migration.mjs` 在每个变异各自的临时数据库中执行完整 up、非法写
拒绝、事实保护 down 与 clean down；数据库按进程精确命名并在 `finally` 删除。

| 组（数量）        | 全部判定点 ID                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| release (5)       | `release-phase`、`release-new-code-compatibility`、`release-old-code-compatibility`、`release-rollback-policy`、`release-manifest-entry`                              |
| enum (2)          | `points-source-enum`、`notification-type-enum`                                                                                                                        |
| notification (1)  | `transactional-alert-category`                                                                                                                                        |
| points-source (3) | `points-source-customer-backfill`、`points-source-customer-required`、`points-source-customer-foreign-key`                                                            |
| legacy (1)        | `legacy-relationship-backfill-source`                                                                                                                                 |
| rules (3)         | `rule-version-unique`、`rule-points-integral`、`rule-window-limit`                                                                                                    |
| relationships (4) | `relationship-not-self`、`relationship-window-order`、`relationship-key-unique`、`relationship-invitee-unique`                                                        |
| claims (7)        | `claim-not-self`、`claim-points-integral`、`claim-expiry-order`、`claim-key-unique`、`claim-relationship-unique`、`claim-invitee-unique`、`claim-source-order-unique` |
| events (5)        | `event-lifecycle-batch-shape`、`event-key-unique`、`event-claim-type-unique`、`signal-order-unique`、`signal-value-unique`                                            |
| payer-hash (3)    | `payment-notification-hash-shape`、`payment-archive-hash-shape`、`top-up-hash-shape`                                                                                  |
| down-guard (2)    | `reward-fact-down-guard`、`notification-fact-down-guard`                                                                                                              |

## 9. 复现命令与边界

```bash
node apps/web/scripts/mutate-d9e1-invitation-decisions.mjs --validate
node apps/web/scripts/mutate-d9e1-invitation-sql-predicates.mjs --validate
node apps/web/scripts/mutate-d9e1-invitation-migration.mjs --validate

DATABASE_URL=<isolated-fixture-db> node apps/web/scripts/mutate-d9e1-invitation-decisions.mjs
DATABASE_URL=<isolated-fixture-db> node apps/web/scripts/mutate-d9e1-invitation-sql-predicates.mjs
node apps/web/scripts/mutate-d9e1-invitation-migration.mjs
node scripts/verify-d9e1-invitations-migration.mjs
```

变异运行不接触生产；Web/provider tests 使用 mock/fixture。执行器仅在测试进程内临时改一个目标文件，
无论结果如何都在 `finally` 恢复；最终 `git diff --check` 与源码状态检查确认没有残留变异。

完整门禁收口过程如实保留：前置尝试依次暴露并修复本地缺少 customer identity fixture key、实名 fixture
主密钥格式、expand migration 同切片新增非空列、schema drift、未使用 fixture 参数、audit/RBAC 冻结
目录遗漏，以及通知模板版本字面量触发的 Gitleaks 误报。最终运行使用精确命名的新数据库
`wanmi_d9e1_final7_20260820`，所有真实 provider 开关均为 false，并从 bootstrap 开始完整执行；退出 0 后
按精确库名、owner `wanmi`、零连接三项验证删除该本地 fixture 库。容器静态生成期间曾记录对容器内
`127.0.0.1:5432` 的预期连接拒绝，但页面生成、镜像构建和整个门禁继续完成且最终退出 0；没有连接生产。
