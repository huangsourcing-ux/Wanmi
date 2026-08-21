# D9-A 16.14 身份、会话、同意与注销退出条件验收

日期：2026-08-20

范围：仅 `Wanmi.AI-P1开发计划.md` 16.14 的前九条 D9-A 退出条件；不覆盖 D9-B/C/D/E 或横向退出条件。

## 验收口径与结果

- 专门验收文件：`apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts`。
- 基线命令：`pnpm exec vitest run tests/integration/d9a-exit-conditions.acceptance.integration.test.ts --reporter=verbose`，结果 `18 passed (18)`。
- 变异命令：`node scripts/mutate-d9a-exit-conditions.mjs`。脚本先要求同一文件基线 18/18，再逐个临时破坏保护点；每轮必须严格得到 `1 failed | 17 passed (18)`，且唯一失败用例名称必须等于 manifest 指定名称，否则立即退出失败。每轮均在 `finally` 恢复生产源码。
- 最终变异结果：`18 isolated mutations proved`。下表记录 2026-08-20 最终完整运行的原始 `AssertionError` 首行；本地 fixture 数字 ID 只用于还原该次输出。
- 没有为了通过验收修改生产实现；本切片没有发现 c 类实现缺口。

## 16.14 前八条逐项证据

| 退出条件                                                                    | 独立验收用例（文件:行号 + 完整用例名）                                                                                                                                                                   | 隔离变异及原始报错                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 同一微信 `openid` 从网页授权与 PC 扫码解析为同一账号，不产生重复账号     | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:728`：`同一微信 openid 从网页授权与 PC 扫码解析为同一账号，不产生重复账号`                                                | `D9A-01` 将 OAuth 使用的 openid 与扫码 openid 分叉；仅本用例失败：`AssertionError: expected { …(4) } to match object { customer: { id: 17615 }, …(1) }`                                                   |
| 2. 扫码未确认不得建会话；scene 一次性、过期、跨会话及回调验签均 fail-closed | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:774`：`扫码后未点击确认不得建立浏览器会话；scene 一次性、过期失效、跨会话不可复用；未验签的服务号事件不得建立会话`        | `D9A-02` 允许 `scanned` scene 被消费；仅本用例失败：`AssertionError: promise resolved "{ customer: { id: 17638, …(2) }, …(3) }" instead of rejecting`                                                     |
| 3. OAuth state 重放、授权码复用、跨站请求 fail-closed                       | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:830`：`网页授权 state 重放、授权码复用、跨站请求均 fail-closed`                                                           | `D9A-03` 删除 state 原子消费中的浏览器 session hash 条件；仅本用例失败：`AssertionError: promise resolved "{ …(4) }" instead of rejecting`                                                                |
| 4. 验证码使用边界、失败关闭和四维限频                                       | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:896`：`验证码只在短信发送与二维码创建/刷新时校验，轮询不重复校验；校验失败 fail-closed；与四维限频叠加后短信轰炸测试通过` | `D9A-04` 让短信验证码校验失败继续执行；仅本用例失败：`AssertionError: promise resolved "{ accepted: true, …(2) }" instead of rejecting`                                                                   |
| 5. 最后身份不可解绑；手机/微信换绑撤销全部旧会话                            | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1026`：`解绑最后一个可登录身份被拒绝；手机号或微信换绑后全部旧会话失效`                                                   | `D9A-05` 删除身份替换后的全会话撤销；仅本用例失败：`AssertionError: expected { totalDocs: 2 } to deeply equal { totalDocs: +0 }`                                                                          |
| 6. 账户找回后的高风险域名操作冷静期                                         | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1057`：`账户找回成功后高风险域名操作进入冷静期且被拒绝`                                                                   | `D9A-06` 删除找回批准后的冷静期启动；仅本用例失败：`AssertionError: promise resolved "{ data: { …(7) }, meta: { …(2) }, …(1) }" instead of rejecting`                                                     |
| 7. 历史账号不伪造同意时间且仍可处理到期域名                                 | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1088`：`历史账号不得生成伪造的条款同意时间；未补条款的历史用户仍可处理到期域名`                                           | `D9A-07` 把仅限新注册订单的历史条款门禁错误扩展到续费；仅本用例失败：`AssertionError: expected AppError: 请先补全账号资料并确认最新条款后再购买新域名 { …(3) } to match object { Object (code, status) }` |
| 8. 域名、处理中订单或资金差异阻止注销                                       | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1126`：`持有域名、处理中订单或资金差异时不能完成注销`                                                                     | `D9A-08` 删除 `domains_held` 前置检查；仅本用例失败：`AssertionError: expected { …(4) } to deeply equal { blockers: [ 'domains_held' ], …(2) }`                                                           |

## 第 9 条：A4 风险分级表逐行证据

第 9 条没有用一条笼统断言推定通过。原文命名的 suite 下对 A4 每一行分别建立用例，并另以原文完整命名的用例验证 step-up 短信频控和连续失败上限。

