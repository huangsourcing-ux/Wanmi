# ADR-0004：Commerce 状态机与幂等

- 状态：D0 已采用
- 日期：2026-08-03

## 决策

状态迁移集中在 `src/services/commerce/order-state.ts`。更新订单与追加 `orderEvents` 使用同一 Payload request 和事务。`commerceFulfillment` workflow 固定 `commerce` 队列、并发键为唯一 provider operation key、重试为 0；Worker 全局从 limit 1 开始。

合法迁移矩阵：

| 当前                | 目标                                                       |
| ------------------- | ---------------------------------------------------------- |
| pending_payment     | paid、cancelled                                            |
| paid                | fulfilling、refund_pending、manual_review                  |
| fulfilling          | succeeded、refund_pending、manual_review                   |
| refund_pending      | refunding、manual_review                                   |
| refunding           | refunded、manual_review                                    |
| cancelled           | manual_review（仅迟到支付或资金不一致）                    |
| manual_review       | fulfilling、succeeded、refund_pending、refunding、refunded |
| succeeded、refunded | 无                                                         |

`manual_review` 的每个出口必须包含处理备注和外部证据。provider operation 在 `prepared` 前可安全重试；一旦进入 `submitted` 或 `unknown`，自动执行只能查询，禁止重新提交。注册成功前先生成或核对域名资产，再迁移到 `succeeded`。

## 验证

测试枚举矩阵、全部 manual_review 出口、重复 Job、相同 concurrency key、唯一 operation row、追加事件和未知状态不重提。真实 provider 写接口在 D0 禁止执行。
