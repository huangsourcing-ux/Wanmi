# ADR-0006：单 ECS 可重建策略

- 状态：设计已采用，本地受限容器等价验证完成，真实 ECS 待验证
- 日期：2026-08-03

## 决策

首发单 ECS 运行 Nginx、Web、独立 Worker 和 Who-Dat。Web/Worker 来自完全相同的镜像；数据库、对象和任务状态全部在 RDS/OSS，不把 ECS 文件系统作为唯一数据源。

重建顺序为：准备环境变量与网络 → 按 digest 拉取同一镜像 → 运行 Payload migrations → 启动 Web → 验证 readyz → 启动 commerce 单并发 Worker → 查询并恢复未完成 Job → 启动 Nginx。目标 RTO 为两小时。该顺序由 `scripts/rebuild-plan.mjs` 固定，`make rebuild` 执行；发布引用仍由 `deploy/release-policy.json` 与既有 `verify-release` 校验，不存在第二套镜像校验规则。

## 验证状态

2026-08-10 已使用同一个 `linux/amd64` 应用镜像，在每个常驻容器 `--cpus=2 --memory=4g` 的本地隔离 Docker daemon 中完成工具链、内存、日志轮转、Web/Worker 独立重启、真实强杀时序下的 commerce Job 恰好恢复一次及空节点重建计时。实测证据见 `docs/operations/d7-07-local-rebuild-validation.md`。这只证明工具链和容器受限技术路径，不满足计划所要求的“2 vCPU/4 GiB 生产 Linux 环境”或“ECS 与 RDS 同 VPC”证据。

项目负责人于 2026-08-10 确认原有项目已经迁出，目标 ECS 已成为可重置或重装的专用机器，因此“现有项目迁出前不得在共享 ECS 执行”的外部阻塞已经解除。D7-07 仍明确不访问该 ECS、真实 RDS 或生产 OSS；下一个获得真实环境执行授权的切片必须在目标 ECS 上机械重跑内存、轮转、独立重启、同 VPC 强杀恢复和完整 RTO，并在完成前继续阻塞相关计划勾选与生产上线。

本地容器验证产物固定为 `linux/amd64`。取得 ECS 授权后必须先核对实例 CPU 架构；若为 ARM64，使用同一 Dockerfile 生成并验证对应平台或多架构 manifest，不得在未运行验证的架构上直接上线。
