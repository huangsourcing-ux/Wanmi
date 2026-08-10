# 实名泄露 Runbook

## 触发信号

- `operations.monitoring.alerted` 的 category 为 `documents`，访问次数或不同证件数越线；
- `auditLogs` 中 `realname.document.viewed`/`downloaded` 出现异常 actor、时间或 trace ID；
- 有效管理员报告账号被接管，或私有 OSS/部署 secret 访问审计出现未经批准的对象或实名应用主密钥访问证据。

## 影响判定

立即由另一名有效 `system_admin` 在 `auditLogs` 按时间窗和 document target ID 查询。使用 `readRealnameDocumentAccessTrail` 所代表的同一受控视图还原 actor type/ID、访问时间、document ID、view/download 和 trace ID；不要读取或复制证件内容来“确认”事件。再由 realname document/template 关系确定影响范围，记录受影响记录 ID 数量而非证件号或姓名。

## 处置步骤

1. 对可疑管理员，先用 `DELETE /api/v1/admin/auth/sessions/{adminId}` 撤销全部会话；若确认账号失陷，在 Payload Admin 的 `admins` 受控编辑中将其设为 disabled。账号 hook 会撤销 session 并记录 `admin.account.changed`，且保护最后一个 system admin。
2. 保留 `auditLogs`、管理员账号、证件记录和私有对象元数据作为证据。只在既有授权边界内阻断访问；应用主密钥/OSS 凭据轮换、对象恢复或生产策略变更仍需项目负责人单独授权，并按 `docs/operations/realname-master-key.md` 执行。
3. 按受影响 document ID 核对所有短时票据已过期。票据最长 120 秒且绑定 actor/action/nonce；不要建立长期下载链接。
4. 启动隐私事件通知、法务与监管评估时只引用内部 incident ID 和受影响数量，敏感材料留在受控系统。

## 不可做

- 不把证件正文、对象 key、密文 envelope、数据密钥、IV、认证标签或完整客户身份复制到日志、聊天或工单；
- 不删除 audit、管理员、document 或 OSS 对象来“止损”，除非后续批准的保全/删除决定明确要求；
- 不在未获批准时执行生产应用主密钥/OSS 凭据轮换或误删恢复演练；
- 不使用公共 Media、公开 URL 或永久签名 URL 转存证件。

## 事后审计

保存告警 target ID、访问 trail、管理员 session 撤销与账号变化审计、受影响 document/template ID 清单、处置人和审批引用。最终报告必须能回答谁在什么时候访问哪份证件、访问模式、凭据何时被撤销，以及证件内容从未进入指标/告警/工单。
