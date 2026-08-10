# D0 启动 Runbook

## 本地

1. 确认 Node 24.18.0、pnpm 11.7.0、Docker 和 Make 可用。
2. 执行 `make bootstrap`；检查 `apps/web/.env.local` 权限，不输出其内容。
3. 执行 `docker compose up -d postgres whodat minio minio-init`，等待必需服务 healthy。
4. 执行 `pnpm --filter @wanmi/web migrate`。
5. 执行 `pnpm dev`，验证 `/healthz` 返回进程存活。
6. 验证 `/readyz` 中 database 为 healthy；Who-Dat 是单列的可选依赖。
7. 另开终端执行 `make worker`。commerce 从单并发处理，另两个队列由相同 Worker 轮询。

## Canonical 主机与 Nginx 301

提交的 `deploy/nginx/wanmi-host-redirects.conf` 只负责别名主机和 canonical HTTP 的永久跳转，不包含应用 `proxy_pass`：

- `wanmi.net` 的 HTTP；
- `wanmi.ai`、`www.wanmi.ai`、`www.wanmi.net` 的 HTTP 与 HTTPS；
- 所有入口都以 `301 https://wanmi.net$request_uri` 保留路径和查询参数。

部署前必须确认 `/etc/nginx/tls/wanmi/fullchain.pem` 与 `/etc/nginx/tls/wanmi/privkey.pem` 已由受控证书流程挂载，证书 SAN 同时覆盖 `wanmi.ai`、`www.wanmi.ai` 和 `www.wanmi.net`。canonical `wanmi.net` HTTPS 应用虚拟主机由部署配置单独维护，不得复制到别名主机，也不得让别名请求进入 Next.js/Payload。

本地/CI 只执行配置验证，不部署或修改服务器：

```bash
make verify-nginx
```

该命令使用固定的 `nginx:1.30.4-alpine-slim@sha256:ddde39c6e51f02fde7410c2e9c234cf2d0a4c7bdbbe176aeb37d8ad7ab4eb58c`、一次性测试证书和随机本地端口运行 `nginx -t`，再验证 4 个 HTTP 与 3 个 HTTPS 别名请求的 301、路径和查询参数。项目负责人已于 2026-08-10 确认目标 ECS 上的原有项目迁出，但生产部署仍需单独明确授权；D7-07 只在本地隔离容器执行，不复制配置到 ECS、不申请证书、不 reload Nginx、不切换流量。

## 故障判断

- `healthz` 失败：Web 进程或入口故障。
- `healthz` 成功但 `readyz` 失败：优先检查数据库连接和迁移，不把可选 provider 故障伪装成数据库故障。
- Worker 未处理：先查 `payload-jobs` 的 queue、processing、hasError 和 concurrencyKey，再查 provider operation；不得直接重提未知 provider 写请求。
- 本机 5432 已占用不是异常；Wanmi Compose 固定使用 55432，禁止停止其他项目容器来让路。
- 别名返回非 301 或进入应用：先检查生效的 `server_name`、证书 SAN 和配置加载顺序；不要用应用级重定向掩盖 Nginx 配置冲突。
