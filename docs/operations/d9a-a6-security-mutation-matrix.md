# D9-A A6 注销与账户关闭安全判定变异对照表

- 日期：2026-08-16
- 分支：`codex/d9-a6-account-closure`
- SQL 入口：`node apps/web/scripts/mutate-a6-sql-predicates.mjs`
- 安全/正确性入口：`node apps/web/scripts/mutate-a6-security-decisions.mjs`
- 完整逐点映射：分别在上述命令后加 `--list`，输出每个 ID 的精确文件和唯一行为用例。
- 计入标准：每次只写入一个删除或短路变异；指定 Vitest 必须非零退出且包含
  `AssertionError:`。编译、装载、定位或其他非行为失败不计为杀死；执行器在 `finally` 恢复源码。
- 最终结果：SQL 63/63、安全/正确性 124/124，合计 **187/187
  `KILLED_BY_BEHAVIOR`**；无 survivor，无非行为失败被计入结果。

## 汇总

| 分组                 |    数量 | 判定面                                              | 结果               |
| -------------------- | ------: | --------------------------------------------------- | ------------------ |
| precondition-sql     |      32 | 七项关闭前置检查的归属、关联、状态和余额谓词        | 32/32 KILLED       |
| closure-cas-sql      |      12 | 申请、撤销、最终执行的 `UPDATE … WHERE … RETURNING` | 12/12 KILLED       |
| release-sql          |       6 | claim 释放、身份解除、客户匿名化                    | 6/6 KILLED         |
| requested-lookup-sql |       2 | 不可变 requested 事件定位                           | 2/2 KILLED         |
| rebind-sql           |       5 | provider、实例、当前/已释放 hash 与优先级           | 5/5 KILLED         |
| deletion-grant-sql   |       6 | A4 一次性 grant 原子消费全部谓词                    | 6/6 KILLED         |
| schema               |      28 | 三类输入及非零 UUID                                 | 28/28 KILLED       |
| route                |      22 | body 边界、JSON、身份门禁及 202 语义                | 22/22 KILLED       |
| fail-closed-guards   |      13 | 查询结果、持久化 blocker/时间及查询失败             | 13/13 KILLED       |
| actor                |       6 | customer 归属与 system_admin principal              | 6/6 KILLED         |
| closure-workflow     |      18 | 一次性授权、状态、claim、冷静期与早退               | 18/18 KILLED       |
| shared-step-up       |       2 | `account_deletion` 一次性分类及 A4 身份风险冷静期   | 2/2 KILLED         |
| final-effects        |      10 | A3 两段迁移、实名、身份、匿名化和结果记录           | 10/10 KILLED       |
| audit-security       |       7 | 四类 audit action 与三类安全事件                    | 7/7 KILLED         |
| collection           |       8 | 追加式权限、敏感字段及 blocker 校验                 | 8/8 KILLED         |
| rebind-guards        |      10 | 重绑定失败关闭、时间判断及四个调用入口              | 10/10 KILLED       |
| **合计**             | **187** |                                                     | **187/187 KILLED** |

## SQL 谓词逐点清单（63/63）

下列每个 ID 都实际独立运行。脚本将 ID、源码片段和唯一行为用例绑定；`--list` 可直接核对
三者，不存在组内抽样。

### 七项前置检查（32/32）

`domains-customer-id`, `orders-customer-id`, `orders-nonterminal-status`,
`renewals-customer-id`, `renewals-pending-status`, `refund-order-join`,
`refund-customer-id`, `refund-unsettled-status`, `reconciliation-record-key-relation`,
`reconciliation-summary-relation`, `reconciliation-order-relation`,
`reconciliation-customer-id`, `reconciliation-open-status`, `invoice-order-join`,
`invoice-customer-id`, `invoice-action-type`, `invoice-latest-per-order`,
`invoice-recorded-at-order`, `invoice-id-tiebreaker`, `invoice-processing-status`,
`security-customer-id`, `security-suspended-status`, `security-refund-review-capability`,
`manual-review-customer-id`, `manual-review-open-status`, `disputed-refund-order-join`,
`disputed-refund-customer-id`, `disputed-refund-category`,
`disputed-refund-unsettled-status`, `wallet-relation-exists-guard`, `wallet-customer-id`,
`wallet-positive-available-balance`。

