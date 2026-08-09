# 发布与回滚 Runbook

## 不可变发布契约

仓库以 `deploy/release-policy.json` 和每次发布的 release manifest 作为门禁。示例 `deploy/release-manifest.example.json` 只包含无凭据的结构，不是生产发布授权。执行：

```bash
make verify-release
```

门禁要求当前镜像和回滚镜像都使用 `repository@sha256:<64 hex>`，拒绝仅有可变 tag 的引用；静态资源必须使用 `_next/static/<releaseId>/` 不可变前缀，并具有内容 manifest SHA-256。`uploadedAt <= verifiedAt < applicationPromotionNotBefore`，因此应用不能先切流再补静态资源。旧静态前缀至少保留到回滚窗口结束。

## 迁移兼容规则

`release-policy.json` 的 baseline 是上一批准 schema。baseline 之后每个 migration 都必须声明：

- `expand`：只加 schema，旧代码仍可运行，新代码在 migration 前也可运行；代码回滚时保留 migration；
- `data`：不改 schema，明确 retain/down；
- `contract`：只清理旧 schema，必须确认当前代码早已停止使用；代码回滚前必须 down。

门禁拒绝单个 migration 同时 add/drop schema、拒绝 rename column，并拒绝同一 release manifest 同时包含 expand 与 contract。发布顺序固定为“先加且兼容 → 后续版本开始使用 → 再后续版本清理”；不得在同一次发布中增加新列、让代码依赖它、同时删除旧列。

## 发布步骤

1. 在 CI 运行完整 `make check`；`make build` 会生成 Next.js 生产构建和 linux/amd64 同镜像。本步骤不推送 registry、不部署。
2. 由已批准的静态资源发布设施上传 `.next/static` 到 release-scoped immutable prefix，生成逐文件内容 manifest 和 SHA-256；上传后实际读回验证，再记录 `uploadedAt`/`verifiedAt`。仓库没有凭据或生产上传命令，取得部署授权前不得自行补写。
3. 将 linux/amd64 镜像推送到批准 registry，解析 registry 返回的 digest；release manifest 只写 digest 引用，不写 `latest` 或环境 tag 作为部署目标。
4. 若有 migration，先运行既有 Payload migration 流程并核对 status；每项必须已进入 compatibility policy。expand migration 可安全保留，contract migration 必须具备已验证 down。
5. 在 manifest 填入当前/上一镜像 digest、当前/上一静态 manifest、迁移列表和 rollback.database；运行 `make verify-release`。
6. 只有门禁通过且已取得生产部署授权，外部部署控制面才可在 `applicationPromotionNotBefore` 之后切换 Web/Worker 到同一 digest。检查 `/healthz`、`/readyz` 和 Worker 队列后再恢复流量。

## 回滚步骤

1. 停止继续切流，保留当前与上一静态前缀、镜像 digest、migration status、Job ID 和 trace ID。
2. 若 release 只有 expand 或可保留的 data migration，数据库不 down：直接把 Web/Worker 切回 manifest 中上一镜像 digest，并让页面引用上一静态前缀。旧代码必须仍能在扩展后的 schema 上运行。
3. 若 release 含 contract migration，先停止新代码写入，执行该 migration 已验证的 down，确认旧列/约束恢复后，才能切回旧镜像。不得先启动会依赖已删除列的旧代码。
4. 代码已回滚但 expand migration 已应用时，保留该 migration；不要为追求“版本号一致”删除兼容列。等后续批准版本再决定 contract 清理。
5. 恢复上一 digest 和静态前缀后检查 health/readiness、Payload migration status、`commerce` Job 与 provider operation；未知 provider 写请求按 `recovery.md` 只查询。

## 不可做

- 不部署 mutable tag，不让 Web 与 Worker 使用不同 digest；
- 不覆盖旧静态前缀，不在回滚窗口内清理上一版本资源；
- 不使用 `push`、`migrate:fresh` 或运行时 schema 同步；
- 不把 contract migration 留在数据库后直接启动依赖已删除列的旧代码；
- 不把本 Runbook 视为生产部署、OSS、registry 或数据库变更授权。
