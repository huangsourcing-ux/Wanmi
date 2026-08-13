# ADR-0006：单 ECS 可重建策略

- 状态：设计已采用并完成真实 ECS 验证；资源、恢复路径与完整重置 2 小时 RTO 均通过
- 日期：2026-08-03

## 决策

首发单 ECS 运行 Nginx、Web、独立 Worker 和 Who-Dat。Web/Worker 来自完全相同的镜像；数据库、对象和任务状态全部在 RDS/OSS，不把 ECS 文件系统作为唯一数据源。

重建顺序为：准备环境变量与网络 → 按 digest 拉取同一镜像 → 运行 Payload migrations → 启动 Web → 验证 readyz → 启动 commerce 单并发 Worker → 查询并恢复未完成 Job → 启动 Nginx。目标 RTO 为两小时。该顺序由 `scripts/rebuild-plan.mjs` 固定，`make rebuild` 执行；发布引用仍由 `deploy/release-policy.json` 与既有 `verify-release` 校验，不存在第二套镜像校验规则。

## 验证状态

2026-08-10 的 D7-07 先使用同一个 `linux/amd64` 应用镜像，在本地 2 vCPU/4 GiB 受限 Docker daemon 中完成工具链、内存、日志轮转、Web/Worker 独立重启、commerce Job 强杀恢复和空节点计时。该证据见 `docs/operations/d7-07-local-rebuild-validation.md`，只证明技术路径。

2026-08-10～11 的 D7-08 在项目负责人重置后的上海专用 ECS 上完成真实验证。机内硬停止检查确认 `x86_64` Ubuntu 24.04、2 CPU、宿主可见 3499 MiB，且无其他业务服务、容器、监听、计划任务或数据目录，之后才开始部署。Web/Worker 使用同一 `linux/amd64` digest；固定八步重建最终通过全部 migrations、database-backed readyz、`commerce --limit 1` Worker、恢复扫描和 Nginx ready。

三项常驻服务的实测最大峰值为 Web 294.9 MiB、Worker 385.5 MiB、Who-Dat 4.6 MiB，合计 685.0 MiB；最终稳态合计 362.2 MiB。相对配置的 4096 MiB 峰值余量为 3411.0 MiB，相对宿主实际可见 3499 MiB 的保守余量为 2814.0 MiB。真实磁盘对 Docker `local` 驱动写入约 64.8 MiB 后只保留 3 段、表观 1,827,862 bytes，证明轮转有界。Web 重建不终止 processing Worker；Worker `SIGKILL` 时 Web 保持 ready，两个并发恢复者返回 `[0,1]`，最终 operation/attempt/write claim 均恰好一次，续费和退款均为 0。由此，资源、日志、独立重启和同 VPC Job 恢复假设通过。

D7-08 原 RTO 结论已更正。原记录从 `2026-08-10T13:57:25Z` 至 `2026-08-11T04:43:25Z` 得到 **53,160 秒（14 小时 46 分）**，但项目负责人确认其中约 14 小时是 ECS 关机并等待负责人开机，不属于系统重建。该原数字保留作为更正痕迹，不能再作为 RTO 失败证据；当时镜像、依赖和 secret 已备齐后的 `make rebuild` 30.4 秒仍仅是局部工具链事实。

2026-08-13 的 D7-11 在机器全程可用、没有人工等待的前提下重新初始化唯一系统盘并自动启动。重置后的新系统确认无旧部署路径、Docker、Node 或业务监听后，从 `2026-08-13T02:20:02Z` 计时，到 `2026-08-13T02:29:44Z` Nginx ready，完整实测 **582 秒（9 分 42 秒）**，低于 7,200 秒目标并保留 **6,618 秒（1 小时 50 分 18 秒）**余量。人工等待为 0 秒；若更保守地从正常停止开始计入系统盘重新初始化与自动启动，总耗时也只有 632 秒。固定八步本身为 28.417 秒，其中 migrations 14.598 秒、Web 0.201 秒、readyz 3.948 秒、Worker 0.325 秒、未完成 Job 恢复 7.934 秒、Nginx 0.651 秒。由此“两小时内可恢复”假设通过。

本轮镜像来自 D7-08 已验证的 `linux/amd64` 不可变应用内容，重置前导出到受控开发机并校验 SHA-256，重置后经 SCP 传回、再次校验并推入节点 loopback registry；镜像传输 202 秒且未超时，目标 ECS 未直接访问外部 registry。D7-08 已观测的“目标 ECS 直连外部 registry 反复超时”仍是真实交付约束，且计时前节点内构建再次造成资源饱和。因此继续建议由 CI 预构建平台镜像并经稳定受控 registry 以不可变引用交付，但该改造不是本次 RTO 通过的前置，也未在 D7-11 实施。

真实恢复演练还确认订单、order events、Payload Jobs、实名元数据和支付通知归档均在 RDS，Web/Worker/Who-Dat 无业务 volume，ECS 无 PostgreSQL 进程或数据目录。RDS PITR 副本的 7 张订单/实名表逐行规范化哈希一致；应用主密钥从 ECS 内生成并完成 v1→v2 轮换，新旧对象读取和未知版本拒绝通过。专用 OSS Bucket 的版本控制为 `NotConfigured`，按负责人指令未执行对象删除/恢复；RDS `Category=Basic`、`SSLEnabled=off`，主密钥离线双人备份、凭据轮换和 OSS 误删恢复仍是生产上线门槛。完整脱敏证据见 `docs/operations/d7-08-ecs-recovery-validation.md`。

重建入口允许通过 `WANMI_NGINX_IMAGE` 和 `WANMI_WHODAT_IMAGE` 使用受控镜像源，但两者只接受 `repository@sha256:<64 hex>`；默认固定引用不变，不得用 tag 或第二套发布校验绕过 release policy。
