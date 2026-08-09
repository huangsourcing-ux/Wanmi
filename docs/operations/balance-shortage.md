# 余额不足 Runbook

## 触发信号

- `auditLogs.action = commerce.balance_low.alerted`；
- `operations.monitoring.alerted` 的 category 为 `balance`，condition 为余额观察缺失/过旧或低余额告警；
- `reconciliations.ledger = westdigital_prepaid` 的余额观察长时间缺失；
- `siteSettings` 的 `commerce.westdigital.balance-control` 显示自动停售 TLD。

## 影响判定

通过 `GET /api/v1/admin/commerce/balance-control` 确认阈值、受影响 TLD、自动/手动停售集合；在 `reconciliations` 核对最近独立余额观察时间。再查 `manualReviews.reasonCode = registration.sales_stopped`，区分尚未创建的新订单和已经支付但被 hold 的订单。告警不展示余额金额，调查金额只在受限账本中进行。

## 处置步骤

1. 若 provider 余额查询异常，保持自动停售，不通过改阈值消除告警；先按 `provider-outage.md` 判断是否为 provider 故障。
2. 必须扩大停售时，由 `system_admin` 对 `PATCH /api/v1/admin/commerce/balance-control` 提交 `action = set_sales_stop`、`source = manual`、`stopped = true` 和具体 TLD。
3. 充值或余额恢复属于真实基础设施/资金操作，本 Runbook 不授权执行。取得单独授权并获得新的 provider 查询证据后，才可通过相同 PATCH 将相应来源的停售状态设为 false。
4. 对停售期已支付订单逐笔使用 `POST /api/v1/admin/orders/{orderNumber}/sales-stop-resolution` 选择恢复履约或退款；两条路径分别进入既有 commerce Job 或 D5-04 自动退款，不丢订单。

## 不可做

- 不删除 `commerce.westdigital.balance-control`，不把阈值改成 0 或极大值掩盖故障；
- 不清除自动停售而没有新的余额查询证据；
- 不批量直接改已支付订单状态，不自动重复注册；
- 不在告警 metadata、日志或通知暴露西部数码余额、上游成本、加价规则或凭据。

## 事后审计

串联 `commerce.balance_low.alerted`、`commerce.sales_stop.changed`、`commerce.sales_stop.paid_order_held`、`commerce.sales_stop.resume_selected`/`refund_selected`、相关 `reconciliations` 和 `manualReviews`。记录谁在何时手动停售/恢复、依据哪次余额观察、每笔已支付订单的负责人决定和后续 Job/退款结果。
