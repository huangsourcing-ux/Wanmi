# D9-B-3 交互式余额消费 step-up 补正与 A4 风险表复核

日期：2026-08-18

> 后续基线说明：本文件的 A4 审计按当时 `P1-BASELINE-2026-08-17.2` 将“绑定渠道确认”理解为执行前
> 确认，因此如实记录管理密码路径不满足。项目负责人随后以 `P1-BASELINE-2026-08-18.1` 明确把该档位
> 对齐为 active 渠道存在性校验与事后逐 provider 告知，并接受不能执行前阻断的安全后果。当前 9/9
> 复核与勾选依据见 `docs/operations/a4-risk-tier-wording-audit.md`；本文件保留上一基线下的历史判断。

## 范围与边界

本补正只收紧交互式 `createBalancePayment`：支付请求必须携带 device-bound step-up grant，服务固定以
`balance_spend` purpose 授权，并继续使用原有 B-1 wallet hold。自动续费仍直接依据有效
`renewalMandate` 使用 wallet hold，不调用交互式余额支付入口，也不接收或消费 step-up。

全程使用 fixture；`ALLOW_REAL_WECHATPAY*` 与 `ALLOW_REAL_WESTDIGITAL*` 均保持 `false`。没有部署、
生产访问、真实资金请求或真实 provider 写入。

## 补正行为证据

| 要求                                     | 实现或行为用例                                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 交互式余额支付消费 `balance_spend` grant | `apps/web/src/services/commerce/balance-payments.ts:217-240`；`rejects a missing balance_spend step-up grant without changing balance or order state`                                                                   |
| purpose 不匹配失败关闭                   | `rejects a dns_record_change grant for balance spend without changing balance or order state`                                                                                                                           |
| cooldown 内失败关闭                      | `authorizeStepUpGrant` 在 `apps/web/src/services/auth/step-up.ts:248-261` 同事务调用 `assertIdentityRiskCooldownInactive`；`rejects balance spend during identity-risk cooldown with a valid grant and unchanged funds` |
| device/token 数据来源独立                | `accepts a matching balance_spend grant bound to the submitted device and token`；fixture 的 device 与 token 分别随机生成                                                                                               |
| 拒绝时订单与资金不变                     | 上述三条拒绝用例均断言 scoped hold 数量为 0、available/held/posted 精确值，以及订单仍为 `pending_payment` 且 `paymentChannel=null`                                                                                      |
| API 必填与转交                           | `apps/web/src/schemas/payments.ts:7-15`、支付路由 `:98-113`；`payment-route` 的三个缺字段/格式用例及 balance dispatch 参数断言                                                                                          |
| 无人值守不使用 step-up                   | `does not request interactive step-up during unattended execution`（`apps/web/tests/integration/d9c2-automatic-renewals.integration.test.ts:1827`）直接 spy `authorizeStepUpGrant` 并断言零调用                         |

## 新增判定点与变异

按调用点清点本补正新增的 9 个安全/正确性判定或事实来源。脚本
`apps/web/scripts/mutate-d9b3-balance-step-up.mjs` 每次只变异一项并只运行对应具名行为用例；9/9 均由
行为断言杀死，之后源码恢复。既有账户身份相等门在 authorizer 之前独立校验，因此 customer 来源与
`req.user` 的正常相关性已由既有 `rejects a request identity/options mismatch before looking up the order`
反相关用例打破；device/token 由独立随机值生成，purpose 另放入可用的 `dns_record_change` decoy grant。

| ID  | 判定点或事实来源变异                                              | 单独杀死它的行为用例                                                                                    | 结果   |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| S01 | balance API 的 `deviceId` 从必填改为可选                          | `payment-route: rejects balance payment without deviceId before dispatch`                               | killed |
| S02 | balance API 的 `stepUpToken` 从必填改为可选                       | `payment-route: rejects balance payment without stepUpToken before dispatch`                            | killed |
| S03 | 删除 opaque step-up token 格式约束                                | `payment-route: rejects balance payment without well-formed stepUpToken before dispatch`                | killed |
| S04 | 路由不再转交 `deviceId`                                           | `payment-route: dispatches balance without invoking the WeChat payment path or returning provider URLs` | killed |
| S05 | 路由不再转交 `stepUpToken`                                        | 同上                                                                                                    | killed |
| S06 | 删除 `createBalancePayment` 的 `authorizeStepUpGrant` 调用点      | `rejects a missing balance_spend step-up grant without changing balance or order state`                 | killed |
| S07 | **来源替换：**purpose 从 `balance_spend` 改为 `dns_record_change` | `rejects a dns_record_change grant for balance spend without changing balance or order state`           | killed |
| S08 | **来源替换：**device 改读 step-up token                           | `accepts a matching balance_spend grant bound to the submitted device and token`                        | killed |
| S09 | **来源替换：**token 改读 device                                   | 同上                                                                                                    | killed |

用户指定的两个变异原始失败如下。

删除 step-up 调用：

```text
AssertionError: promise resolved "{ …(3) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "data": {
+     "amountMinor": 2999,
+     "channel": "balance",
+     "currency": "CNY",
```

purpose 改为 `dns_record_change`：

```text
AssertionError: promise resolved "{ …(3) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "data": {
+     "amountMinor": 2999,
+     "channel": "balance",
+     "currency": "CNY",
```

## A4 风险表逐行复核

本节按当时 `P1-BASELINE-2026-08-17.2` 的“执行前绑定渠道确认”语义记录历史复核；本补正只实现余额
消费一行，其他行仅做只读核对。后续基线结论见本文开头说明。

