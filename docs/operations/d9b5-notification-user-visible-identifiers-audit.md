# D9-B-5 通知用户可见标识审计

## 缺陷与修复边界

`adminApprovalRequests.requestKey` 是内部 UUID。旧执行通知把它写入正文；当 UUID 偶然包含
`1[3-9]` 开头的连续 11 位数字时，`assertImmutableSafeContent` 会正确识别为疑似完整手机号并拒绝入队。
通知入队位于高风险操作执行事务内，因此拒绝会使执行事务回滚并产生与实际原因无关的
`NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN`。

本修复不修改 `sanitize-sensitive-data.ts`，也不吞掉 outbox 错误。用户可见执行正文删除内部 UUID；
`requestKey` 继续原样保留在审批记录、`eventKey`、访问事件幂等后缀和领域执行 trace 中。执行通知模板正文
发生变化，因此 `templateVersion` 从 1 升为 2。

## 全仓 enqueue 调用点与动态插值

检索命令：

```text
rg -n "enqueueTransactionalSecurityNotification\(" apps/web/src --glob '*.ts'
```

除函数定义外，生产源码只有以下两个调用点；逐一检查 `body` 与 `subject` 后，没有订单号、交易号、hash
前缀、UUID、request key、自由输入或 provider 标识进入用户可见文本：

| 调用点         | 用户可见字段 | 动态插值来源                                    | 边界与结论                                                                                                   |
| -------------- | ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 高风险操作提交 | `body`       | `OPERATION_LABELS[input.operationType]`         | key 由 `adminApprovalCreateSchema` 的固定八项 enum 限定，value 是源码内固定中文标签，不是内部标识            |
| 高风险操作提交 | `body`       | `createdAt`                                     | 同事务从数据库 `created_at` 读取并规范化为 ISO 8601；数字由 `-`、`T`、`:`、`.` 分隔，不形成连续手机号/证件号 |
| 高风险操作提交 | `body`       | `policy.cooldownSeconds`                        | `adminApprovalPolicySchema` 与数据库约束均限定整数 1–604800，最多六位，不可能形成 11 位手机号或 18 位证件号  |
| 高风险操作提交 | `subject`    | 无                                              | 静态文本“高风险操作已提交”                                                                                   |
| 高风险操作执行 | `body`       | `OPERATION_LABELS[input.expectedOperationType]` | expected type 使用同一固定八项 enum，value 是固定中文标签；旧 `requestKey` 插值已删除                        |
| 高风险操作执行 | `subject`    | 无                                              | 静态文本“高风险操作已执行”                                                                                   |

`eventKey` 不是用户可见正文或主题，仍分别使用
`admin-approval:<requestKey>:requested` 与 `admin-approval:<requestKey>:executed` 保持原有幂等身份；审批关系、
访问事件与审计路径同样不变。

调用点与回归必须保持一一对应：每新增一个生产
`enqueueTransactionalSecurityNotification` 调用点，必须在同一变更中为该调用点新增一条确定性回归，注入
含 `13012345678` 的内部标识并断言领域事务成功、通知恰好一条且用户可见 `body` / `subject` 不含该标识；
同时更新本表。只覆盖 outbox 的通用敏感扫描，不算覆盖具体调用点。当前生产调用点 2 个，专属回归 2 条。

## 确定性回归与变异

两个集成用例分别保护两个调用点，两个 request key 都含有必然命中既有 `chineseMobile` 正则的
`13012345678`：

- `keeps a phone-like internal request UUID out of submitted notification text and commits creation`：在
  request key 生成点一次性注入 `00000000-0000-4000-8000-13012345678a`，断言审批持久化为
  `pending_approval`，提交通知与 requested 访问事件各恰好一条，`eventKey` 保留 UUID，而
  `bodySnapshot` / `subjectSnapshot` 不含 UUID 或手机号片段；
- `keeps a phone-like internal request UUID out of executed notification text and commits execution`：把已创建
  审批的 request key 精确改为 `11111111-1111-4111-8111-13012345678b`，断言领域 effect 恰好一次、审批
  持久化为 `executed`，执行通知与 executed 访问事件各恰好一条，`eventKey` 保留 UUID，而
  `bodySnapshot` / `subjectSnapshot` 不含 UUID 或手机号片段。

