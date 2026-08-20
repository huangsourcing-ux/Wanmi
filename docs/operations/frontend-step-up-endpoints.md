# 前端待接入的 step-up 端点清单

## 当前结论

2026-08-20 对 `apps/web/src/components/` 做了全量写请求审计。修复前共有 17 处显式
`POST` / `DELETE` 声明；管理员 Session 撤销调用点按条件 URL 展开后对应两个服务端契约。
没有 `PATCH` 或 `PUT` 调用点。

唯一存在“组件可触发、请求又必然不能通过当前严格 schema”的入口是单域名 Name Server
变更。旧组件只发送 `nameservers`，服务端 `nameserverChangeRequestSchema` 要求
`confirmed`、`deviceId`、`nameservers`、`stepUpToken`。旧前端按方案 B 移除该写请求，保留
当前 Name Server 与历史变更记录的读取展示，并禁用表单和提交按钮。新前端完成本页的
step-up 流程前，不得恢复提交按钮。

## components 写请求与 schema 逐项核对

“实际发送”包含 JSON body、鉴权 header 和 URL 参数；可选字段用 `?` 标记。

| 组件调用点                                     | 方法与端点                                               | 服务端 schema 当前要求                                              | 组件实际发送                               | 结论                      |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ | ------------------------- |
| `results/dns-results.tsx`                      | `POST /api/v1/tools/dns`                                 | `query`                                                             | `query`                                    | 匹配                      |
| `results/ssl-results.tsx`                      | `POST /api/v1/tools/ssl-check`                           | `query`                                                             | `query`                                    | 匹配                      |
| `results/domain-search-results.tsx`            | `POST /api/v1/tools/domain-search`                       | `query`；`tlds?`                                                    | `query`                                    | 匹配                      |
| `results/whois-results.tsx`                    | `POST /api/v1/tools/whois`                               | `query`                                                             | `query`                                    | 匹配                      |
| `results/pricing-results.tsx`                  | `POST /api/v1/tools/pricing`                             | `tlds?`                                                             | 空对象                                     | 匹配                      |
| `forms/public-form.tsx`                        | `POST /api/v1/forms/submissions`                         | `purpose`、`values`                                                 | `purpose`、`values`                        | 匹配                      |
| `domains/domain-assets.tsx` 资产同步           | `POST /api/v1/domains/:assetId/sync`                     | 已认证 Session、`assetId`；无 JSON body                             | Session、`assetId`；无 body                | 匹配                      |
| `domains/domain-assets.tsx` NS 变更（已关闭）  | `POST /api/v1/domains/:assetId/nameservers`              | `confirmed: true`、`deviceId`、`nameservers`、`stepUpToken`         | 修复前只有 `nameservers`；修复后不再发请求 | 必然失败，已按方案 B 禁用 |
| `commerce/payment-flow.tsx`                    | `POST /api/v1/orders/:orderNumber/payments`              | `channel: native \| h5`；另有余额分支要求 `deviceId`、`stepUpToken` | 类型只允许 `native \| h5`，发送 `channel`  | 匹配；不会进入余额分支    |
| `admin/admin-enrollment.tsx` 邀请解析          | `POST /api/v1/admin/auth/invitations/resolve`            | `Authorization: Bearer <43-char token>`；无 body                    | Bearer token；无 body                      | 匹配                      |
| `admin/admin-enrollment.tsx` 接受邀请          | `POST /api/v1/admin/auth/invitations/accept`             | Bearer token、`password`、`totp`                                    | Bearer token、`password`、`totp`           | 匹配                      |
| `admin/security-settings.tsx` 新管理员邀请     | `POST /api/v1/admin/auth/invitations`                    | `purpose: new_admin`、`email`、`roles`                              | 三项全部发送                               | 匹配                      |
| `admin/security-settings.tsx` MFA 重置邀请     | `POST /api/v1/admin/auth/invitations`                    | `purpose: mfa_reset`、`targetAdminId`                               | 两项全部发送                               | 匹配                      |
| `admin/security-settings.tsx` 撤销邀请         | `DELETE /api/v1/admin/auth/invitations/:id`              | 正整数 `id`；无 body                                                | `id`；无 body                              | 匹配                      |
| `admin/security-settings.tsx` 撤销全部 Session | `DELETE /api/v1/admin/auth/sessions/:adminId`            | 正整数 `adminId`；无 body                                           | `adminId`；无 body                         | 匹配                      |
| `admin/security-settings.tsx` 撤销单个 Session | `DELETE /api/v1/admin/auth/sessions/:adminId/:sessionId` | 正整数 `adminId`、UUID `sessionId`；无 body                         | `adminId`、`sessionId`；无 body            | 匹配                      |
| `admin/security-settings.tsx` 退出             | `POST /api/v1/admin/auth/logout`                         | `scope: current \| all`                                             | `scope`                                    | 匹配                      |
| `admin/content-workflow-controls.tsx`          | `POST /api/v1/content/:collection/:id/workflow`          | `action`；仅 `schedule_publish` 要求 `publishAt`                    | `action`；按 action 条件发送 `publishAt`   | 匹配                      |

