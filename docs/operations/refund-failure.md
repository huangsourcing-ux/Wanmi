# 退款失败 Runbook

## 触发信号

- `operations.monitoring.alerted` 的 category 为 `refunds`；
- `providerOperations.provider = wechatpay`、`operation = refund` 且 status 为 `failed`/`unknown`，或 submitted 超过阈值；
- `manualReviews.reasonCode` 为 `wechatpay.refund_failed`、`wechatpay.refund_status_unknown`、`wechatpay.refund_balance_insufficient`、`wechatpay.refund_disputed` 或金额/标识不一致；
- `refunds.status` 为 `failed`/`unknown`，或 `wechatRefund` Job 报错。

## 影响判定

按 order/refund 关系核对原支付确认、订单状态、整数分退款金额、退款号、provider operation 和最后查询时间。区分“明确未受理”“已提交处理中”“状态未知”“余额不足/争议”“已确认成功”；`submitted`/`unknown` 一律视为可能已发生资金操作。

## 处置步骤

1. 保留现有 `wechatRefund` Job、refund 和 provider operation。D5-04 `runWechatRefund` 对 `submitted`/`unknown` 自动走 `queryRefund`，不得改成再次 `createRefund`。
2. 明确失败仍由 `manualReviews` 承载，取得微信后台查询或书面确认后再决定。当前仓库没有“强制退款成功”接口；没有专用出口时保持人工复核，不直接改订单。
3. 如果经批准在外部完成特殊退款，只能用 `POST /api/v1/admin/orders/{orderNumber}/manual-actions` 的 `special_refund` 记录整数分金额、reason 和结构化 evidence。该入口做累计金额与原支付证据校验，但只是审计记录，不冒充自动退款状态迁移。
4. 退款恢复后核对 `refunds`、`providerOperations`、`orderEvents`、`manualReviews` 和 `auditLogs`。订单只有在 provider 查询/验签通知确认后才能进入 `refunded`。

## 不可做

- 不删除失败 refund 后新建另一笔来绕过唯一业务语义；
- 不对 `submitted`/`unknown` 再发退款；
- 不把特殊退款审计入口当作微信 provider 调用或订单状态旁路；
- 不超过原支付整数分金额，不对 `succeeded` 注册订单退款；
- 不在日志、告警或工单复制 API v3 密钥、完整交易凭据或客户敏感信息。

## 事后审计

以 refund number、order ID、provider operation key 和 trace ID 还原首次请求、查询次数、provider state、人工证据与最终迁移。确认没有第二个退款写请求，自动与特殊退款累计不超过原支付金额，并记录人工复核关闭人和时间。
