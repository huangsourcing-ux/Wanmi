# D7 运营监控 Runbook

## 执行与数据源

统一监控随既有 `westdigitalBalanceMonitoring` workflow 每 5 分钟在 `background` 队列执行，保持固定排他键 `westdigital:balance-monitoring`、`supersedes: true` 和零自动重试。它不建立第二套指标库，也不重新累计业务事件：

| 类别     | 既有数据源                                     | 告警条件                                                       |
| -------- | ---------------------------------------------- | -------------------------------------------------------------- |
| 工具     | `toolObservabilityBuckets`、`firstPartyEvents` | 达到最小请求量后失败率越线，或 timeout、拒绝、第一方失败数越线 |
| 短信     | `smsChallenges`、`domainExpiryReminders`       | 达到最小发送量后失败率越线，或 unknown 数越线                  |
| 支付     | `manualReviews`                                | 微信支付原因的开放复核数越线                                   |
| 订单     | `manualReviews`                                | 订单开放复核数或最老等待时长越线                               |
| 履约     | `providerOperations`                           | 西部数码非查询操作 failed/unknown，或 submitted 超时数越线     |
| 退款     | `providerOperations`                           | 微信退款 failed/unknown，或 submitted 超时数越线               |
| 余额     | `reconciliations`、`auditLogs`                 | 独立余额观察缺失/过旧，或低余额告警数越线                      |
| 证件访问 | `auditLogs`                                    | 查看/下载次数或不同证件数越线                                  |
| 对账     | `reconciliations`                              | `difference` 记录数越线                                        |
| Worker   | `siteSettings` 脱敏 commerce 心跳              | 心跳缺失或最后心跳年龄越线                                     |

只评估已经闭合的时间窗。`siteSettings` 的 `operations.monitoring.state.v1` 只保存最后完成窗口，不保存业务指标；认领使用同一事务内的 PostgreSQL `UPDATE ... WHERE value = old_value RETURNING`。重复 Job 或并发 Worker 都可以读取同一聚合，但只有一个执行者写 `operations.monitoring.alerted`，不会重复计数或重复告警。

## 阈值配置

未配置时使用代码中的保守默认值。`system_admin` 可在 Payload Admin 的 `siteSettings` 建立或修改 key `operations.monitoring.thresholds.v1`，value 必须完整符合 `operationsMonitoringThresholdsSchema`。字段分别是：

- `windowMinutes`；
- `tools.minimumRequests/failureRateBasisPoints/timeoutCount/rejectedCount/firstPartyFailureCount`；
- `sms.minimumAttempts/failureRateBasisPoints/unknownCount`；
- `payments.openManualReviewCount`；
- `orders.openManualReviewCount/maximumOpenAgeMinutes`；
- `fulfillment.failedOrUnknownCount/staleSubmittedCount/staleSubmittedMinutes`；
- `refunds.failedOrUnknownCount/staleSubmittedCount/staleSubmittedMinutes`；
- `balance.alertCount/maximumObservationAgeMinutes`；
- `documents.accessCount/distinctDocumentCount`；
- `reconciliation.differenceCount`。
- `workers.commerceMaximumHeartbeatAgeMinutes`。

修改后从下一个闭合窗口生效。配置解析失败会 fail-closed，使 Job 失败并留下 Worker 错误；不得为消除告警把阈值改成极大值。

## 隐私与调查

告警 metadata 只包含类别、条件、观察计数/比例、阈值、时间窗和阈值 key。不得加入手机号、证件内容、完整域名、customer ID、上游成本、加价规则、provider request credential 或密钥。

证件调查是审计视图，不是指标维度。`system_admin` 在 Payload Admin 的 `auditLogs` 以 action `realname.document.viewed`/`realname.document.downloaded`、时间和 `targetId` 查询，可以还原 actor type/ID、访问时间、证件 document ID 与 trace ID；不会读取证件内容、OSS object key 或加密材料。对应代码入口是 `readRealnameDocumentAccessTrail`，未暴露给浏览器自定义 endpoint。

## 告警分流

在 Payload Admin 的 `auditLogs` 过滤 action `operations.monitoring.alerted`，按 metadata.category 进入本目录相应 Runbook：

- `orders`、`payments`、`fulfillment`：`abnormal-orders.md`；
- `refunds`：`refund-failure.md`；
- `balance`：`balance-shortage.md`；
- `documents`：`realname-leak.md`；
- `tools`、`sms` 或 provider 相关异常：`provider-outage.md`；
- 主动停售或低余额联动：`emergency-sales-stop.md`；
- `reconciliation`：先核对 `reconciliations` 的独立账本证据，真实三方演练仍等待单独授权。
- `workers`：先检查 commerce Worker 容器状态、退出码和有限重启计数，再按 `release-rollback.md` 的持久配置契约重建；不得通过放宽心跳阈值或启用无界重启消除告警。

commerce Worker 每分钟通过既有 `commerce` 队列更新 `operations.worker.heartbeat.commerce.v1`。该 `siteSettings` 值只含固定角色、schema version 和最后心跳时间，不含 Job、订单、域名、客户或 provider 数据。既有 background Worker 每五分钟执行统一运营监控并读取该心跳，所以 commerce Worker 停止时仍能产生 `operations.monitoring.alerted`，`category=workers`、`condition=commerce_heartbeat_age_minutes`。
