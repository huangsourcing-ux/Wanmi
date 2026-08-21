# D9 16.14 钱包、域名、增长与横向能力退出条件验收（二）

日期：2026-08-20

范围：承接 D9-A 退出条件验收，只收口 `Wanmi.AI-P1开发计划.md` 16.14 的 D9-C/D、D9-E 与横向剩余十条；不重做 D9-A 或 D9-B 验收。

## 验收口径与结论

- 专门验收文件：`apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts`；十条均以退出条件原文作为独立 `it` 用例名。
- 基线命令：`pnpm exec vitest run tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts --reporter=verbose`，结果 `10 passed (10)`。
- 变异命令：`node scripts/mutate-d9-exit-conditions-part-two.mjs`。执行器先要求同一文件基线 10/10，再临时破坏十个承重点；每轮核对失败用例集合与 manifest 完全相等，并在 `finally` 恢复生产源码。除注明的共享属性外，每轮严格只有对应的一条用例失败。
- 真实恢复演练使用 PostgreSQL 16 容器内的 `pg_dump --format=custom`，恢复到名称受正则约束的唯一一次性数据库，再由独立进程只连接恢复库运行既有对账/读取/任务服务。演练结束强制断开并删除该测试库及 dump；未使用事务内近似、表复制或同库重读替代 dump/restore。
- 结论：十条证据齐全，没有发现 c 类生产实现缺口；本切片没有修改生产服务代码。

## 逐条验收与变异证据

| 退出条件                                                                            | 独立验收用例（文件:行号 + 完整用例名）                                                                                                                                     | 变异及报错原文                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. NS、MX、解锁、管理密码操作未完成 step-up 时 fail-closed                          | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:460`：`NS、MX、解锁、管理密码操作未完成 step-up 时 fail-closed`                     | `D9-EXIT-02-01` 删除解锁入口的 purpose-bound step-up；仅本用例失败：`expected [ 'STEP_UP_GRANT_INVALID', …(4) ] to deeply equal [ 'STEP_UP_GRANT_INVALID', …(4) ]`                              |
| 2. 注册商不支持某能力时返回明确 capability 错误而非通用失败                         | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:548`：`注册商不支持某能力时返回明确 capability 错误而非通用失败`                    | `D9-EXIT-02-02` 把逐能力错误统一改成 `DOMAIN_OPERATION_FAILED`；仅本用例失败：`expected [ 'DOMAIN_OPERATION_FAILED', …(7) ] to deeply equal [ …(8) ]`                                           |
| 3. 域名已不属于当前上游账户时自动阻止操作                                           | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:567`：`域名已不属于当前上游账户时自动阻止操作`                                      | `D9-EXIT-02-03` 把 `WESTDIGITAL_ASSET_NOT_IN_ACCOUNT` 伪装成已归属资产；仅本用例失败：`expected false to be true // Object.is equality`                                                         |
| 4. 米币赚取幂等；跨批次消费按最早过期优先且分配可重算；米币与余额不可互换           | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:661`：同名用例                                                                      | `D9-EXIT-02-04` 把可消费批次从 expiry/id 升序反转为降序；仅本用例失败：`expected [ { batchId: 196, points: 40n }, …(1) ] to deeply equal [ { batchId: 195, points: 30n }, …(1) ]`               |
| 5. VIP 为历史最高水位：重算结果一致；普通退款不降级；经审批的数据纠错可降级         | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:733`：同名用例                                                                      | `D9-EXIT-02-05` 让普通退款错误删除该用户的等级事件；仅本用例失败：`expected null to deeply equal { displayName: '白银会员', …(5) }`                                                             |
| 6. 提高门槛后已达成用户保留原等级；充值本身不计入累计消费                           | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:782`：同名用例                                                                      | `D9-EXIT-02-06` 让读取结果按新门槛隐藏既得等级；因与第 5 条共享历史高水位属性，恰好第 5、6 条失败：`expected null to deeply equal { displayName: '白银会员', …(5) }`                            |
| 7. 邀请奖励只在不可退成功订单后发放；自邀与刷量被拦截并告警，且不自动扣回已发放奖励 | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:827`：同名用例                                                                      | `D9-EXIT-02-07` 让 `paid` 状态提前进入确认奖励路径；仅本用例失败：`订单状态迁移证据不满足邀请奖励条件`                                                                                          |
| 8. 通知重复消费同一 outbox 事件只能发送一次                                         | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:912`：同名用例                                                                      | `D9-EXIT-02-08` 让并发 claim 错误接受已处于 `sending` 的 delivery；仅本用例失败：`Error: Failed query:`；该错误来自同一 delivery 被多个 worker 同时写回，基线 CAS 下 provider spy 恰好调用 1 次 |
| 9. 数据库备份恢复后，余额、积分、等级与域名任务状态可重新对账                       | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:951`：同名演练用例；恢复库核对进程为 `apps/web/scripts/verify-d9-exit-restore.ts:1` | `D9-EXIT-02-09` 把恢复库钱包对账中的 credit 真源改为 0；仅本用例失败：`expected { …(4) } to deeply equal { …(4) }`                                                                              |
| 10. 外部 provider 超时或返回未知状态时不得盲目重复写操作                            | `apps/web/tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts:1162`：同名用例                                                                     | `D9-EXIT-02-10` 把未知提交错误持久化为可再次提交的 `prepared`；因恢复演练也依赖 unknown 域名任务，第 9、10 条恰好同时失败：`Error: A restored unknown operation must not be submitted again`    |