行为断言分别覆盖：目标 customer 作用域；持有域名、未完成订单、待执行自动续费、退款或对账差异、
发票处理中、安全冻结或争议、正余额七项单独命中；终态/已解决记录不得误报；record key 与 summary
两条对账关系、suspended 与 refund-review 两条安全来源均独立成立。每个 blocker 的正常查询、查询异常和
最终执行刷新都有独立用例，查询异常映射到同名 `_check_unavailable` 并阻止执行。

### 申请、撤销与最终执行 CAS（12/12）

`request-customer-id`, `request-allowed-status`, `request-no-active-request`,
`request-no-execution-claim`, `revoke-customer-id`, `revoke-request-key`,
`revoke-no-execution-claim`, `revoke-allowed-status`, `execute-customer-id`,
`execute-request-key`, `execute-no-existing-claim`, `execute-allowed-status`。

行为用例分别制造错 customer、过期状态快照、已有申请、已有执行 claim、错 request key 和已消费状态；
撤销与最终执行各以 8 路并发证明恰好 1 成功。所有数量断言都限定 request、customer、event 或 status。

### 释放、不可变申请与身份重绑定（13/13）

`release-claim-customer-id`, `release-identity-customer-id`,
`release-identity-active-status`, `release-identity-never-released`,
`release-identity-no-existing-rebind-time`, `anonymize-customer-id`,
`requested-event-request-key`, `requested-event-type`, `rebind-provider`,
`rebind-provider-instance`, `rebind-current-hash`, `rebind-released-hash`,
`rebind-current-binding-precedence`。

行为用例保留其他客户、非 active、已释放和已有重绑定时间的对照行；删除任一谓词都会错误改写对照行或
选择错误身份。requested 查询只接受相同 request key 的原始 `requested` 事件，撤销/刷新记录不能冒充。

### A4 一次性 grant 原子消费（6/6）

`deletion-grant-token-hash`, `deletion-grant-customer-id`, `deletion-grant-purpose`,
`deletion-grant-device-hash`, `deletion-grant-unconsumed`, `deletion-grant-unexpired`。

行为用例 `keeps every one-time deletion grant SQL predicate necessary` 为六个账号分别只破坏 token、
customer、purpose、device、未消费、未过期中的一项；基线全部以 `STEP_UP_GRANT_INVALID` 拒绝，删除
对应谓词时只有该项被错误放行。最终 count 以六个目标 customer 的 `where` 限定且必须为 0。

## JS guard、权限、迁移调用与早退逐点清单（124/124）

### Schema（28/28）

`request-confirmation-required`, `request-confirmation-literal`, `request-device-required`,
`request-device-minimum`, `request-device-maximum`, `request-reason-required`,
`request-reason-trim`, `request-reason-minimum`, `request-reason-maximum`,
`request-grant-required`, `request-grant-shape`, `request-schema-strict`,
`revoke-confirmation-required`, `revoke-confirmation-literal`, `revoke-reason-required`,
`revoke-reason-trim`, `revoke-reason-minimum`, `revoke-reason-maximum`,
`revoke-schema-strict`, `execute-confirmation-required`, `execute-confirmation-literal`,
`execute-note-required`, `execute-note-trim`, `execute-note-minimum`,
`execute-note-maximum`, `execute-schema-strict`, `request-id-uuid`, `request-id-nonzero`。

行为用例逐字段验证必填、literal、trim、上下界、43 字符 token、strict object、UUID 及 nil UUID。

### 路由（22/22）

`request-route-content-type`, `request-route-declared-finite`,
`request-route-declared-nonnegative`, `request-route-declared-maximum`,
`request-route-actual-maximum`, `request-route-malformed-json`,
`request-route-identity-gate`, `revoke-route-content-type`,
`revoke-route-declared-finite`, `revoke-route-declared-nonnegative`,
`revoke-route-declared-maximum`, `revoke-route-actual-maximum`,
`revoke-route-malformed-json`, `revoke-route-identity-gate`,
`execute-route-content-type`, `execute-route-declared-finite`,
`execute-route-declared-nonnegative`, `execute-route-declared-maximum`,
`execute-route-actual-maximum`, `execute-route-malformed-json`,
`execute-route-identity-gate`, `request-route-accepted-status`。

三条路由分别验证 content type、声明长度有限/非负/上限、实际 UTF-8 上限、坏 JSON 和身份门禁；申请
成功必须保持 202，撤销/执行为 200。

### 查询与持久化失败关闭（13/13）

