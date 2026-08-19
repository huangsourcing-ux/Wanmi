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

## 确定性回归与变异

集成用例
`keeps a phone-like internal request UUID out of notification text and commits execution` 将已创建审批的
`requestKey` 精确改为 `00000000-0000-4000-8000-13012345678a`。其中 `13012345678` 必然命中既有
`chineseMobile` 正则。恢复实现必须同时满足：

- 高风险操作执行成功且持久化为 `executed`；
- 领域执行 effect 恰好一次；
- 执行通知恰好一条，`eventKey` 仍包含完整内部 UUID；
- `bodySnapshot` / `subjectSnapshot` 不含 UUID 或手机号样式片段；
- 执行访问事件恰好一条。

变异只把旧的 `记录号：${claimed.approval.requestKey}` 重新插回执行正文，并只运行上述用例。进程退出 1，
原始承重报错为：

```text
AssertionError: promise rejected "AppError: 通知正文不得包含完整手机号、证件或凭据 { …(3) }" instead of resolving
Caused by: AppError: 通知正文不得包含完整手机号、证件或凭据
Serialized Error: { code: 'NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN', status: 400, options: {} }
```

栈明确经过 `assertImmutableSafeContent` → `enqueueTransactionalSecurityNotification` →
`executeAdminApprovalRequest`，证明测试不是由源码文本、编译或环境错误杀死。恢复安全正文后，同一隔离库、同一
测试命令再次 1/1 通过。

## 验证记录

- 首次尝试复用 `.env.local` 数据库时，测试在 suite setup 以
  `ADMIN_APPROVAL_POLICY_UNAVAILABLE` 停止，没有执行用例，也没有修改共享数据库。随后创建精确命名的一次性
  fixture 库；首次迁移又因未注入测试用 `REALNAME_DOCUMENT_MASTER_KEYS` 在应用启动前停止。补入 32-byte
  fixture key 后，迁移和用例才开始执行。这两次均为环境前置失败，不计作代码通过。
- 恢复态的确定性回归先 1/1 通过；回插 UUID 的单点变异以
  `NOTIFICATION_SENSITIVE_CONTENT_FORBIDDEN` 失败；恢复代码后同一用例再次 1/1 通过。D9-B-5 单元 8/8、RBAC
  冻结目录 55/55，合计 63/63；完整 D9-B-5 集成文件 53/53。
- 最终代码状态在一次性数据库、Homebrew OpenSSL 3、全部真实微信支付/退款/西部数码/provider 写闸显式
  `false` 下完整运行一次 `make check`，退出 0：115 文件 838/838 单元、43 文件 710/710 主集成、1 文件
  37/37 wallet-ledger 集成（集成合计 747/747），以及生成物/schema drift、全部 migration 往返、Nginx、运维、
  rebuild/release、lint、TypeScript strict、Next.js 宿主构建、linux/amd64 同镜像、依赖审计、工作树与完整 229
  commits Gitleaks、Trivy 全部通过。构建改写的 `next-env.d.ts` 已恢复。
- `apps/web/src/security/sanitize-sensitive-data.ts` 保持零 diff；修复没有放宽任何敏感扫描规则。
