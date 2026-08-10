# 实名停用、清理与人工复核运行手册

## 停用与 30 天起点

- 用户删除模板时，服务在同一次状态迁移中写入 `status=disabled`、`disabledAt` 和 `cleanupDueAt`；`cleanupDueAt` 固定等于 `disabledAt + 30 × 24 小时`。
- 用户申请账号注销时，账号状态、Session 撤销和该账号全部实名模板停用共用同一数据库事务。任一步失败则整体回滚。
- `realname.template.status_changed` 审计保存停用原因、`disabledAt` 和 `cleanupDueAt`。已停用模板不能通过注册前门禁。

## background 清理

`realnameCleanup` 每小时第 15 分钟运行，使用全局排他 concurrency key。它只处理已停用、已到期且没有 `cleanupCompletedAt` 的模板：

1. 删除证件主 OSS 对象并记录逐对象完成时间；
2. 删除所有备份对象引用指向的 OSS 对象，并逐项记录完成时间；
3. 在数据库事务中删除证件行；
4. 无订单引用时删除模板行；已有历史订单引用时，为保留订单外键只留下 `disabled` 的去标识化骨架，清空 provider 标识并写入 `cleanupCompletedAt`；
5. 写入唯一的 `realname.template.cleaned` 审计。

对象删除失败、数据库事务失败或 Worker 中断时保留进度，下一次调度只继续未完成对象。完成后模板已删除或带 `cleanupCompletedAt`，重复 Job 不再发起对象删除或重复审计。日志不得包含对象键、证件内容、密钥、手机号或证件号码。

## 失败处理

- OSS 删除失败：保持停用并等待下一次小时任务；不得把文件标记为已清理。
- 引用缺失或格式损坏：任务 fail-closed，保留数据库记录并告警人工处理。
- 对象引用的应用主密钥版本缺失：禁止回退 active key；按 `docs/operations/realname-master-key.md` 恢复同版本密钥，永久丢失时将对象判定不可恢复并保留审计结论。
- 历史订单外键存在：不得删除或修改订单；按上述去标识化路径保留最小模板骨架。
- 生产清理依赖 `ALLOW_REAL_PROVIDER_WRITES=true` 和经批准的私有 OSS 最小权限。未获生产授权时不得开启真实写操作。

## 实名审核与人工复核

- 西部数码明确拒绝映射为 `rejected`；不可用、异常或未知状态映射为 `manual_review + unknown`，绝不映射为 `approved`。
- `rejected` 模板可由本人修改完整资料，状态回到 `draft`，清除旧 provider 结果后重新提交。
- 进入 `manual_review` 时创建唯一 open 人工复核记录。只有完成密码与 TOTP Session 的 `system_admin` 可调用人工复核端点。
- 人工复核只能依据 `provider_query`、`provider_console` 或 `written_confirmation` 外部证据退出，必须同时提供观察时间、证据引用和处理备注。缺少任一字段均拒绝。
- 可确认的出口是 `approved`、`rejected` 或 `pending_review`；通过出口还必须具有 provider 模板标识。复核记录和状态审计同时提交，不能只改模板状态。
