# Provider 故障 Runbook

## 触发信号

- `operations.monitoring.alerted` 的 category 为 `tools`、`sms`、`fulfillment`、`refunds` 或 `balance`；
- `toolObservabilityBuckets` 的 provider timeout/upstream/invalid-response/rejected 指标越线；
- `providerOperations` 出现 failed/unknown 或 submitted 过旧；
- `smsChallenges`/`domainExpiryReminders` 的 failed/unknown 越线；
- Worker 结构化日志出现 provider reason code，但不得包含请求凭据。

## 影响判定

按 provider 与 operation 分开判断：Who-Dat/DNS/TLS/价格查询属于只读工具；阿里云短信影响 OTP/提醒；微信影响支付/退款；西部数码影响报价、实名、注册、续费、NS 和余额。核对最近成功时间、影响窗口和请求量，不把单个客户输入或完整域名复制进监控。

## 处置步骤

1. 只读工具先确认公开工具已进入既有 degraded/partial 状态；广告、分析或 CMS 的故障处理见降级测试记录，不需要关闭六类工具。
2. 西部数码写侧异常时，用 `PATCH /api/v1/admin/commerce/balance-control` 对受影响 TLD 设置 manual sales stop，防止新订单扩大；已支付订单按 `abnormal-orders.md` 保留并逐笔处理。
3. 微信支付状态不明用 `POST /api/v1/admin/orders/{orderNumber}/payment-reconcile`；已验签通知处理失败用通知 replay。退款按 `refund-failure.md`，不重提未知写请求。
4. 西部数码 `submitted`/`unknown` operation 只允许既有恢复路径查询；没有专用安全出口时保持 `manual_review`。短信失败保留 challenge/reminder 状态，等待既有回执任务或下一个受控尝试，不手工伪造 delivered。
5. provider 恢复后先观察闭合监控窗口，再解除 manual sales stop；抽查历史 unknown operation 已经查询确认而非重提。

## 不可做

- 不把 provider 写超时解释为“未提交”，不自动重复注册、续费、NS 或退款；
- 不打开 `ALLOW_REAL_PROVIDER_WRITES` 做临时探测，不在本地/CI连接真实账号；
- 不新建平行 provider、队列或状态表绕过现有适配器；
- 不在日志和告警加入手机号、证件、完整域名、上游成本、加价或 provider secret。

## 事后审计

以告警窗口、provider、operation 和 trace ID 汇总工具桶、`providerOperations`、`manualReviews`、`reconciliations`、短信状态、`payload-jobs` 与审计事件。记录停售/恢复时间、未知写请求的查询证据及是否发生重复写。
