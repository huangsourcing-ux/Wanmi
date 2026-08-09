# 紧急停售 Runbook

## 触发信号

- 低余额、provider 故障、报价/实名/注册风险需要立即阻止新订单；
- `commerce.balance_low.alerted` 已触发自动停售；
- `operations.monitoring.alerted` 的 `balance`/`fulfillment` 告警达到负责人定义的紧急等级；
- `GET /api/v1/admin/commerce/balance-control` 显示预期 TLD 尚未停止。

## 影响判定

先列出受影响 TLD 和原因，查询当前自动/手动停售集合。统计尚未支付订单与已支付订单，重点查 `manualReviews.reasonCode = registration.sales_stopped`；停售只阻止新的报价/下单扩张，已支付订单必须保留并明确处置。

## 处置步骤

1. `system_admin` 对每个 TLD 调用 `PATCH /api/v1/admin/commerce/balance-control`，body 使用 `action = set_sales_stop`、`source = manual`、`stopped = true`、`tld = <具体后缀>`。接口通过 siteSettings CAS 和审计生效。
2. 重新 `GET /api/v1/admin/commerce/balance-control`，确认 manual/automatic 集合与预期一致；用本地安全验证确认受影响 TLD 下单返回 `TLD_SALES_STOPPED`，不要发送真实 provider 写请求。
3. 已支付而被 hold 的订单，由负责人逐笔调用 `POST /api/v1/admin/orders/{orderNumber}/sales-stop-resolution`，提交 note 与 provider console/query/written confirmation 证据，选择 `resume` 或 `refund`。
4. 风险解除后，先取得新的 provider/余额证据，再用同一 PATCH 把 `source = manual`、`stopped = false`。自动停售仍存在时不得用手动集合掩盖；按 `balance-shortage.md` 处理自动来源。

## 不可做

- 不删除或直接改写 siteSettings JSON，不使用 Payload bulk update 伪装 CAS；
- 不批量取消、退款或履约已支付订单；
- 不在 provider 状态未知时选择 resume，不在 `succeeded` 后选择退款；
- 不为恢复转化率而提前清除自动停售或提高余额阈值。

## 事后审计

以 `commerce.sales_stop.changed` 还原操作者、source、TLD、前后状态和时间；以 paid-order-held、resume/refund selected、manual review、Job/refund 和 order events 还原每笔已支付订单。记录恢复证据引用和解除停售后的首个健康闭合窗口。
