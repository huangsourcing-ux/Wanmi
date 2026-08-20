# Wanmi.AI

Wanmi.AI P1 的 D0 条件通过工程基线与 D1 公共站基础：Next.js 16.2.11、Payload 3.86.0、PostgreSQL 16.14、Payload Jobs、Who-Dat 2.0.0，以及彼此隔离的公共和私有对象存储原型。

当前代码已实现 D1-01 的 Wanmi.net 响应式站点外壳、D1-02 的通用状态与错误契约、D1-03 的 canonical/robots/sitemap/SEO 基础，以及 D1-04 的受控站内 301 与 Wanmi.ai/www 主机跳转配置；域名查询仍是明确标记的功能骨架，不调用真实 provider。项目负责人已批准进入 D1；共享 ECS 的运行环境门槛转入 D7。所有外部写能力默认使用 mock；`ALLOW_REAL_PROVIDER_WRITES=false` 是本地和 CI 默认值。

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

`make bootstrap` 只会在文件不存在时创建 `apps/web/.env.local`，并为本地 Payload、Session、TOTP 与实名证件应用主密钥生成随机值；不会写入生产凭据。Web 启动后检查：

```bash
curl -fsS http://127.0.0.1:3100/healthz
curl -fsS http://127.0.0.1:3100/readyz
```

公共站首页位于 `/`。D1-01 还提供 `/tools`、`/pricing`、`/articles`、`/topics`、`/help` 和 `/legal` 等可达入口；首页查询使用 `GET /tools/domain-search?q=<完整域名或关键词>`，带查询参数的页面默认 `noindex, nofollow`，且当前不会保存输入或请求真实查询服务。

公共页面以 `NEXT_PUBLIC_SERVER_URL` 的 origin 生成绝对 canonical 和 Open Graph URL；生产环境必须配置为 `https://wanmi.net`。`/robots.txt` 屏蔽后台、API、账号和健康检查路径，`/sitemap.xml` 只列出当前真实可访问的稳定入口，`/opengraph-image` 提供 1200×630 品牌分享图。文章、专题和 TLD 详情页及动态 sitemap 留在 D3，不提前输出可索引的 404。

首页导航和内容栏目通过 Payload Local API 读取，所有公开读取显式启用 access control。只有已发布的文章、TLD 页面和专题可见；空库或任一栏目失败时页面使用安全回退，主查询入口保持可用。

Payload 官方 SEO 插件为文章、专题和 TLD 页面提供共享 `WanmiSeoMeta`：标题、描述、图片、同源 canonical 与 `noIndex`。自定义 canonical 只接受站内路径或当前 Wanmi 主域 URL；草稿 SEO 数据继续受发布态 access control 隔离。

Payload 官方 Redirects 插件只保存站内永久 301 规则。规则起点和自定义目标会规范化为无查询、无片段的站内路径；后台、API、健康检查、外部 URL、草稿引用、循环和超过 10 跳的链路均被拒绝。只有内容编辑和系统管理员可创建或更新，只有系统管理员可删除；每次变更都在同一 Payload 请求/事务中写入脱敏审计。公共 GET/HEAD 通过 `proxy.ts` 读取规则并折叠到最终目标，保留原查询参数和请求 ID；每进程缓存 30 秒，刷新失败使用最后一次合法缓存，冷启动失败则安全放行。

`deploy/nginx/wanmi-host-redirects.conf` 将 Wanmi.ai 与 www 别名的 HTTP/HTTPS、以及 `wanmi.net` 的 HTTP 请求保留 `$request_uri` 跳转到 `https://wanmi.net`。别名虚拟主机没有 `proxy_pass`。生产证书必须同时覆盖 `wanmi.ai`、`www.wanmi.ai` 和 `www.wanmi.net`；配置验证与部署步骤见 [启动 Runbook](docs/operations/startup.md)。

自定义 API 错误使用兼容 RFC 9457 的 `application/problem+json`，保留 `code`、`message` 和 `traceId`，并提供稳定标题、HTTP 状态、可重试标记和建议动作；成功响应 body 不变。公共页面的错误与降级状态显示同一请求 ID，不显示原始异常、堆栈或 provider 响应。文章、专题和价格栏目使用局部 Loading 边界，避免动态未找到页面因根级流式响应丢失真实 404 状态。

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

| 命令                     | 说明                                          |
| ------------------------ | --------------------------------------------- |
| `make bootstrap`         | 安装锁定依赖并创建本地配置                    |
| `make dev`               | 启动 PostgreSQL、Who-Dat、MinIO 和 Web        |
| `make worker`            | 启动独立 Payload Jobs Worker                  |
| `make generate`          | 生成 Payload 类型和 Admin import map          |
| `make verify-generated`  | 阻断类型、import map 与迁移漂移               |
| `make verify-migrations` | 验证空库迁移和遗留 302 升级路径               |
| `make verify-nginx`      | 验证固定镜像中的主机 301 配置                 |
| `make lint`              | ESLint 与 TypeScript strict 检查              |
| `make test`              | Vitest 单元测试                               |
| `make test-integration`  | PostgreSQL、Jobs、OTP 和存储集成测试          |
| `make test-e2e`          | 生产构建上的 43 条 Playwright 全链路回归      |
| `make performance`       | 本地接口负载与三页 Lighthouse 性能门槛        |
| `make security`          | 依赖和秘密扫描                                |
| `make build`             | Next.js 生产构建及同镜像容器构建              |
| `make smoke`             | 对已启动 Web 执行健康冒烟；命令本身不启动 Web |
| `make verify-oss-real`   | 受控验证真实 OSS 的两条存储路径               |
| `make check`             | 本地合并门槛                                  |

## 数据库变更

Payload 是唯一 Schema 所有者，所有环境均为 `push: false`：

```bash
pnpm --filter @wanmi/web migrate:create descriptive_name
make generate
make verify-generated
pnpm --filter @wanmi/web migrate
```

迁移和 `src/payload-types.ts` 必须一起提交，不得手改生成类型。升级路径和空库路径见 [验证 Runbook](docs/operations/d0-verification.md)。

D1-04 可重复迁移验证使用一次性本地数据库，确认空库完整迁移，并模拟 D1-03 schema 中遗留 `302` 规则升级为 `301` 后再收窄 enum：

```bash
make verify-migrations
```

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
- 公共 Media 使用 Storage S3；实名文件使用独立 `ali-oss` adapter、每对象数据密钥和版本化应用主密钥信封加密。
- 当前云授权只覆盖专用 D0 OSS/RDS 隔离验证与 ECS 只读盘点；不允许在承载现有项目的 ECS 上部署、压测、重启或重建，也不允许发送真实短信、执行资金或域名写操作。

更多说明见 [ADR 目录](docs/adr) 和 [运维目录](docs/operations)。
