# D0 恢复 Runbook

## Web/Worker 独立重启

1. 记录镜像版本、迁移状态、失败 Job ID 和 trace ID。
2. 仅重启目标进程；不要同时清空 Job 状态或 provider operation。
3. Web 重启后检查 healthz/readyz；Worker 重启后以 `commerce` limit 1 恢复。
4. 对 `prepared` operation 可按幂等键恢复；`submitted`/`unknown` 只做 provider 查询并进入人工复核，禁止自动重提。

## 节点重建

1. 从受控环境恢复数据库、OSS、完整的实名应用主密钥 key ring 和 provider 配置引用，不复制旧 ECS 临时文件；主密钥步骤遵循 `docs/operations/realname-master-key.md`。
2. 拉取同一不可变镜像，执行 `payload migrate:status` 和 `payload migrate`。
3. 先启动 Web，确认 readyz，再启动 Worker，最后恢复流量。
4. 重放支付通知前先以交易号和商户订单号唯一约束去重。
5. 对每个恢复的 commerce Job 核对 order、orderEvents 与 providerOperations 三者一致性。

## 数据库恢复验证

空库路径使用全新数据库执行全部迁移；升级路径从批准快照复制到隔离数据库再执行迁移。不得在生产直接用 `migrate:fresh`、`push` 或运行时同步 Schema。

## commerce Worker 强制中断

1. 先确认旧 Worker 已停止且不会继续更新同一 Job，记录 Job、order、provider operation、trace ID 和中断时间。
2. 只查询未完成的 `commerce` Job 与对应 operation 状态；不得因进程退出就假定 provider 请求未发出。
3. 只有具备明确过期证据且 operation 仍为 `prepared` 时，才可在批准的恢复流程中释放 processing lock 并恢复执行；`submitted` 或 `unknown` 只能查询 provider 或转入 `manual_review`，禁止重提。
4. 恢复后核对追加式 orderEvents、operation 唯一键和订单状态，并记录审计。生产环境不得用无范围的批量 SQL 直接清除 Job 状态。

D0 在隔离 RDS 中验证过一次隧道中断后的 processing lock 恢复，并将未完成测试 fixture 安全取消；ECS 与 RDS 同 VPC 下的 Worker 中断恢复经项目负责人批准转入 D7，完成前继续阻塞开发整体验收和生产上线。
