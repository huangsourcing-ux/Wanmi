# D9-B-3 余额支付与退款判定点变异矩阵

日期：2026-08-18

范围仅覆盖 D9-B-3：余额支付、余额与微信互斥、按订单实际支付渠道分派退款，以及余额 hold 在履约成功、明确失败和上游状态不明时的结算。未加入充值、第四 ledger 对账、资金规则、审批、角色或真实 provider 调用。

## 方法与口径

- 按调用点而非函数计数；同一能力在注册、续费、直接退款、退款 Job 等入口分别计数。
- 每次只删除一个判定、短路一个分支，或把一个安全关键事实来源替换为可构造出等价表象的错误来源；仅运行能杀死该变异的具名行为用例。
- 每个变异均在指定行为断言处非零退出，随后立即恢复源码；所有变异恢复后，D9-B-3 及受影响回归为 10 文件 131/131 通过。
- 数据库计数断言均带订单、钱包、transaction key、refund、trace 或 fixture scope 的 `where` 限定。测试环境显式保持 `ALLOW_REAL_WECHATPAY=false`、`ALLOW_REAL_WECHATPAY_PAYMENTS=false`、`ALLOW_REAL_WECHATPAY_REFUNDS=false`。

## 对照表

| ID  | 独立判定点或事实来源变异                                                         | 单独杀死该变异的行为断言                                                                                                           | 结果   |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M01 | 支付路由删除 `balance` 分派调用点                                                | `payment-route: dispatches balance without invoking the WeChat payment path or returning provider URLs`                            | killed |
| M02 | 把 service options 中的 customer 作为可信身份，不再与 `req.user` 比对            | `rejects a request identity/options mismatch before looking up the order`                                                          | killed |
| M03 | 删除余额支付入口的 A3 `purchase` 能力调用点                                      | `blocks purchase through the existing A3 capability before creating a hold`                                                        | killed |
| M04 | 删除余额支付入口的 A3 `balance_spend` 能力调用点                                 | `blocks balance spending through the existing A3 capability before creating a hold`                                                | killed |
| M05 | 删除“订单已选 balance”拒绝分支                                                   | `rejects an already selected balance channel with its stable conflict code`                                                        | killed |
| M06 | 删除余额支付前 `pending_payment` 状态门                                          | `rejects a non-pending order before any balance hold`                                                                              | killed |
| M07 | 删除订单冻结报价过期门                                                           | `rejects an expired frozen quote before any balance hold`                                                                          | killed |
| M08 | **来源替换：**支付金额改读报价快照金额，不读 `orders.amountMinor`                | `holds atomically, returns no WeChat URL, skips provider polling, and is skipped by timeout close` 的差异金额断言                  | killed |
| M09 | 删除 hold 返回状态必须为 `held` 的判定                                           | `rejects a stale released hold instead of confirming payment`                                                                      | killed |
| M10 | 删除余额支付的 `transitionOrder(..., 'paid')` 调用点                             | `holds atomically, returns no WeChat URL, skips provider polling, and is skipped by timeout close`                                 | killed |
| M11 | 删除余额支付后的 commerce fulfillment 入队调用点                                 | 同上用例的限定 workflow/queue/order 计数断言                                                                                       | killed |
| M12 | 删除 `wallet.balance_payment.held` 审计调用点                                    | 同上用例的限定 action/target/trace 计数断言                                                                                        | killed |
| M13 | 删除 balance channel CAS 的 `id` 谓词                                            | `keeps every balance-channel CAS predicate effective against stale or cross-order state` / `id` 子用例                             | killed |
| M14 | 删除 balance channel CAS 的 `status='pending_payment'` 谓词                      | 同上 / `status` 子用例                                                                                                             | killed |
| M15 | 删除 balance channel CAS 的 `payment_channel IS NULL` 谓词                       | 同上 / `payment_channel` 子用例                                                                                                    | killed |
| M16 | 删除 balance channel CAS 的 `merchant_order_number IS NULL` 谓词                 | 同上 / `merchant_order_number` 子用例                                                                                              | killed |
| M17 | 删除 balance channel CAS 的 `payment_expires_at IS NULL` 谓词                    | 同上 / `payment_expires_at` 子用例                                                                                                 | killed |
| M18 | 删除 balance channel CAS 的 `RETURNING id` 授权依据                              | 同上 / `RETURNING` 子用例                                                                                                          | killed |
| M19 | 删除微信 channel CAS 的 `id` 谓词                                                | `keeps every WeChat-channel CAS predicate effective against stale or cross-order state` / `id` 子用例                              | killed |
| M20 | 删除微信 channel CAS 的 `status='pending_payment'` 谓词                          | 同上 / `status` 子用例                                                                                                             | killed |
| M21 | 删除微信 channel CAS 的 `merchant_order_number IS NULL` 谓词                     | 同上 / `merchant_order_number` 子用例                                                                                              | killed |
| M22 | 删除微信 channel CAS 的 `payment_channel IS NULL` 谓词                           | 同上 / `payment_channel` 子用例                                                                                                    | killed |
| M23 | 删除微信 channel CAS 的 `payment_expires_at IS NULL` 谓词                        | 同上 / `payment_expires_at` 子用例                                                                                                 | killed |
| M24 | 删除微信 channel CAS 的 `RETURNING id` 授权依据                                  | 同上 / `RETURNING` 子用例                                                                                                          | killed |
| M25 | balance 认领失败后忽略已存在 `h5` channel                                        | `rejects the isolated WeChat signal h5 channel with the mixed-channel code`                                                        | killed |
| M26 | balance 认领失败后忽略已存在 `native` channel                                    | `rejects the isolated WeChat signal native channel with the mixed-channel code`                                                    | killed |
| M27 | balance 认领失败后忽略已存在 merchant number                                     | `rejects the isolated WeChat signal merchant number with the mixed-channel code`                                                   | killed |
| M28 | balance 认领失败后忽略已存在 payment expiry                                      | `rejects the isolated WeChat signal payment expiry with the mixed-channel code`                                                    | killed |
| M29 | 删除微信创建入口对 stored balance channel 的拒绝                                 | `rejects mixed balance and WeChat selection with the dedicated error in both directions`                                           | killed |
| M30 | **来源替换：**支付查询用 merchant number 推断渠道，不读 `paymentChannel`         | `routes solely by the stored paymentChannel even when indirect WeChat signals disagree` 的 provider query 断言                     | killed |
| M31 | 删除超时关单查询对 balance channel 的排除                                        | `holds atomically, returns no WeChat URL, skips provider polling, and is skipped by timeout close` 的订单状态断言                  | killed |
| M32 | **来源替换：**自动退款分派用微信交易信号推断渠道，不读 `paymentChannel`          | `routes solely by the stored paymentChannel even when indirect WeChat signals disagree` 的余额 release 断言                        | killed |
| M33 | **来源替换：**直接微信退款入口用 merchant number 推断渠道，不读 `paymentChannel` | `rejects both refund-path crossings before any opposite-channel effect` 的 balance→WeChat 断言                                     | killed |
| M34 | 删除直接余额退款入口必须为 stored balance channel 的门                           | `rejects both refund-path crossings before any opposite-channel effect` 的 WeChat→balance 断言                                     | killed |
| M35 | 删除微信退款 Job 读取订单后的 balance channel 门                                 | 同上用例的 WeChat provider writeCount=0 断言                                                                                       | killed |
| M36 | **来源替换：**履约 capture 用 merchant number 推断渠道，不读 `paymentChannel`    | `routes solely by the stored paymentChannel even when indirect WeChat signals disagree` 的 captured entry 断言                     | killed |
| M37 | 删除 hold amount 与 `orders.amountMinor` 精确相等判定                            | `rejects an order/hold amount mismatch, records one scoped manual review, and keeps the hold`                                      | killed |
| M38 | **来源替换：**hold transaction key 从 merchant number 派生，不从 order id 派生   | `routes solely by the stored paymentChannel even when indirect WeChat signals disagree` 的 exact hold 断言                         | killed |
| M39 | 删除 hold customer 与 order customer 的归属耦合                                  | `rejects independently corrupted hold customer and lifecycle provenance` / customer 子用例                                         | killed |
| M40 | 删除 hold type/status 生命周期耦合                                               | 同上 / type-status 子用例                                                                                                          | killed |
| M41 | 删除余额订单 `succeeded` 不可退款门                                              | `never refunds a succeeded balance-paid registration order`                                                                        | killed |
| M42 | 删除金额不一致时创建人工复核的调用点                                             | `rejects an order/hold amount mismatch, records one scoped manual review, and keeps the hold` 的 manualReview 计数断言             | killed |
| M43 | 删除余额退款 `refund_pending` 状态迁移调用点                                     | `routes solely by the stored paymentChannel even when indirect WeChat signals disagree` 的 orderEvents 序列断言                    | killed |
| M44 | **来源替换：**退款记录金额改读当前/报价金额，不读 `orders.amountMinor`           | 同上用例的 decoy quote 与 refund amount 精确断言                                                                                   | killed |
| M45 | 删除余额退款 `refunding` 状态迁移调用点                                          | 同上用例的 orderEvents 序列断言                                                                                                    | killed |
| M46 | 删除余额退款的 B-1 `releaseWalletHold` 调用点                                    | 同上用例的 released entry 与余额断言                                                                                               | killed |
| M47 | 删除余额退款 `refunded` 状态迁移调用点                                           | 同上用例的最终订单状态断言                                                                                                         | killed |
| M48 | 删除退款记录更新为 `succeeded` 的调用点                                          | 同上用例的限定 refund 状态断言                                                                                                     | killed |
| M49 | 删除 `wallet.balance_refund.completed` 审计调用点                                | 同上用例的限定 action/target 计数断言                                                                                              | killed |
| M50 | 删除金额不一致时 `wallet.balance_refund.blocked` 审计调用点                      | `rejects an order/hold amount mismatch, records one scoped manual review, and keeps the hold`                                      | killed |
| M51 | 删除余额退款成功重放的 exact amount/status 幂等门                                | `routes solely by the stored paymentChannel even when indirect WeChat signals disagree` 的二次调用与唯一 refund/release 断言       | killed |
| M52 | 删除注册成功调用点的 balance capture                                             | `captures on confirmed fulfillment, releases on explicit failure, and keeps unknown outcomes held` / registration success          | killed |
| M53 | 删除续费成功调用点的 balance capture                                             | `active-renewals: captures the stored balance hold when a renewal is confirmed`                                                    | killed |
| M54 | 删除注册 preflight 明确不可用调用点的按渠道退款                                  | `releases the balance hold when registration preflight finds the domain unavailable`                                               | killed |
| M55 | 删除注册 provider 明确失败调用点的按渠道退款                                     | `captures on confirmed fulfillment, releases on explicit failure, and keeps unknown outcomes held` / explicit registration failure | killed |
| M56 | 删除续费 provider 明确失败调用点的按渠道退款                                     | `active-renewals: releases the stored balance hold when renewal failure is explicit`                                               | killed |
| M57 | 从支付请求 Zod channel enum 删除 `balance`                                       | `payment-route: dispatches balance without invoking the WeChat payment path or returning provider URLs`                            | killed |
| M58 | 从 ready response channel enum 删除 `balance`                                    | 同上用例的 response schema 断言                                                                                                    | killed |
| M59 | 从 Orders Collection 的 paymentChannel options 删除 `balance`                    | `persists balance as an explicit Orders paymentChannel value`                                                                      | killed |
| M60 | migration `up` 不再把 `balance` 加入 enum                                        | 迁移 verifier 的 empty database / up channel enum 行为断言                                                                         | killed |
| M61 | migration `down` 删除“存在 balance order 时拒绝回滚”的保护                       | 迁移 verifier 的现存 balance order 回滚拒绝与失败原子性断言                                                                        | killed |
| M62 | 删除用户订单 Local API 的 `overrideAccess:false` 与 customer where 耦合          | `does not let one customer select balance payment for another customer order`                                                      | killed |
| M63 | 删除钱包 Local API 的 owner where 与 `overrideAccess:false` 耦合                 | `selects only the authenticated customer wallet when another CNY wallet exists`                                                    | killed |
| M64 | 删除订单冻结金额必须为正的判定                                                   | `rejects a corrupted non-positive order frozen amount before touching the wallet`                                                  | killed |
| M65 | **来源替换：**报价有效期改读订单支付 expiry/当前构造值，不读冻结 quote snapshot  | `rejects a missing frozen quote expiry before any balance hold`                                                                    | killed |
| M66 | 删除余额退款的可退款状态白名单                                                   | `rejects a cancelled balance order as non-refundable without releasing its hold`                                                   | killed |
| M67 | **合并边界：**充值支付路由改用包含 `balance` 的订单支付 schema                   | `rejects the balance payment channel before the top-up payment service call`                                                       | killed |

## 并发与三态结论

- 8 路同单余额支付：恰好 1 次 channel CAS、1 个 hold、1 次 `paid` 迁移和 1 个 commerce Job；其余请求稳定失败，available 从不为负。
- 同一 hold 的 capture/release 并发：B-1 原语恰好 1 次 terminal entry 生效；履约成功 capture、明确失败 release、provider/资产确认状态不明继续保持 held。
- N 路同单余额退款：恰好 1 个 refund、1 次 release、1 条完成审计；available 恢复到冻结前数值，不产生微信退款请求。
- balance 与微信并发选渠道：两套 CAS 共用订单前置事实，恰好一条路径取得授权；败方返回 `MIXED_PAYMENT_CHANNELS_FORBIDDEN`，不部分处理。
