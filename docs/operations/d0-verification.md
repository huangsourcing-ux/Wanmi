# D0 验证 Runbook 与证据

日期：2026-08-03；云资源验证更新：2026-08-04

## 已验证（本地）

- Node 24.18.0、pnpm 11.7.0、Next.js 16.2.11、Payload 与全部 `@payloadcms/*` 3.86.0 精确锁定。
- PostgreSQL 16.14、Who-Dat 2.0.0、MinIO 使用固定 tag 和 digest；服务健康。
- `push: false`，初始 migration 和生成类型已建立；空库迁移成功。
- SEO、Redirects、Form Builder 启动并进入生成 Schema；重定向拒绝开放跳转/循环，表单拒绝 payment/upload。
- OTP 一次性消费、opaque Session、Custom Strategy、全会话撤销通过 PostgreSQL 集成测试。
- commerce 重复 workflow 使用相同 concurrency key，只产生一个 provider operation 和两条追加事件；资产在 succeeded 前建立。
- Storage S3 在 MinIO 完成上传、读取、短时签名、ETag 和删除；私有存储/KMS mock 完成隔离原型。
- Local API 包装器回归测试固定 `overrideAccess: false`。
- ESLint、TypeScript strict、25 个 Vitest 单元测试、5 个 PostgreSQL/MinIO 集成测试、2 个 Playwright 场景和 Next.js 生产构建通过。
- 独立 Worker 已连接 PostgreSQL 并以三个固定队列、全局 limit 1 成功启动；Gitleaks 使用固定镜像和配置执行。
- 将 Next.js/Payload 依赖树中的 Sharp、PostCSS 与 Undici 精确覆盖到已修复版本；Sharp 0.35.0 的类型导出缺陷通过版本锁定的 pnpm patch 修正，lint、类型检查和构建继续通过。
- 项目负责人于 2026-08-03 批准将 Next.js 安全基线从 16.2.6 更新到 16.2.11；`pnpm audit --prod --audit-level high` 通过（剩余 2 个 low、2 个 moderate，不触发 high 门禁）。
- `linux/amd64` 同一镜像以非 root `wanmi` 用户分别启动 Web 与 Worker；两者独立重启后 Web `/readyz` 和 Worker 进程均恢复。arm64 本机模拟运行采样为 Web 约 344 MiB、Worker 峰值约 586 MiB、Who-Dat 约 12 MiB，仅作为本地趋势证据，不替代 2 vCPU/4 GiB ECS 验证。

## 已验证（阿里云 D0 资源）

- 受控身份只读盘点确认上海地域存在 1 台运行中的 2 vCPU/4 GiB ECS 和 1 个运行中的 PostgreSQL RDS；资源标识、地址和凭据均未写入仓库。
- 在上海创建了专用 D0 私有 Bucket。`make verify-oss-real` 分别通过 S3 兼容路径和 `ali-oss` 路径的上传、读取、ETag、60 秒签名地址、删除及删除后不存在验证；D0 测试前缀已清空。
- Payload `@payloadcms/storage-s3` Media 集成测试也在真实 OSS 上通过上传、读取、ETag、签名地址和删除后校验，公共 Media 与私有实名对象继续使用独立 adapter 和前缀。
- RDS 实连版本为 PostgreSQL 16.10。现有业务数据库只做表数量与能力核对；migration 仅在新建的隔离 D0 数据库执行，初始 migration 首次成功、再次执行无变更。
- 真实 RDS 集成测试中的插件启动、OTP/Session 和真实 OSS Media 场景通过。commerce 长任务经本机到 ECS 的临时 SSH 隧道发生超时和断连，因此不作为云端 Jobs 通过证据；本地等价测试仍通过。
- 隧道中断留下的 1 个 processing lock 已按隔离数据库范围恢复；2 个未完成 D0 commerce fixture 已标记取消，最终 processing 与 runnable Job 均为 0。真实 provider 写请求始终关闭。

## 标准验证

```bash
make bootstrap
pnpm --filter @wanmi/web migrate
make generate
make lint
make test
make test-integration
make build
make check
make verify-oss-real
```

`make verify-oss-real` 只允许在项目负责人批准的专用测试 Bucket/前缀运行，凭据必须由本地受控会话或 Secret Manager 注入。命令输出隐藏 Bucket、对象键、地址和凭据；清理失败会返回非零状态。

启动 Web/Worker 后：

```bash
make smoke
curl -fsS http://127.0.0.1:8080/
docker compose ps
```

## Schema 漂移

`make verify-generated` 会重新生成 `payload-types.ts` 和 Admin import map，并用 Payload `migrate:create --skip-empty` 检查已提交 migration snapshot；生成文件变化或出现新的 migration 都会失败。Schema 变更必须先创建命名 migration，再重新生成。

## D0 剩余门槛与云安全发现

- 目标 2 vCPU/4 GiB ECS 仍运行其他项目。本次除临时加密端口转发外未触碰其容器、Nginx、端口、进程或流量；按项目负责人指令，Web/Worker/Who-Dat 压测、独立重启、空节点重建和两小时 RTO 演练延期到现有项目迁出后的部署阶段。
- commerce/Worker 必须在 ECS 与 RDS 同 VPC 的部署形态重新验证中断恢复和 provider 幂等。本机长时 SSH 隧道的超时/断连不能替代该证据。
- RDS 当前未启用 SSL 且存在公网连接入口。为避免影响现有项目，本次未修改实例网络或 SSL；生产使用前必须启用 SSL，并收敛为 VPC 内网和最小白名单。
- KMS 已按 D0 计划完成 SDK adapter、信封加密 mock 和最小权限边界；真实密钥验证属于后续实名功能和生产上线门槛，完成前真实实名文件不得投入使用。
- 上一条是 2026-08-04 的历史 D0 结论；2026-08-10 D7-06 已因账号 `AccountStatus=NotEnabled` 按负责人指示移除 KMS，当前基线改为版本化应用主密钥，见 ADR-0005 与 `docs/operations/realname-master-key.md`。
- 本轮通过对话提供的 AccessKey、ECS 管理密码和 RDS 密码必须全部轮换，后续改用 RAM 子账号/实例角色和受控 Secret；轮换前不得视为生产安全基线。
- Gitleaks 对所有 Git 可见文件扫描通过；未执行任何真实短信、资金或域名写请求。

项目负责人于 2026-08-04 批准 D0 条件通过并进入 D1。ECS 资源和同 VPC commerce/Worker 恢复门槛原样转入 D7，仍阻塞开发整体验收、真实收款和生产上线；现有项目迁出前不在共享 ECS 执行这些操作。
