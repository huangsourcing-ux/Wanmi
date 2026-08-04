# ADR-0002：Local API 权限边界

- 状态：D0 已采用
- 日期：2026-08-03

## 决策

代表用户的 Local API 读取统一通过 `src/access/local-api.ts`，强制同时传入 `user` 与 `overrideAccess: false`。敏感 Collection 的通用 REST create/update/delete 默认拒绝，由 `/api/v1` service 完成状态与权限复核。

系统读取函数命名为 `systemFindForJob`，要求非空理由并先写 `auditLogs`。嵌套写入必须传递同一个 `req`；需要原子性的 service 使用 Payload transaction helpers。

## 验证

单元测试断言包装器不能遗漏 `overrideAccess: false`，并覆盖系统读取理由与审计记录。敏感 Collection 后续每次增加 endpoint，都必须增加匿名、customer 和四类管理员矩阵测试。
