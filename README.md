# Wanmi.AI

Wanmi.AI P1 的 D0 条件通过工程基线：Next.js 16.2.11、Payload 3.86.0、PostgreSQL 16.14、Payload Jobs、Who-Dat 2.0.0，以及彼此隔离的公共和私有对象存储原型。

当前代码只实现架构与安全原型，尚不包含 D1 页面或完整交易功能。项目负责人已批准进入 D1；共享 ECS 的运行环境门槛转入 D7。所有外部写能力默认使用 mock；`ALLOW_REAL_PROVIDER_WRITES=false` 是本地和 CI 默认值。

## 本地要求

- Node.js 24.18.0
- pnpm 11.7.0（通过 Corepack）
- Docker Desktop / Docker Compose
- GNU Make

本项目将 PostgreSQL 暴露在 `127.0.0.1:55432`，避免占用常见的 5432；Who-Dat 使用 8080，MinIO 使用 9000/9001。

## 首次启动

```bash
make bootstrap
pnpm --filter @wanmi/web migrate
make dev
```

`make bootstrap` 只会在文件不存在时创建 `apps/web/.env.local`，并为本地 Payload、Session 与 TOTP 生成随机值；不会写入生产凭据。Web 启动后检查：

```bash
curl -fsS http://127.0.0.1:3100/healthz
curl -fsS http://127.0.0.1:3100/readyz
```

另开终端启动同一代码和镜像的独立 Worker：

```bash
make worker
```

Admin 位于 `/admin`。管理员必须由受控引导流程建立并启用 TOTP；D0 不提供默认账号或密码。首次引导只允许在管理员表为空时执行，账号与密码通过临时环境变量传入：

```bash
WANMI_BOOTSTRAP_ADMIN_EMAIL='admin@example.invalid' \
WANMI_BOOTSTRAP_ADMIN_PASSWORD='use-a-local-secret-manager' \
pnpm --filter @wanmi/web admin:bootstrap
```

命令只显示一次 TOTP URI 和恢复码；不得把输出写入仓库或普通日志。

## 稳定命令

| 命令                    | 说明                                   |
| ----------------------- | -------------------------------------- |
| `make bootstrap`        | 安装锁定依赖并创建本地配置             |
| `make dev`              | 启动 PostgreSQL、Who-Dat、MinIO 和 Web |
| `make worker`           | 启动独立 Payload Jobs Worker           |
| `make generate`         | 生成 Payload 类型和 Admin import map   |
| `make verify-generated` | 阻断类型、import map 与迁移漂移        |
| `make lint`             | ESLint 与 TypeScript strict 检查       |
| `make test`             | Vitest 单元测试                        |
| `make test-integration` | PostgreSQL、Jobs、OTP 和存储集成测试   |
| `make test-e2e`         | Playwright 核心冒烟                    |
| `make security`         | 依赖和秘密扫描                         |
| `make build`            | Next.js 生产构建及同镜像容器构建       |
| `make smoke`            | 对已启动 Web 执行健康冒烟              |
| `make verify-oss-real`  | 受控验证真实 OSS 的两条存储路径        |
| `make check`            | D0 本地合并门槛                        |

## 数据库变更

Payload 是唯一 Schema 所有者，所有环境均为 `push: false`：

```bash
pnpm --filter @wanmi/web migrate:create descriptive_name
make generate
make verify-generated
pnpm --filter @wanmi/web migrate
```

迁移和 `src/payload-types.ts` 必须一起提交，不得手改生成类型。升级路径和空库路径见 [验证 Runbook](docs/operations/d0-verification.md)。

## 真实云验证

真实 OSS 验证只允许使用项目负责人批准的专用 D0 Bucket/前缀。凭据不得写入 `.env.local`、命令历史、日志或仓库，必须通过本地受控会话或 Secret Manager 临时注入：

```bash
make verify-oss-real
```

验证命令覆盖公共 S3 兼容路径与私有 `ali-oss` 路径的上传、读取、ETag、60 秒签名地址和删除，并隐藏资源标识；对象清理失败时命令会失败。真实 RDS migration 只能在隔离 D0 数据库执行。

## 安全边界

- 浏览器业务写入仅通过 `/api/v1`；Payload Admin 和官方表单插件按其明确边界运行。
- 代表用户调用 Local API 必须使用 `findAsUser`，它固定 `overrideAccess: false`。
- commerce Job 的唯一键是 provider operation key；已提交或未知状态不会自动重提。
- 公共 Media 使用 Storage S3；实名文件使用独立 `ali-oss` adapter 和 KMS 数据密钥。
- 当前云授权只覆盖专用 D0 OSS/RDS 隔离验证与 ECS 只读盘点；不允许在承载现有项目的 ECS 上部署、压测、重启或重建，也不允许发送真实短信、执行资金或域名写操作。

更多说明见 [ADR 目录](docs/adr) 和 [运维目录](docs/operations)。
