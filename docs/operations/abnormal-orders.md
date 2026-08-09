# 异常订单 Runbook

## 触发信号

- `auditLogs.action = operations.monitoring.alerted` 且 category 为 `orders`、`payments` 或 `fulfillment`；
- `manualReviews.status = open`，特别是 `wechatpay.payment_*`、`wechatpay.late_payment`、`registration.*`、`renewal.*`；
- `providerOperations.status` 为 `failed`/`unknown`，或 `submittedAt` 已超过配置阈值；
- `payload-jobs` 的 `commerce` Job 出现 `hasError`、长时间 processing 或同一 concurrency key 的异常。

## 影响判定

先按 order ID 串起 `orders`、追加式 `orderEvents`、`manualReviews`、`providerOperations` 和 `payload-jobs`。确认订单当前状态、最后一次合法迁移、provider 请求是否已经发出、是否有已验签支付通知、是否已经生成资产或退款。仅以服务端查单、provider 查询或书面确认作为外部证据；页面跳转和客户截图不是支付/履约结论。

## 处置步骤

1. 对支付状态不明的订单，`system_admin` 使用 `POST /api/v1/admin/orders/{orderNumber}/payment-reconcile`，提交 `note` 与包含 `source/reference/observedAt` 的 evidence。该入口只执行微信主动查单并复用金额、商户订单号和交易号核对。
2. 已有通过微信验签的历史通知但处理失败时，使用 `POST /api/v1/admin/payments/notifications/{notificationId}/replay`。D5-07 入口只读取 `signatureVerified=true` 的归档并再次主动查单；重复重放不会重复迁移。
3. `providerOperations` 为 `submitted` 或 `unknown` 时，不重提注册、续费或 NS 写请求。让既有 D6 commerce 恢复路径只查询状态；若缺少可安全恢复的现有 Job 或专用处理入口，保持 `manual_review` 并升级给负责人，不用通用 Collection 修改订单。
4. 因停售被 hold 的已支付订单只使用 `POST /api/v1/admin/orders/{orderNumber}/sales-stop-resolution`，由负责人选择 `resume` 或 `refund`，并提交结构化外部证据与 note。恢复会排入既有 `commerceFulfillment`；退款复用 D5-04 自动原路全额退款路径。
5. 完成后重新核对 order、orderEvents、provider operation、Job、manual review 和域名资产/退款六者一致，保留告警 target ID 与 trace ID。

## 不可做

- 不用 Payload 通用 update、SQL 或 Admin 字段编辑直接改订单状态；
- 不把 `payload.update({ where })` 当 CAS，不清空 processing/operation 状态来制造重试；
- 不对 `submitted`/`unknown` provider 写请求再次提交；
- 不接受未验签通知、前端“支付成功”页、截图或口头说明作为到账证据；
- 不对已经 `succeeded` 的注册订单退款。

## 事后审计

以告警的 window、trace ID、order ID/number 为主线导出 `auditLogs`、`orderEvents`、`manualReviews`、`providerOperations`、`paymentNotifications`/archive 和 `payload-jobs` 记录。审计应能说明谁在何时发起查单/重放/停售处置、使用何种外部证据、状态如何迁移，以及是否只发生一次 provider 写。