同一命令同时运行这两条回归。第一轮只把 `${requestKey}` 插入提交正文，结果精确为提交用例失败、执行用例
通过（`1 failed | 1 passed`），原始承重报错为：

```text
FAIL ... > keeps a phone-like internal request UUID out of submitted notification text and commits creation
AssertionError: promise rejected "AppError: 通知正文不得包含完整手机号、证件或凭据 { …(3) }" instead of resolving
Caused by: AppError: 通知正文不得包含完整手机号、证件或凭据
❯ assertImmutableSafeContent src/services/notifications/outbox.ts:91:11
❯ enqueueTransactionalSecurityNotification src/services/notifications/outbox.ts:162:3
❯ src/services/admin/approvals.ts:259:11
Serialized Error: { code: 'NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN', status: 400, options: {} }
Tests  1 failed | 1 passed | 52 skipped (54)
```

恢复提交正文后，第二轮只把 `${claimed.approval.requestKey}` 插入执行正文，结果精确为提交用例通过、执行用例
失败（`1 failed | 1 passed`），原始承重报错为：

```text
FAIL ... > keeps a phone-like internal request UUID out of executed notification text and commits execution
AssertionError: promise rejected "AppError: 通知正文不得包含完整手机号、证件或凭据 { …(3) }" instead of resolving
Caused by: AppError: 通知正文不得包含完整手机号、证件或凭据
❯ assertImmutableSafeContent src/services/notifications/outbox.ts:91:11
❯ enqueueTransactionalSecurityNotification src/services/notifications/outbox.ts:162:3
❯ src/services/admin/approvals.ts:475:13
❯ transaction src/services/admin/approvals.ts:79:20
❯ Module.executeAdminApprovalRequest src/services/admin/approvals.ts:446:20
Serialized Error: { code: 'NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN', status: 400, options: {} }
Tests  1 failed | 1 passed | 52 skipped (54)
```

两轮栈均明确经过 `assertImmutableSafeContent` → `enqueueTransactionalSecurityNotification` → 对应 enqueue
调用点，证明各用例独立杀死各自调用点的变异，不是由源码文本、编译或环境错误杀死。恢复两处安全正文后，同一
隔离库、同一命令 2/2 通过。

## 验证记录

- 首次尝试复用 `.env.local` 数据库时，测试在 suite setup 以
  `ADMIN_APPROVAL_POLICY_UNAVAILABLE` 停止，没有执行用例，也没有修改共享数据库。随后创建精确命名的一次性
  fixture 库；首次迁移又因未注入测试用 `REALNAME_DOCUMENT_MASTER_KEYS` 在应用启动前停止。补入 32-byte
  fixture key 后，迁移和用例才开始执行。这两次均为环境前置失败，不计作代码通过。
- 补测恢复态 2/2 通过；提交与执行两处分别回插 UUID 后，各自都精确为对应 1 条失败、另一条通过，并以
  `NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN` 杀死；恢复两处后再次 2/2 通过。补测前已通过的 D9-B-5
  单元 8/8、RBAC 冻结目录 55/55 与完整集成 53/53 证据保持有效；本轮新增后集成文件总数为 54 条。
- 最终代码状态在一次性数据库、Homebrew OpenSSL 3、全部真实微信支付/退款/西部数码/provider 写闸显式
  `false` 下完整运行一次 `make check`，退出 0：115 文件 838/838 单元、43 文件 711/711 主集成、1 文件
  37/37 wallet-ledger 集成（集成合计 748/748），以及生成物/schema drift、全部 migration 往返、Nginx、运维、
  rebuild/release、lint、TypeScript strict、Next.js 宿主构建、linux/amd64 同镜像、依赖审计、工作树与完整 230
  commits Gitleaks、Trivy 全部通过。构建改写的 `next-env.d.ts` 已恢复。
- `apps/web/src/security/sanitize-sensitive-data.ts` 保持零 diff；修复没有放宽任何敏感扫描规则。