`unavailable-blocker-mapping`, `positive-id-safe-integer`, `positive-id-positive`,
`database-boolean-true`, `database-boolean-false`, `precondition-true-branch`,
`precondition-failure-branch`, `stored-blockers-array`, `stored-blockers-unique`,
`stored-blockers-known-values`, `stored-timestamp-finite`, `requested-query-failure`,
`requested-row-required`。

行为断言要求数据库只返回真正 boolean；任一前置查询抛错必须生成独立 unavailable blocker；持久化的
ID、blocker 数组和三个时间字段损坏、requested 查询失败或缺行均稳定失败关闭。

### Actor 与权限（6/6）

`customer-actor-kind`, `customer-actor-id`, `admin-system-role`, `admin-matching-id`,
`admin-id-safe-integer`, `admin-id-positive`。

用例分别提供同 ID 非 customer、其他 customer、非 system_admin、principal 不匹配、非整数和非正管理员
ID；任何关闭写入前都必须拒绝。

### 申请、撤销、执行与早退（18/18）

`requested-record-key-kind`, `nonrequested-record-key-uniqueness`,
`request-active-source-state`, `request-restricted-source-state`, `step-up-customer-id`,
`step-up-device-id`, `step-up-purpose`, `step-up-token`, `step-up-authorization-required`,
`request-claim-returned-row`, `revocation-request-owner`, `revocation-returned-row`,
`execution-claim-returned-row`, `release-claim-returned-row`,
`anonymization-returned-row`, `closure-cooldown-comparison`,
`closure-cooldown-blocker`, `any-blocker-early-return`。

这组覆盖原始/后续记录键、允许申请的两个源状态、A4 授权调用全部参数、三个 CAS 的 returned row、
撤销 owner、claim 释放与匿名化返回值，以及关闭冷静期和任一 blocker 的最终执行早退。

### 共享 A4 step-up（2/2）

`account-deletion-one-time-classification`, `identity-risk-cooldown-required`。

前者删除 `account_deletion` 的 one-time 分类后旧 grant 被错误复用；后者删除
`assertIdentityRiskCooldownInactive` 后刚找回/换绑账号被错误允许申请关闭。两项均由 A6 行为用例单独杀死。

### 最终执行副作用（10/10）

`first-transition-expected-status`, `first-transition-closing-target`,
`disable-realname-templates`, `identity-rebind-duration`, `release-identities`,
`second-transition-expected-closing`, `second-transition-closed-target`,
`anonymize-final-profile`, `executed-record-event-type`, `retention-realname-deadline`。

最终执行必须复用 A3 从快照状态进入 `closing` 再由 `closing` 进入 `closed`，并禁用实名模板、解除身份、
匿名化资料、写 executed 追加记录与 30 天实名主存储/备份删除结果。重绑定冷却按配置持久化并精确验证时长。

### 审计、安全事件与 Collection（15/15）

`request-audit-action`, `revoke-audit-action`, `blocked-audit-action`,
`execute-audit-action`, `request-security-event`, `revoke-security-event`,
`execute-security-event`, `collection-create-access`, `collection-read-access`,
`append-only-update-hook`, `append-only-delete-hook`, `blockers-array-validation`,
`blockers-unique-validation`, `blockers-known-validation`, `reason-sensitive-field-access`。

audit count 逐项限定 target/action，安全事件 count 限定 customer/event；Collection 对浏览器 create、越权
read、系统 override update/delete 都拒绝，reason 对 customer 隐藏，blocker 列表必须为数组、无重复且值在
固定 allowlist。

### 身份重绑定 guard 与调用面（10/10）

`rebind-query-failure`, `rebind-no-row`, `rebind-current-bound-guard`,
`rebind-released-hash-guard`, `rebind-timestamp-finite`, `rebind-expiry-allow`,
`phone-auth-rebind-check`, `wechat-auth-rebind-check`,
`registration-phone-rebind-check`, `binding-rebind-check`。

查询失败、当前仍绑定、released hash 错配和时间损坏都失败关闭；到期前 phone/Wechat 登录、注册和绑定四个
入口全部拒绝，到期后允许。SQL 选择与 JS guard 两层分别变异，避免只证明其中一层。

## 基线恢复与完整门禁

全部变异恢复后，A6 单元/集成聚焦套件通过；最终代码状态的 `make check` 结果、精确 commit CI 结论和
生产写入声明记录在开发日志与 PR 报告。变异过程只使用本地 PostgreSQL/fixture/mock，没有部署、生产
访问、真实短信、真实交易或 provider 写调用。