| A4 行                                 | 独立验收用例（文件:行号 + 完整用例名）                                                                                                                                                             | 隔离变异及原始报错                                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 添加普通子域解析                   | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1188`：`A4 第 1 行：添加普通子域解析仅需当前会话并记录审计，不错误要求 step-up`                                     | `D9A-09-A4-01` 把普通子域 A 记录误判为高风险；仅本用例失败：`AssertionError: promise rejected "AppError: 该高风险 DNS 变更需要二次确认 { …(3) }" instead of resolving`                          |
| 2. 根域 A/CNAME/AAAA、全部 MX/TXT、NS | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1216`：`A4 第 2 行：修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS 缺少 step-up 时逐项 fail-closed，且二次确认独立生效` | `D9A-09-A4-02` 让高风险 DNS 记录绕过授权函数；仅本用例失败：`AssertionError: promise resolved "{ data: { …(9) }, meta: { …(3) }, …(1) }" instead of rejecting`                                  |
| 3. 批量删除解析                       | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1285`：`A4 第 3 行：批量删除解析缺少 step-up 或绑定变更预览时 fail-closed`                                          | `D9A-09-A4-03` 删除批量删除的 step-up 必填与授权调用；仅本用例失败：`AssertionError: expected AppError: 批量删除预览无效或已被修改 { …(3) } to match object { code: 'STEP_UP_GRANT_REQUIRED' }` |
| 4. 关闭域名锁                         | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1331`：`A4 第 4 行：关闭域名锁缺少 step-up 时 fail-closed，成功后向 active 渠道通知`                                | `D9A-09-A4-04` 删除解锁的 step-up 授权调用；仅本用例失败：`AssertionError: promise resolved "{ data: { …(5) }, meta: { …(3) }, …(1) }" instead of rejecting`                                    |
| 5. 修改实名信息                       | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1387`：`A4 第 5 行：修改实名信息缺少 step-up 或二次确认时 fail-closed`                                              | `D9A-09-A4-05` 删除实名变更的 step-up 授权调用；仅本用例失败：`AssertionError: promise resolved "{ data: { …(4) }, meta: { …(3) }, …(1) }" instead of rejecting`                                |
| 6. 获取/修改域名管理密码              | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1440`：`A4 第 6 行：获取或修改域名管理密码要求 purpose-bound step-up、active 渠道，并在成功后逐 provider 告知`      | `D9A-09-A4-06` 删除管理密码操作的 purpose-bound step-up；仅本用例失败：`AssertionError: promise resolved "{ …(3) }" instead of rejecting`                                                       |
| 7. 交互式余额消费                     | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1534`：`A4 第 7 行：交互式余额消费缺少 balance_spend step-up 时 fail-closed`                                        | `D9A-09-A4-07` 删除余额支付的 step-up 授权调用；仅本用例失败：`AssertionError: expected AppError: 未找到订单 { …(3) } to match object { code: 'STEP_UP_GRANT_INVALID' }`                        |
| 8. 注销申请                           | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1550`：`A4 第 8 行：注销申请缺少 account_deletion step-up 时 fail-closed，授权后仍受注销冷静期约束`                 | `D9A-09-A4-08` 删除一次性 grant 原子 claim 的 purpose 谓词，使错误用途 grant 可被消费；仅本用例失败：`AssertionError: promise resolved "{ blockers: [], …(4) }" instead of rejecting`           |
| 9. 找回/换绑后的统一冷静期            | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1588`：`A4 第 9 行：账号刚完成找回或换绑时，冷静期内禁止上述全部高风险操作`                                         | `D9A-09-A4-09` 仅让 `balance_spend` 绕过统一身份风险冷静期；仅本用例失败：`AssertionError: promise resolved "{ grantId: 5385, oneTime: false, …(1) }" instead of rejecting`                     |
| step-up 短信控制                      | `apps/web/tests/integration/d9a-exit-conditions.acceptance.integration.test.ts:1627`：`step-up 未完成时风险分级表中的动作全部 fail-closed；step-up 短信验证码发送频控与连续失败次数限制生效`       | `D9A-09-SMS` 把原子失败次数上限从 `< max` 放宽为 `<= max`；仅本用例失败：`AssertionError: promise resolved "{ …(4) }" instead of rejecting`                                                     |

`D9A-09-A4-08` 的首版实验曾以伪造 grant ID 绕过授权，同时导致第 8 条注销前置用例和 A4 第 8 行两个用例失败，未计为证据。最终用例改为持有真实但用途错误的 grant，最终变异只删除 purpose 谓词，严格取得 1/17 隔离结果。

## 第 2 条生产记录引用

本地用例补齐自动化后，继续引用既有生产实测，不重新访问或修改生产：

- `开发日志.md:831`：二维码创建 HTTP 200；扫码但未确认时 scene 为 `scanned`；消费 HTTP 409 / `WECHAT_QR_ALREADY_CONSUMED`；会话数 `0 → 0`、customer 总数 `3 → 3`，scene 保持 `scanned`；无效签名 callback 未推进状态。
- `开发日志.md:832`：确认后首次消费成功，第二次消费同一 scene 为 HTTP 409；独立 TTL scene 经过 `created → scanned → expired` 后消费也为 HTTP 409，会话与 customer 计数不变。

本切片只使用本地 PostgreSQL 与 fixture provider；未部署、未访问生产、未开启真实闸门、未调用真实微信/短信/西部数码写接口。
