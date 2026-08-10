# ADR-0006：单 ECS 可重建策略

- 状态：设计已采用，本地受限容器等价验证完成；D7-08 真实 ECS 预检阻塞，未开始实机验证
- 日期：2026-08-03

## 决策

首发单 ECS 运行 Nginx、Web、独立 Worker 和 Who-Dat。Web/Worker 来自完全相同的镜像；数据库、对象和任务状态全部在 RDS/OSS，不把 ECS 文件系统作为唯一数据源。

重建顺序为：准备环境变量与网络 → 按 digest 拉取同一镜像 → 运行 Payload migrations → 启动 Web → 验证 readyz → 启动 commerce 单并发 Worker → 查询并恢复未完成 Job → 启动 Nginx。目标 RTO 为两小时。该顺序由 `scripts/rebuild-plan.mjs` 固定，`make rebuild` 执行；发布引用仍由 `deploy/release-policy.json` 与既有 `verify-release` 校验，不存在第二套镜像校验规则。

## 验证状态

2026-08-10 已使用同一个 `linux/amd64` 应用镜像，在每个常驻容器 `--cpus=2 --memory=4g` 的本地隔离 Docker daemon 中完成工具链、内存、日志轮转、Web/Worker 独立重启、真实强杀时序下的 commerce Job 恰好恢复一次及空节点重建计时。实测证据见 `docs/operations/d7-07-local-rebuild-validation.md`。这只证明工具链和容器受限技术路径，不满足计划所要求的“2 vCPU/4 GiB 生产 Linux 环境”或“ECS 与 RDS 同 VPC”证据。

项目负责人于 2026-08-10 确认原有项目已经迁出，目标 ECS 已成为可重置或重装的专用机器，因此“现有项目迁出前不得在共享 ECS 执行”的外部阻塞已经解除。D7-07 仍明确不访问该 ECS、真实 RDS 或生产 OSS；下一个获得真实环境执行授权的切片必须在目标 ECS 上机械重跑内存、轮转、独立重启、同 VPC 强杀恢复和完整 RTO，并在完成前继续阻塞相关计划勾选与生产上线。

2026-08-10 的 D7-08 首次开工前预检已取得真实云侧结论，但未进入节点实测：阿里云 API 确认目标实例规格为 2 vCPU/4 GiB，但当前 SSH 目标与该实例不匹配，因此不能证明空载、架构、磁盘或完整重置起点。同次预检还实测 RDS `SSLEnabled=off`、上海私有 Bucket 未启用版本控制/删除保护，且无法复核生产主密钥注入、离线备份与凭据轮换。因此按 fail-closed 门禁未执行部署、强杀、重建、PITR、OSS 删除或密钥轮换，真实 ECS 内存/轮转/恢复/RTO 状态仍为“未验证”。完整脱敏证据见 `docs/operations/d7-08-ecs-recovery-validation.md`。

同日后续只读复核确认项目负责人更正后的 ECS 地址与上述 2 vCPU/4 GiB 云实例匹配，SSH 22 可达，但未尝试认证或进入机内。因同一对话披露了明文云 AccessKey、ECS 密码和 RDS 密码，原“凭据已轮换”前置已失效；这些值未被命令、配置或仓库使用，后续必须先撤销并重新轮换，再以受控密钥式入口完成机内预检。RDS 仍为 `VPC/Basic`、`SSLEnabled=off`，OSS 仍为 `unversioned`，因此设计验证状态不变：真实 ECS 仍未验证。

本地容器验证产物固定为 `linux/amd64`。取得 ECS 授权后必须先核对实例 CPU 架构；若为 ARM64，使用同一 Dockerfile 生成并验证对应平台或多架构 manifest，不得在未运行验证的架构上直接上线。