修复后 `components/` 中保留 16 处显式写请求声明；上表仍保留已关闭的 NS 行，作为新前端
接入时必须恢复的契约检查点。

## 通用 step-up 取票流程

1. `POST /api/v1/auth/step-up/request`：发送 `captchaVerifyParam`、`deviceId`、`purpose`。
2. `POST /api/v1/auth/step-up/verify`：发送第一步返回的 `challengeId`，以及 `code`、同一个
   `deviceId` 和同一个 `purpose`；成功响应返回 `stepUpToken`、`expiresAt`、`oneTime`。
3. 最终高风险请求必须发送同一个 `deviceId`、匹配用途的 `stepUpToken`，以及该端点要求的
   确认、预览或幂等字段。不得在浏览器日志、URL 或持久存储中保存 OTP 或 token。

## 后端已有、旧 components 尚未接入的 step-up 写入口

| 用途                                     | 方法与端点                                                    | 最终请求所需字段                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nameserver_change`                      | `POST /api/v1/domains/:assetId/nameservers`                   | `confirmed: true`、`deviceId`、`nameservers`、`stepUpToken`                                                                                                             |
| `nameserver_change`                      | `POST /api/v1/domains/nameservers/batch`                      | `assetIds`、`batchKey`、`confirmed: true`、`deviceId`、`nameservers`、`previewToken`、`stepUpToken`；字段虽在边界 schema 中为条件可选，执行服务会对提交阶段 fail-closed |
| `balance_spend`                          | `POST /api/v1/orders/:orderNumber/payments` 的 `balance` 分支 | `channel: balance`、`deviceId`、`stepUpToken`                                                                                                                           |
| `account_deletion`                       | `POST /api/v1/auth/deletion-request`                          | `confirmation: DELETE_MY_ACCOUNT`、`deviceId`、`reason`、`stepUpToken`                                                                                                  |
| `domain_lock_change`                     | `PUT /api/v1/domains/:assetId/lock` 的解锁分支                | `locked: false`、`idempotencyKey`、`deviceId`、`stepUpToken`；加锁分支只需 `locked: true`、`idempotencyKey`                                                             |
| `renewal_mandate_change`                 | `PUT` / `DELETE /api/v1/domains/:assetId/renewal-mandate`     | 先用 preview 端点取得绑定预览；最终发送 `confirmed: true`、`deviceId`、`previewToken`、`stepUpToken`                                                                    |
| `domain_management_password`             | `POST /api/v1/domains/:assetId/management-password`           | `deviceId`、`stepUpToken`                                                                                                                                               |
| `domain_management_password`             | `PUT /api/v1/domains/:assetId/management-password`            | `deviceId`、`idempotencyKey`、`managementPassword`、`stepUpToken`                                                                                                       |
| `realname_change`                        | `PUT /api/v1/domains/:assetId/contact-information`            | `confirmed: true`、`contactType`、`deviceId`、`idempotencyKey`、`templateId`、`stepUpToken`                                                                             |
| `realname_change`                        | `POST /api/v1/domains/:assetId/template-transfer`             | `confirmed: true`、`deviceId`、`idempotencyKey`、`templateId`、`stepUpToken`                                                                                            |
| `dns_record_change` / `mx_record_change` | DNS 新增、修改、删除、暂停/启用端点中的高风险分支             | 业务字段与 `idempotencyKey`，并按服务端风险判定补 `confirmed`、`deviceId`、`stepUpToken`                                                                                |
| `dns_bulk_delete`                        | `POST /api/v1/domains/:assetId/dns-records/batch-delete`      | `recordIds`、`previewToken`、`deviceId`、`stepUpToken`；提交阶段由服务 fail-closed                                                                                      |

本清单只记录既有服务端契约，不修改任何 schema，也不代表旧前端已实现这些能力。
