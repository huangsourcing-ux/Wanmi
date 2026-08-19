# A4 风险表措辞对齐与逐项复核

日期：2026-08-18

## 冻结决定

`P1-BASELINE-2026-08-18.1` / `p1-docs-approved-2026-08-18-1` 显式链回
`P1-BASELINE-2026-08-17.2` / `p1-docs-approved-2026-08-17-2`。本次只把“获取/修改域名管理密码”
的保护档位对齐为已经合并的 D9-D-2 实现：

> step-up + 绑定渠道存在性校验 + 事后向全部 active 绑定渠道告知（逐 provider 记录 outcome）

该项不实施执行前的渠道确认。会话被盗时，用户只能事后获知，不能通过绑定渠道在操作执行前阻断；
这是项目负责人 2026-08-18 明确决定并接受的安全后果。本次没有修改任何实现、测试、migration、配置
或运行环境。

## A4 全表逐项复核

| A4 行                                                                                                        | 已实现保护与调用点                                                                                                                                                                  | 行为证据                                                                                                                                                                                                                                                          | 结论                                   |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 添加普通子域解析：当前会话 + 审计                                                                            | 普通子域不进入 `highRiskRecord`，变更事实后调用 `recordAuditEvent`（`apps/web/src/services/domains/dns-records.ts:279-310,488`）                                                    | `adds an ordinary subdomain without step-up and records scoped append-only audit history`（`apps/web/tests/integration/d9d1-dns-records.integration.test.ts:436`）                                                                                                | 正确                                   |
| 修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS：step-up + 二次确认                                               | DNS 风险分类与授权/确认见 `dns-records.ts:279-310,696-987`；NS 单项与批量入口见 `nameserver-changes.ts:384-403,511-533`                                                             | root AAAA 缺 grant/缺确认（`d9d1-dns-records.integration.test.ts:930,957`）、root 与 `_acme-challenge` TXT（`:1016,1043`）、root A/MX purpose 隔离（`:1160`）、NS 缺确认（`d9d2-domain-management.integration.test.ts:3143`）                                     | 正确                                   |
| 批量删除解析：step-up + 变更预览                                                                             | `deleteCustomerDnsRecordBatch` 固定消费 `dns_bulk_delete` 并验证绑定预览（`dns-records.ts:1184-1213`）                                                                              | `requires step-up and a bound preview, then keeps accepted offline deletions pending until queried`（`d9d1-dns-records.integration.test.ts:1509`），另有 preview 漂移/跨域/跨用户用例                                                                             | 正确                                   |
| 关闭域名锁：step-up + 通知                                                                                   | unlock 分支消费 `domain_lock_change`、要求 active 渠道并在成功后逐渠道通知（`domain-management.ts:550-638`）                                                                        | `rejects disabling the domain lock without step-up and notifies every active provider after success`（`d9c1-domain-center.integration.test.ts:740`）                                                                                                              | 正确                                   |
| 修改实名信息：step-up + 二次确认                                                                             | `authorizeRealnameChange` 检查字面量确认并消费 `realname_change`；联系人/过户两个入口分别调用（`domain-management.ts:648-663,665-788`）                                             | `rejects contact and transfer independently for foreign, unapproved, missing-step-up, and unconfirmed targets`（`d9d2-domain-management.integration.test.ts:632`）                                                                                                | 正确                                   |
| 获取/修改域名管理密码：step-up + 绑定渠道存在性校验 + 事后向全部 active 渠道告知（逐 provider 记录 outcome） | `authorizePasswordRisk` 消费 `domain_management_password` 并要求至少一个 active 渠道；read/write 成功后复用通知路径逐 provider 留 outcome（`domain-management.ts:319-339,422-544`） | `rejects password read and write independently without step-up or an active bound channel`（`d9d2-domain-management.integration.test.ts:406`）；`returns password plaintext once, notifies every active provider, and never persists or logs the value`（`:484`） | 正确；按负责人决定不要求执行前渠道确认 |
| 余额消费（交互式）：step-up                                                                                  | `createBalancePayment` 固定消费 `balance_spend`（`apps/web/src/services/commerce/balance-payments.ts:217-240`）                                                                     | missing grant、wrong-purpose grant、cooldown、matching-bound-facts 四条独立用例（`d9b3-balance-payments.integration.test.ts:588-650`）；自动续费零 step-up（`d9c2-automatic-renewals.integration.test.ts:1827`）                                                  | 正确                                   |
| 注销申请：step-up + 冷静期                                                                                   | `requestAccountClosure` 消费一次性 `account_deletion` grant 并持久化注销冷静期（`apps/web/src/services/auth/account-closure.ts:334-365`）                                           | `requires a fresh one-time deletion grant for every new closure request`（`d9a-account-closure.integration.test.ts:999`）；共享身份风险冷静期拒绝（`:1207`）                                                                                                      | 正确                                   |
| 账号刚完成找回或换绑：冷静期内禁止上述全部高风险操作                                                         | 每次 `authorizeStepUpGrant` 先调用 `assertIdentityRiskCooldownInactive`（`apps/web/src/services/auth/step-up.ts:224-261`），上述高风险入口均经过对应 grant                          | `blocks every high-risk purpose during the identity-risk cooldown even with a valid grant`（`d9a-step-up.integration.test.ts:725`），另有 DNS/NS、unlock、password/realname、balance、closure 各入口回归                                                          | 正确                                   |

## 结论

按 `P1-BASELINE-2026-08-18.1` 的准确保护语义，A4 风险表 9/9 行均已落到正确档位，开发计划 A4
“风险分级”总项可以在同一文档 PR 中勾选。该结论不声称管理密码路径具备执行前渠道确认，也不把事后
告知描述成阻断能力。

## 文档一致性范围

本次同步 `AGENTS.md`、开发计划 v3.4、PRD v2.2、技术栈 v5.13、阿里云资源 v5.3、产品规划 v4.2
和 App 技术规划 v3.2 的新基线、批准标签、上一基线链路与版本记录；开发日志追加变更起因和负责人
决定来源。D9-D-2 operation 证据改用准确档位，D9-B-3 旧审计标注为上一基线下的历史结论。