## dump/restore 演练结果

演练在源测试库准备四类事实：钱包 credit 800 分但缓存 900 分、可用米币 60、累计消费 1200 分并达到 VIP 1 级，以及一次已提交后超时、状态未知的 NS 任务。随后执行：

1. 用宿主 `createdb` 创建 `wanmi_d9_exit_restore_<32 hex>`，并验证名称；
2. 在仓库固定的 PostgreSQL 16.14 容器内对源库执行 custom-format `pg_dump`，再把该 dump `pg_restore` 到目标库；
3. 子进程只把 `DATABASE_URL` 指向恢复库，调用 `reconcileWalletLedger`、`readPointsBalance`、`readCustomerVipStatus` 与 `runNameserverChange`；
4. 断言钱包为 `differenceMinor: 100 / status: difference`，米币为 `available: 60 / pending: 0 / consumed: 0`，VIP 为 `cumulativeSpendFen: 1200 / tierRank: 1`；
5. 恢复的 NS unknown 任务通过两次上游查询确认成功，`writeCount: 0`，证明恢复后没有再次提交写操作；
6. 无论成功或失败均使用精确数据库名 `dropdb --force`，再删除 dump 与唯一临时目录。

这是一轮真实数据库备份恢复演练，不是 mock dump、内存快照或在原库上调用对账。provider 仍为 fixture，未开启真实闸门。

## 全部上游写调用点与 unknown/timeout 语义

### 西部数码统一写入口

以下 13 个 operation 均由验收用例逐个调用 `executeWestDigitalWriteOperation`：第一次写返回 `statusKnown: false`，断言结果持久化为 `unknown`；随后以相同业务键重放，断言 `idempotentReplay: true` 且 provider 写计数仍为 1。统一 dispatcher 位于 `apps/web/src/services/providers/westdigital-operations.ts:407-429`。

| operation                    | 当前生产调用路径                                                    | unknown/timeout 结论                       |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `realname`                   | 统一 dispatcher 支持，当前实名提交另走下表 `submitRealnameTemplate` | unknown 后不可再次 submit                  |
| `register`                   | `commerce/fulfillment.ts:898`                                       | 同业务键只写一次，之后只查询               |
| `renew`                      | `commerce/fulfillment.ts:740`                                       | 同业务键只写一次，之后只查询               |
| `nameserver`                 | `domains/nameserver-changes.ts:954`                                 | unknown 保持任务待查询，不再次改 NS        |
| `domain_lock`                | `domains/domain-management.ts:613`                                  | unknown 后不可再次解锁/加锁                |
| `domain_management_password` | `domains/domain-management.ts:527`                                  | unknown 后不可再次修改密码                 |
| `domain_contact_update`      | `domains/domain-management.ts:709`                                  | unknown 后不可再次修改联系人               |
| `domain_template_transfer`   | `domains/domain-management.ts:800`                                  | unknown 后不可再次转模板                   |
| `dns_record_add`             | `domains/dns-records.ts:597,692`                                    | unknown 后不可再次新增                     |
| `dns_record_modify`          | `domains/dns-records.ts:597,779`                                    | unknown 后不可再次修改                     |
| `dns_record_delete`          | `domains/dns-records.ts:597,864`                                    | unknown 后不可再次删除                     |
| `dns_record_pause`           | `domains/dns-records.ts:597,949`                                    | unknown 后不可再次暂停/启用                |
| `dns_record_batch_delete`    | `domains/dns-records.ts:1252,1376`                                  | offline submit unknown 后只按任务/记录查询 |

### 直接外部写调用点

验收用例还核对下列 17 类源码契约和精确调用点数量；实名对象删除两类各有两个实际调用点，因此合计覆盖 19 个直接调用点。这里没有把只读的查价、查单、查余额、查回执、查资产、读对象或验签误算为写。

