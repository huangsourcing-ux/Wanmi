# D0 启动 Runbook

## 本地

1. 确认 Node 24.18.0、pnpm 11.7.0、Docker 和 Make 可用。
2. 执行 `make bootstrap`；检查 `apps/web/.env.local` 权限，不输出其内容。
3. 执行 `docker compose up -d postgres whodat minio minio-init`，等待必需服务 healthy。
4. 执行 `pnpm --filter @wanmi/web migrate`。
5. 执行 `pnpm dev`，验证 `/healthz` 返回进程存活。
6. 验证 `/readyz` 中 database 为 healthy；Who-Dat 是单列的可选依赖。
7. 另开终端执行 `make worker`。commerce 从单并发处理，另两个队列由相同 Worker 轮询。

## 故障判断

- `healthz` 失败：Web 进程或入口故障。
- `healthz` 成功但 `readyz` 失败：优先检查数据库连接和迁移，不把可选 provider 故障伪装成数据库故障。
- Worker 未处理：先查 `payload-jobs` 的 queue、processing、hasError 和 concurrencyKey，再查 provider operation；不得直接重提未知 provider 写请求。
- 本机 5432 已占用不是异常；Wanmi Compose 固定使用 55432，禁止停止其他项目容器来让路。