| A4 行                                                          | 当前档位                                                                                                                                                                                                                     | 实现与行为证据                                                                                                                                                                                                              | 结论                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 添加普通子域解析：当前会话 + 审计                              | 普通子域不进入 `highRiskRecord`；每个变更事实写入后调用 `recordAuditEvent`（`dns-records.ts:279-310,488`）                                                                                                                   | `adds an ordinary subdomain without step-up and records scoped append-only audit history`（`d9d1-dns-records.integration.test.ts:436`）                                                                                     | 正确                                                                                                                          |
| 修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS：step-up + 二次确认 | DNS 风险分类及确认/授权见 `dns-records.ts:279-310`，8 个 add/modify/delete/pause/resume 调用点见 `:696,718,784,815,869,900,954,987`；NS 见 `nameserver-changes.ts:384-403,516-533`                                           | root AAAA 缺 grant/缺确认（`:930,957`）、root 与 `_acme-challenge` TXT（`:1016,1043`）、root A/MX distinct purpose（`:1160`）、NS 缺确认（`:3143`）                                                                         | 正确                                                                                                                          |
| 批量删除解析：step-up + 变更预览                               | `deleteCustomerDnsRecordBatch` 固定 `dns_bulk_delete` 并验证绑定预览（`dns-records.ts:1184-1213`）                                                                                                                           | `requires step-up and a bound preview, then keeps accepted offline deletions pending until queried`（`:1509`），preview drift/跨域/跨用户另有独立用例                                                                       | 正确                                                                                                                          |
| 关闭域名锁：step-up + 通知                                     | unlock 分支消费 `domain_lock_change`，要求至少一个 active channel；上游成功后逐渠道通知（`domain-management.ts:550-587,629-638`）                                                                                            | `rejects disabling the domain lock without step-up and notifies every active provider after success`（`d9c1-domain-center.integration.test.ts:740`）                                                                        | 正确                                                                                                                          |
| 修改实名信息：step-up + 二次确认                               | `authorizeRealnameChange` 独立检查 literal confirmation 并消费 `realname_change`（`domain-management.ts:648-663`），contact/transfer 两个入口分别调用（`:682,775`）                                                          | `rejects contact and transfer independently for foreign, unapproved, missing-step-up, and unconfirmed targets`（`d9d2-domain-management.integration.test.ts:632`）                                                          | 正确                                                                                                                          |
| 获取/修改域名管理密码：step-up + 绑定渠道确认                  | `authorizePasswordRisk` 消费 `domain_management_password`，但随后只读取 active identities 并检查“至少存在一个”；read/write 完成后调用的是 `notifyFormerCustomerIdentities`（`domain-management.ts:319-339,439-475,504-544`） | `rejects password read and write independently without step-up or an active bound channel`（`:406`）只证明 grant 与渠道存在；`returns password plaintext once, notifies every active provider...`（`:484`）证明的是事后通知 | **不足：没有绑定渠道确认 challenge/token、确认事实或执行前确认判定；当前是“step-up + 渠道存在 + 事后通知”，不等价于表中档位** |
| 余额消费（交互式）：step-up                                    | 本补正的 `createBalancePayment` 固定消费 `balance_spend`（`balance-payments.ts:217-240`）                                                                                                                                    | missing grant、wrong-purpose grant、cooldown、matching-bound-facts 四条独立用例（`d9b3-balance-payments.integration.test.ts:588-650`）                                                                                      | 正确（本补正）                                                                                                                |
| 注销申请：step-up + 冷静期                                     | `requestAccountClosure` 消费一次性 `account_deletion` grant 并持久化注销冷静期（`account-closure.ts:334-365`）；grant 内部同时执行身份风险冷静期门                                                                           | `requires a fresh one-time deletion grant for every new closure request`（`d9a-account-closure.integration.test.ts:999`）、`rejects a closure request during the shared identity-risk cooldown`（`:1207`）                  | 正确                                                                                                                          |
| 刚完成找回或换绑：冷静期禁止上述全部高风险操作                 | 每次 `authorizeStepUpGrant` 都先调用 `assertIdentityRiskCooldownInactive`（`step-up.ts:224-261`）；上述高风险入口均经过对应 grant                                                                                            | 全 purpose 用例 `blocks every high-risk purpose during the identity-risk cooldown even with a valid grant`（`d9a-step-up.integration.test.ts:725`），并有 DNS/NS、unlock、password/realname、balance、closure 各入口回归    | 正确；但不能补足上一行缺失的“绑定渠道确认”                                                                                    |

历史结论（`P1-BASELINE-2026-08-17.2`）：余额消费缺口已补正；管理密码路径不具备当时表述的执行前
绑定渠道确认，因此 A4 总项当时保持未勾选。后续 `P1-BASELINE-2026-08-18.1` 改变的是冻结要求措辞，
不是实现；按新档位 9/9 已满足，见 `docs/operations/a4-risk-tier-wording-audit.md`。

## 验证记录

- `payment-route.test.ts`：6/6。
- `d9b3-balance-payments.integration.test.ts`：46/46。
- C-2 零 step-up 具名回归：1/1。
- 9/9 定向变异均为 `KILLED_BY_BEHAVIOR`。
- 最终状态使用全新专用 fixture 数据库从头运行 `make check` 并退出 0：113 文件 804/804 unit、
  41 文件 637/637 主 integration 加 1 文件 37/37 wallet-ledger integration（合计 674/674），以及
  migration 往返、lint、TypeScript strict、宿主与 linux/amd64 镜像构建、依赖/秘密/镜像安全门禁全部通过。
  精确提交的 CI 结论在 PR 中记录。
