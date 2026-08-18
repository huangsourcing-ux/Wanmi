# D9-D-3 离线任务与批量操作判定点变异矩阵

## 范围与接口依据

本切片只完成开发计划 16.9 第 4、5 项：西部数码 V2 离线任务提交/查询，以及 DNS 批量删除、Name
Server 批量修改的逐项幂等、`partial`、dry-run 与影响预览。不实现 DNSSEC、DDNS、常用邮箱解析、域名
转入/转出或计划第 50～53 行之外内容。

接口字段以仓库根目录只读《西部数码业务API接口文档（v2）新.md》和负责人提供的
[在线文档](https://docs.apipost.net/docs/detail/60eea01fc488000?target_id=6190688) 为依据。在线动态页在
2026-08-18 实际展示的离线任务文档目标为 `target_id=f6dcfe53ec1a8`，确认：

- 固定基址 `https://newapi.west.cn/v2/offline-task/{action}`，认证字段为 `username`、毫秒 `time`、
  `token=md5(username+API key+time)`；响应包络为 `code/msg/data/clientid`；
- 任务状态 `0/1/2/3`，记录状态 `0/1/2/3/4/5/6`；只有记录状态 `3` 确认成功，任务状态 `3` 或记录状态
  `4/5` 明确失败，其余保持待查询；
- DNS 离线任务使用 `add-dns-record-task`、`task-list`、`task-record-list`，删除动作 `dodelreall`，
  `task_type=dns_record`，逐行字段为 `domain|host|type|value|线路中文`；
- 文档虽列出 NS 离线入口，但没有给出多 NS 的逐行分隔/编码契约。因此本切片不猜字段：DNS 批量删除
  使用离线 API；NS 批量操作复用既有 Name Server Job，并最终只经 D6-01
  `executeWestDigitalWriteOperation` 调用既有 provider 写入口。

## 执行口径与汇总

每个判定点均临时删除条件、短路分支或替换一个耦合值，只运行表中指定的行为用例；源码在每项后立即
恢复。只有测试以 `AssertionError` 直接失败才计为杀死；编译、装载、定位或语法失败不计。最终代码状态
执行结果为业务/安全判定 **61/61**、migration/release 判定 **44/44**，合计 **105/105**。

| 分组                                           | 数量 |  结果 |
| ---------------------------------------------- | ---: | ----: |
| provider 契约、身份、状态、transport           |   14 | 14/14 |
| D6 路由、状态、归属阻断                        |    8 |   8/8 |
| HMAC 与 DNS 预览绑定                           |    8 |   8/8 |
| DNS 幂等、partial、A3、A4                      |    7 |   7/7 |
| NS 输入、预览绑定、A4                          |   13 | 13/13 |
| NS 条目幂等、失败可见、partial                 |    8 |   8/8 |
| NS A3 与追加式 Hook                            |    5 |   5/5 |
| migration 枚举、必填、外键、唯一键、索引、回滚 |   37 | 37/37 |
| release policy / manifest                      |    7 |   7/7 |

## 业务与安全调用点（61 项）

|   # | 分组 / 变异 ID                                          | 删除或短路的判定                     | 独立行为用例                                                                            | 结果   |
| --: | ------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- | ------ |
|   1 | `provider-contract/submit-documented-act`               | 把 `dodelreall` 改为未定义动作       | `westdigital-write.test.ts` — `maps documented V2 offline DNS deletion submission...`   | killed |
|   2 | `provider-contract/submit-line-label`                   | 不把线路码映射为文档中文标签         | 同上                                                                                    | killed |
|   3 | `provider-contract/acceptance-not-success`              | 把 task acceptance 改写成 succeeded  | 同上 — `without treating acceptance as success`                                         | killed |
|   4 | `provider-contract/task-key-required`                   | 忽略 `task_sku` 缺失                 | 同上 — `without task_sku status-unknown`                                                | killed |
|   5 | `provider-identity/task-act-match`                      | 删除 task `task_act` 身份匹配        | 同上 — `rejects mismatched offline task identity`                                       | killed |
|   6 | `provider-identity/task-type-match`                     | 删除 task `task_type` 身份匹配       | 同上                                                                                    | killed |
|   7 | `provider-identity/record-domain-match`                 | 删除 record `record_ident` 域名匹配  | 同上                                                                                    | killed |
|   8 | `provider-state/record-success-state-3`                 | 删除记录状态 3 成功映射              | 同上 — `maps documented offline task_state...`                                          | killed |
|   9 | `provider-state/task-failure-state-3`                   | 删除任务状态 3 失败映射              | 同上                                                                                    | killed |
|  10 | `provider-state/record-failure-state-4`                 | 删除记录状态 4 失败映射              | 同上                                                                                    | killed |
|  11 | `provider-state/record-exception-state-5`               | 删除记录状态 5 异常映射              | 同上                                                                                    | killed |
|  12 | `transport-auth/auth-field-injection`                   | 允许调用方覆盖认证字段               | `westdigital-offline-http.test.ts` — `rejects caller-supplied authentication fields...` | killed |
|  13 | `transport-contract/submit-method-post`                 | 把创建任务 POST 改为 GET             | 同上 — `POSTs task creation...`                                                         | killed |
|  14 | `transport-contract/fixed-offline-origin`               | 把固定上游域名改为其他 origin        | 同上                                                                                    | killed |
|  15 | `d6-routing/offline-submit-dispatch`                    | 离线提交绕到同步删除                 | `d9d1-dns-records.integration.test.ts` — `keeps accepted offline deletions pending...`  | killed |
|  16 | `d6-state/no-query-on-acceptance`                       | acceptance 后同请求立即查单          | 同上                                                                                    | killed |
|  17 | `d6-routing/offline-query-dispatch`                     | 删除离线 task 查询分派               | 同上 — `returns six-state partial...`                                                   | killed |
|  18 | `d6-state/offline-confirmed-terminal`                   | 明确成功仍不进入终态                 | 同上 — `replays completed batch items...`                                               | killed |
|  19 | `d6-state/offline-explicit-failure-terminal`            | 明确失败不进入失败终态               | 同上 — `returns six-state partial...`                                                   | killed |
|  20 | `d6-safety/offline-upstream-ownership-callpoint`        | 批量 DNS 条目绕过 D9-D-2 归属守卫    | 同上 — `applies D9-D-2 upstream ownership blocking...`                                  | killed |
|  21 | `preview-signature/hmac-equality`                       | 删除共享 HMAC 恒定时间比较           | 同上 — `binds batch preview signatures...`                                              | killed |
|  22 | `dns-preview-binding/dns-preview-version`               | 删除 DNS 预览版本绑定                | 同上                                                                                    | killed |
|  23 | `dns-preview-binding/dns-preview-asset`                 | 删除 asset 绑定                      | 同上                                                                                    | killed |
|  24 | `dns-preview-binding/dns-preview-customer`              | 删除 customer 绑定                   | 同上                                                                                    | killed |
|  25 | `dns-preview-binding/dns-preview-domain`                | 删除域名绑定                         | 同上                                                                                    | killed |
|  26 | `dns-preview-binding/dns-preview-expiry`                | 删除预览有效期判断                   | 同上                                                                                    | killed |
|  27 | `dns-preview-binding/dns-preview-record-ids`            | 删除完整 record ID 集合比较          | 同上 — `execution target set adds one record`                                           | killed |
|  28 | `dns-preview-binding/dns-preview-record-digest-current` | 删除当前记录内容摘要比较             | 同上 — `one selected record is modified`                                                | killed |
|  29 | `dns-idempotency/dns-replay-before-record`              | 重试时先查当前记录而不复用原始意图   | 同上 — `replays completed batch items...`                                               | killed |
|  30 | `dns-result/dns-all-items-must-succeed`                 | 任意结果都错误返回 ready             | 同上 — `keeps accepted offline deletions pending...`                                    | killed |
|  31 | `a3-callpoint/dns-a3-preview`                           | 删除 DNS 预览入口 A3                 | 同上 — `applies the A3 domain-write capability gate...`                                 | killed |
|  32 | `a3-callpoint/dns-a3-execute`                           | 删除 DNS 执行入口 A3                 | 同上                                                                                    | killed |
|  33 | `a3-callpoint/dns-a3-query`                             | 删除 DNS 批次查询入口 A3             | 同上                                                                                    | killed |
|  34 | `dns-risk/dns-batch-step-fields`                        | 删除批量删除 step-up 字段门禁        | 同上 — `requires step-up and a bound preview...`                                        | killed |
|  35 | `dns-risk/dns-batch-step-authorizer`                    | 短路 `authorizeStepUpGrant` 调用点   | 同上                                                                                    | killed |
|  36 | `ns-input/ns-unique-assets`                             | 删除批量资产去重                     | `d9d3-nameserver-batch.integration.test.ts` — `rejects duplicate assets...`             | killed |
|  37 | `ns-input/ns-unique-nameservers`                        | 删除 NS 去重                         | 同上                                                                                    | killed |
|  38 | `ns-preview-binding/ns-preview-version`                 | 删除 NS 预览版本绑定                 | 同上 — `binds every NS preview token field independently`                               | killed |
|  39 | `ns-preview-binding/ns-preview-kind`                    | 删除预览 kind 绑定                   | 同上                                                                                    | killed |
|  40 | `ns-preview-binding/ns-preview-customer`                | 删除 customer 绑定                   | 同上                                                                                    | killed |
|  41 | `ns-preview-binding/ns-preview-batch`                   | 删除批次展示键绑定                   | 同上                                                                                    | killed |
|  42 | `ns-preview-binding/ns-preview-expiry`                  | 删除有效期判断                       | 同上                                                                                    | killed |
|  43 | `ns-preview-binding/ns-preview-assets`                  | 删除完整资产集合绑定                 | 同上                                                                                    | killed |
|  44 | `ns-preview-binding/ns-preview-nameservers`             | 删除目标 NS 集合绑定                 | 同上                                                                                    | killed |
|  45 | `ns-preview-binding/ns-current-asset-digest`            | 删除当前资产版本事实摘要比较         | 同上 — `one asset versioned fact is modified`                                           | killed |
|  46 | `ns-risk/ns-preview-required`                           | 删除 dry-run token 必填门禁          | 同上 — `without a dry-run preview`                                                      | killed |
|  47 | `ns-risk/ns-confirmation-required`                      | 删除二次确认门禁                     | 同上 — `without secondary confirmation`                                                 | killed |
|  48 | `ns-risk/ns-step-fields-required`                       | 删除 step-up 字段门禁                | 同上 — `without step-up`                                                                | killed |
|  49 | `ns-idempotency/ns-item-key-excludes-batch-trace`       | 把批次 trace 错误并入条目键          | 同上 — `concurrent different batches sharing items...`                                  | killed |
|  50 | `ns-idempotency/ns-job-row-id-predicate`                | 删除 Job CAS 的行 ID 谓词            | 同上 — `unrelated pending item queued...`                                               | killed |
|  51 | `ns-idempotency/ns-job-pending-status-predicate`        | 删除 Job CAS 的 pending 谓词         | 同上 — `terminal failed item...`                                                        | killed |
|  52 | `ns-idempotency/ns-job-not-queued-predicate`            | 删除 Job CAS 的未入队谓词            | 同上 — `sequential batch retry...`                                                      | killed |
|  53 | `ns-idempotency/ns-job-queued-returning`                | 忽略 `RETURNING` 命中 0 行           | 同上                                                                                    | killed |
|  54 | `ns-failure-visibility/ns-admission-failure-persisted`  | 入队失败不落终态原因                 | 同上 — `persists an admission failure reason...`                                        | killed |
|  55 | `d6-safety/ns-upstream-ownership-terminal`              | NS worker 不识别 D6 `not_owned` 拒绝 | 同上 — `keeps every NS batch item behind D6 ownership blocking...`                      | killed |
|  56 | `ns-result/ns-all-items-must-succeed`                   | 有失败/待查询仍错误返回 ready        | 同上 — `exposes pending_query...`                                                       | killed |
|  57 | `a3-callpoint/ns-a3-preview`                            | 删除 NS 预览入口 A3                  | 同上 — `applies A3 capability...`                                                       | killed |
|  58 | `a3-callpoint/ns-a3-execute`                            | 删除 NS 执行入口 A3                  | 同上                                                                                    | killed |
|  59 | `a3-callpoint/ns-a3-query`                              | 删除 NS 查询入口 A3                  | 同上                                                                                    | killed |
|  60 | `ns-append-only/ns-batch-event-update-hook`             | 删除事件 update Hook                 | 同上 — `queues one item per domain...`                                                  | killed |
|  61 | `ns-append-only/ns-batch-event-delete-hook`             | 删除事件 delete Hook                 | 同上                                                                                    | killed |

## Migration 与发布判定（44 项）

|   # | 分组 / 变异 ID                                                             | 删除或短路的判定            | 行为验证器                                | 结果   |
| --: | -------------------------------------------------------------------------- | --------------------------- | ----------------------------------------- | ------ |
|  62 | `migration-up-enum/operation-nameserver-change`                            | 操作枚举改值                | `verify-d9d3-offline-batch-migration.mjs` | killed |
|  63 | `migration-up-enum/event-requested`                                        | 删除 requested              | 同上                                      | killed |
|  64 | `migration-up-enum/event-pending-query`                                    | 删除 pending_query          | 同上                                      | killed |
|  65 | `migration-up-enum/event-confirmed`                                        | 删除 confirmed              | 同上                                      | killed |
|  66 | `migration-up-enum/event-failed`                                           | 删除 failed                 | 同上                                      | killed |
|  67 | `migration-up-enum/provider-operation-dns-record-batch-delete`             | 删除 provider 操作枚举值    | 同上                                      | killed |
|  68 | `migration-up-nullability/event-key-required`                              | 删除 `event_key NOT NULL`   | 同上                                      | killed |
|  69 | `migration-up-nullability/batch-key-required`                              | 删除 `batch_key NOT NULL`   | 同上                                      | killed |
|  70 | `migration-up-nullability/item-key-required`                               | 删除 `item_key NOT NULL`    | 同上                                      | killed |
|  71 | `migration-up-nullability/customer-id-required`                            | 删除 `customer_id NOT NULL` | 同上                                      | killed |
|  72 | `migration-up-nullability/asset-id-required`                               | 删除 `asset_id NOT NULL`    | 同上                                      | killed |
|  73 | `migration-up-nullability/nameserver-change-id-required`                   | 删除 change FK 列 NOT NULL  | 同上                                      | killed |
|  74 | `migration-up-nullability/operation-required`                              | 删除 operation NOT NULL     | 同上                                      | killed |
|  75 | `migration-up-nullability/event-required`                                  | 删除 event NOT NULL         | 同上                                      | killed |
|  76 | `migration-up-nullability/occurred-at-required`                            | 删除 occurred_at NOT NULL   | 同上                                      | killed |
|  77 | `migration-up-nullability/updated-at-required`                             | 删除 updated_at NOT NULL    | 同上                                      | killed |
|  78 | `migration-up-nullability/created-at-required`                             | 删除 created_at NOT NULL    | 同上                                      | killed |
|  79 | `migration-up-foreign-key/customer-foreign-key`                            | 删除 customer 外键          | 同上                                      | killed |
|  80 | `migration-up-foreign-key/asset-foreign-key`                               | 删除 asset 外键             | 同上                                      | killed |
|  81 | `migration-up-foreign-key/nameserver-change-foreign-key`                   | 删除 change 外键            | 同上                                      | killed |
|  82 | `migration-up-unique/event-key-unique`                                     | UNIQUE 降为普通索引         | 同上                                      | killed |
|  83 | `migration-up-index/batch-key-index`                                       | 删除 batch_key 索引         | 同上                                      | killed |
|  84 | `migration-up-index/item-key-index`                                        | 删除 item_key 索引          | 同上                                      | killed |
|  85 | `migration-up-index/customer-index`                                        | 删除 customer 索引          | 同上                                      | killed |
|  86 | `migration-up-index/asset-index`                                           | 删除 asset 索引             | 同上                                      | killed |
|  87 | `migration-up-index/nameserver-change-index`                               | 删除 change 索引            | 同上                                      | killed |
|  88 | `migration-up-index/reason-code-index`                                     | 删除 reason 索引            | 同上                                      | killed |
|  89 | `migration-up-index/occurred-at-index`                                     | 删除 occurred 索引          | 同上                                      | killed |
|  90 | `migration-up-index/trace-id-index`                                        | 删除 trace 索引             | 同上                                      | killed |
|  91 | `migration-up-index/updated-at-index`                                      | 删除 updated 索引           | 同上                                      | killed |
|  92 | `migration-up-index/created-at-index`                                      | 删除 created 索引           | 同上                                      | killed |
|  93 | `migration-up-index/batch-occurred-at-index`                               | 删除批次时间复合索引        | 同上                                      | killed |
|  94 | `migration-up-index/customer-occurred-at-index`                            | 删除客户时间复合索引        | 同上                                      | killed |
|  95 | `migration-down-cleanup/down-events-table`                                 | DOWN 不删除事件表           | 同上                                      | killed |
|  96 | `migration-down-cleanup/down-provider-enum-exact`                          | DOWN 保留新增 provider 枚举 | 同上                                      | killed |
|  97 | `migration-down-cleanup/down-type-domain-batch-operation-events-operation` | DOWN 不删操作枚举           | 同上                                      | killed |
|  98 | `migration-down-cleanup/down-type-domain-batch-operation-events-event`     | DOWN 不删事件枚举           | 同上                                      | killed |
|  99 | `release-metadata/release-policy-entry-exact`                              | policy migration 名漂移     | `verify-d9d3-release-metadata.mjs`        | killed |
| 100 | `release-metadata/release-policy-new-code-compatible-before-up`            | 放宽迁移前启用新代码        | 同上                                      | killed |
| 101 | `release-metadata/release-policy-old-code-compatible`                      | 错标旧代码不兼容            | 同上                                      | killed |
| 102 | `release-metadata/release-policy-expand-phase`                             | expand 错标 data            | 同上                                      | killed |
| 103 | `release-metadata/release-policy-specific-reason`                          | 兼容理由退化为泛称          | 同上                                      | killed |
| 104 | `release-metadata/release-policy-retain-rollback`                          | rollback 错标 down          | 同上                                      | killed |
| 105 | `release-metadata/release-manifest-entry-exact`                            | manifest 名称/顺序漂移      | 同上                                      | killed |

## 指定场景与并发证据

| 要求                    | 独立行为用例                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| DNS 预览后新增一条      | `rejects preview drift when the execution target set adds one record`                                                                            |
| DNS 预览后删除一条      | `rejects preview drift when the execution target set removes one record`                                                                         |
| DNS 预览后修改一条      | `rejects preview drift when one selected record is modified`                                                                                     |
| NS 预览后新增/删除/修改 | `rejects preview drift when one asset is added...`、`removed...`、`one asset versioned fact is modified`                                         |
| 另一域名/另一用户 token | DNS 的 `another domain owned by the same customer`、`issued to another customer`；NS 的 `another customer and domain set`                        |
| 条目幂等/provider 次数  | `replays completed batch items...without another offline submission`，精确断言离线 submit 次数                                                   |
| 提交不等于成功          | `keeps accepted offline deletions pending until queried`，确认无 `confirmed` 本地事实；queued/不明仍 pending_query                               |
| partial 与逐条原因      | `returns six-state partial with per-item success and explicit failure reasons`；NS 入队失败原因后续查询仍保留                                    |
| A4 缺授权/预览/确认     | DNS `requires step-up and a bound preview`；NS 三条 `without dry-run/step-up/secondary confirmation`                                             |
| D9-D-2 归属阻断         | DNS 每条离线任务拒绝；NS 每条 worker 经 D6 拒绝且 `changeNameservers` 调用 0 次                                                                  |
| 同批次 N 路并发         | DNS `submits each item exactly once across N concurrent submissions...`；NS `queues each item exactly once for N concurrent submissions...`，N=5 |
| 同条目 N 路并发         | DNS `atomically submits one offline task for N concurrent executions...`，N=5；NS 两个并发批次共享条目只入队一次                                 |

所有计数查询均带 customer、asset、batch、operation、workflow、trace 或 change ID 等目标 `where`/SQL
谓词；没有使用全表计数作为断言。

## A4 风险档位逐项自查

| 操作                     | A4 结论                       | 实现结论                                                                                                          |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| DNS 批量删除             | 批量删除 = step-up + 变更预览 | 要求 `dns_bulk_delete` grant；HMAC 绑定 customer、asset、domain、完整记录 ID 与内容摘要；新增/删除/修改漂移均拒绝 |
| Name Server 批量修改     | NS = step-up + 二次确认       | 要求 `nameserver_change` grant 与 `confirmed=true`；本切片额外要求 HMAC dry-run，绑定完整资产版本事实和目标 NS    |
| DNS/NS 批次状态查询      | owner-scoped 当前会话读       | 复用 A3，按 customer + asset/batch 查询；只驱动已提交条目查询，不产生新写提交                                     |
| 离线 DNS task acceptance | 非成功终态                    | 仅落 `pending_query`；明确记录状态 3 后才确认，查询失败/未知继续 pending_query                                    |

A5 冷静期由既有 `authorizeStepUpGrant` 内部调用链继续执行；没有新建授权或冷静期实现。所有测试均使用
fixture，`ALLOW_REAL_WESTDIGITAL*`、`ALLOW_REAL_WESTDIGITAL_DNS_WRITES` 和总 provider 写闸保持 false；没有
访问生产、部署或发生真实 provider 写入。
