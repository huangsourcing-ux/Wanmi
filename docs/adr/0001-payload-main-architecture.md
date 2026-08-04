# ADR-0001：Payload 单一业务后端

- 状态：D0 已采用
- 日期：2026-08-03

## 决策

Next.js 16.2.11 与 Payload 3.86.0 位于 `apps/web`，共享 PostgreSQL Schema、Payload Local API、REST、Admin 和 Jobs。Web 与 Worker 使用同一 Dockerfile 产物，Worker 仅改变启动命令。PostgreSQL Adapter 在全部环境设置 `push: false`。

内容、身份、实名、交易、履约、审计和 Jobs 均由 Payload 管理；不引入第二套后端、认证、迁移或任务系统。

## 验证与退出

类型、import map、初始迁移、空库迁移、插件启动和生产构建进入 CI。若 Payload 无法满足核心 D0 退出条件，只延长 D0 和修正假设，不以第二套业务后端绕过。2026-08-04 的条件通过只延期共享 ECS 运行环境验证，不豁免架构条件。