| 调用点                            | 文件:行号                         | unknown/timeout 后行为                                             |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| 登录 OTP 短信                     | `auth/otp.ts:100`                 | 当前请求 fail-closed，不在内部循环重发                             |
| step-up OTP 短信                  | `auth/step-up.ts:86`              | 不生成 grant，不在内部循环重发                                     |
| 微信临时二维码                    | `auth/wechat.ts:209`              | provider 成功后才创建 scene，失败不伪造二维码                      |
| 微信扫码确认通知                  | `auth/wechat.ts:282`              | 异常被记录/吸收，不重复发送且不据此建会话                          |
| 换绑旧手机号通知                  | `auth/customer-identities.ts:758` | 每个旧身份一次调用，失败 outcome 可见                              |
| 换绑旧微信通知                    | `auth/customer-identities.ts:762` | 每个旧身份一次调用，异常 outcome 为 failed                         |
| 微信支付下单                      | `commerce/payments.ts:261`        | unknown 时只查同一商户单，不二次 create                            |
| 微信关单                          | `commerce/payments.ts:1110`       | 只在主动查单仍未支付后，以稳定确认 trace 关同一单                  |
| 微信退款创建                      | `commerce/refunds.ts:1321-1322`   | submitted/unknown 只 queryRefund，不再次 createRefund              |
| 钱包充值支付下单                  | `wallet/top-ups.ts:583`           | unknown 时只查同一充值商户单，不二次 create                        |
| outbox 短信通知                   | `notifications/outbox.ts:515`     | 原子 claim；状态未知落 unknown/dead-letter，不盲重发               |
| outbox 微信通知                   | `notifications/outbox.ts:538`     | 原子 claim；异常落 unknown，不盲重发                               |
| 域名到期短信                      | `domains/expiry-reminders.ts:402` | pending 原子转 sending；accepted 未确认时落 unknown                |
| 实名文件上传                      | `realname/documents.ts:269`       | 唯一对象 key；失败落 `upload_failed`，不在循环重传                 |
| 实名文件补偿/用户删除（2 处）     | `realname/documents.ts:297,478`   | 对同一对象 key 的幂等 DELETE；失败保持可见状态后由显式流程重试     |
| 实名生命周期主件/备份删除（2 处） | `realname/lifecycle.ts:50,83`     | 对同一对象 key 的幂等 DELETE；失败保留未删除事实和 retryable 错误  |
| 西部数码实名模板提交              | `realname/templates.ts:413`       | 先转 pending；unknown 进入 manual review，非 draft 不能再次 submit |

`DomainOperationProvider.submitOperation` 在当前 `src` 没有调用方；因此不把接口声明当作生产写路径。全量检索和上述契约没有发现 unknown/timeout 后在同一调用中再次发起非幂等写的 c 类缺口。

## 完整门禁

- 最终在全新一次性数据库 `wanmi_d9_exit_check_20260820_2243` 从头运行 `make check`，退出 0：全部 migration/schema/release/Nginx/运维/rebuild 验证、lint、TypeScript strict、118 文件 862/862 unit、46 文件 820/820 主 integration、D9-B-1 37/37、D9-B-6 11/11、D9-E-2 34/34、本验收 10/10（集成合计 912/912）、宿主 Next.js production build、linux/amd64 镜像构建、依赖审计、工作树与完整 235 commits Gitleaks、Trivy 全部通过。
- `test:integration` 把现有 D9-B-1、D9-B-6、D9-E-2 和本验收分别放在独立 Vitest 进程。原因是 D9-E-2 的 200～1000ms 到期 fixture 在全套高并发负载下会越过测试时间窗，而本验收还会真实创建、恢复和删除数据库；独立运行保留真实 PostgreSQL 语义并消除套件间时钟/连接干扰。第一次隔离库并行组中的 D9-E-2 三条到期用例失败后，同一源码单文件立即 34/34；调整编排后的全新隔离库完整门禁如上全绿。
- 最终门禁前的非通过尝试均不计成功：两次因未注入测试 `REALNAME_DOCUMENT_MASTER_KEYS` / `SESSION_PEPPER` 在 migration verifier 前置停止；复用旧本地库时，一个既有 VIP 通知 fixture 与并行删除发生外键碰撞；首个隔离库暴露上述 D9-E-2 短时 fixture 问题；一次 Docker Desktop daemon `EOF` 中断镜像构建。没有为这些环境/测试编排问题修改生产服务，Docker 恢复后 `make build` 成功，随后最终完整门禁从头通过。
- 最终数据库先验证 owner 为 `wanmi`、活动连接为 0、`wanmi_d9_exit_restore_%` 残留为 0，再按精确名称删除并复查不存在。删除不可恢复，但目标只含本切片 fixture 数据。

全程只使用本地 PostgreSQL、容器内 dump/restore 与 fixture provider；未部署、未访问或修改生产、未开启真实微信/短信/西部数码/OSS 写闸门。
