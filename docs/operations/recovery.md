# 恢复 Runbook

## 真实环境开工门禁

在任何 ECS 重启/重置、commerce Job 强制中断、RDS PITR、OSS 误删或主密钥轮换前，必须先用只读证据同时确认：

1. 工具链 PR 已审核合并，受控入口精确指向获授权的 2 vCPU/4 GiB 专用 ECS，机内没有其他业务负载；
2. RDS 启用 SSL、只经 VPC 内网连接，自动数据/日志备份存在，且只读 API 返回包含目标时间点的 PITR 可恢复窗口；
3. 专用私有 OSS Bucket 的版本控制为 `Enabled`，删除后非当前版本至少保留 30 天；
4. 完整应用主密钥 key ring 在受控环境生成，已注入 Web/Worker 的受控 secret，且离线备份与保管记录可复核；只记录版本名和校验结论，不记录 key 值；
5. 应用/RDS/OSS 凭据轮换已留下可复核记录，演练资源边界精确，`ALLOW_REAL_PROVIDER_WRITES` 与全部 provider 写能力闸均为 `false`。

任一项失败或无法确认时，立即停止变更性演练，将实测字段、错误码、时间戳和结论写入当次验证记录，对应计划项保持未勾选。不得用手工导出代替 PITR，不得用无版本 Bucket 或 fixture 代替 OSS 误删恢复，不得从开发机复制主密钥。凭据一旦出现在聊天、文档、命令行或日志中，必须视为已暴露，撤销旧值并完成新一轮受控注入后才能重开。2026-08-10 首次 D7-08 预检的阻塞证据见 `docs/operations/d7-08-ecs-recovery-validation.md`。

## Web/Worker 独立重启

1. 记录镜像版本、迁移状态、失败 Job ID 和 trace ID。
2. 仅重启目标进程；不要同时清空 Job 状态或 provider operation。
3. Web 重启后检查 healthz/readyz；Worker 重启后以 `commerce` limit 1 恢复。
4. 对 `prepared` operation 可按幂等键恢复；`submitted`/`unknown` 只做 provider 查询并进入人工复核，禁止自动重提。

## 节点重建

1. 从受控环境恢复数据库、OSS、完整的实名应用主密钥 key ring 和 provider 配置引用，不复制旧 ECS 临时文件；主密钥步骤遵循 `docs/operations/realname-master-key.md`。
2. 准备 release manifest 和网络后执行 `make rebuild`。该入口严格按 digest 拉取同一应用镜像，依次运行 Payload migrations、Web、readyz、commerce 单并发 Worker、未完成 Job 恢复和 Nginx；不要用本段文字手工拼出另一套顺序。
3. readyz 未通过时命令以 18 退出且不会启动 Worker；先修复数据库/迁移/readiness，重新从确定状态执行，不要跳过门禁。
4. 重放支付通知前先以交易号和商户订单号唯一约束去重。
5. 对每个恢复的 commerce Job 核对 order、orderEvents 与 providerOperations 三者一致性。

## 数据库恢复验证

空库路径使用全新数据库执行全部迁移；升级路径从批准快照复制到隔离数据库再执行迁移。不得在生产直接用 `migrate:fresh`、`push` 或运行时同步 Schema。

## commerce Worker 强制中断

1. 先确认旧 Worker 已停止且不会继续更新同一 Job，记录 Job、order、provider operation、trace ID 和中断时间。
2. 只查询未完成的 `commerce` Job 与对应 operation 状态；不得因进程退出就假定 provider 请求未发出。
3. `apps/web/scripts/recover-commerce-jobs.ts` 要求显式确认值和 ISO 截止时间。它先用 Payload Jobs Collection 查询未完成项，再在同一 PostgreSQL 事务内执行一条带 `queue='commerce'`、`processing IS TRUE`、`completed_at IS NULL`、`has_error IS NOT TRUE` 和 `updated_at <= 截止时间` 的 `UPDATE ... RETURNING`，只释放已确认旧执行者停止的过期 processing lock，并逐 Job 写审计；并发运行时只有一个恢复者取得该行。不得用 `payload.update({ where })` 冒充 CAS，也不得删除截止时间或队列范围。
4. 释放 Payload processing lock 不等于授权重复 provider 写。恢复后的既有 commerce handler 继续依据 provider operation 唯一键运行：`prepared` 仅在既有安全条件下提交；`submitted` 只查询 provider；`unknown` 只查询或转入 `manual_review`，注册、续费、退款和 NS 均禁止自动重提。恢复工具本身不包含新的履约或 provider 重试逻辑。
5. 恢复后核对追加式 orderEvents、operation 唯一键、write claim 审计和订单状态，并记录审计。生产环境不得用无范围的批量 SQL 直接清除 Job 状态。

D0 在隔离 RDS 中验证过一次隧道中断后的 processing lock 恢复，并将未完成测试 fixture 安全取消。2026-08-10 的 D7-07 本地受限容器演练用 60 秒异步 fixture 在 provider write claim 后保持 Promise 未完成，确认 Web 重启不影响 Worker 后对 Worker 发送 `SIGKILL`；重启后两个并发恢复者只恢复一行，既有 Payload handler 查询并完成，write claim/提交/成功均恰好一次。该证据见 `docs/operations/d7-07-local-rebuild-validation.md`，不替代 ECS 与 RDS 同 VPC 的真实环境门槛。
