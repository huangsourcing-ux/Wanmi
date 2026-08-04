# ADR-0006：单 ECS 可重建策略

- 状态：设计已采用，受限资源实测待授权环境
- 日期：2026-08-03

## 决策

首发单 ECS 运行 Nginx、Web、独立 Worker 和 Who-Dat。Web/Worker 来自完全相同的镜像；数据库、对象和任务状态全部在 RDS/OSS，不把 ECS 文件系统作为唯一数据源。

重建顺序为：准备环境变量与网络 → 拉取同一镜像 → 运行 Payload migrations → 启动 Web → 验证 readyz → 启动 commerce 单并发 Worker → 查询并恢复未完成 Job → 启动 Nginx。目标 RTO 为两小时。

## 未完成验证

尚未在 2 vCPU/4 GiB ECS 或等价生产 Linux 限制下记录内存、独立重启、commerce 恢复和空节点重建。项目负责人于 2026-08-04 批准 D0 条件通过并将这些任务转入 D7；现有项目迁出前不得在共享 ECS 执行，完成前继续阻塞开发整体验收和生产上线。

本地容器验证产物暂定 `linux/amd64`。取得 ECS 授权后必须先核对实例 CPU 架构；若为 ARM64，使用同一 Dockerfile 生成并验证对应平台或多架构 manifest，不得在未运行验证的架构上直接上线。
