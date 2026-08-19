# D9-B-4 资金规则与场景变异矩阵

## 1. 口径

本矩阵只计删除、短路或事实来源替换后，由指定运行时行为断言产生 `AssertionError` 的变异。按调用点
计数，同一守卫在充值、消费、续费、退款或账单不同入口分别变异。源码文本检查不计杀死证据。

执行脚本：

- `node apps/web/scripts/mutate-d9b4-wallet-funds-decisions.mjs`
- `node apps/web/scripts/mutate-d9b4-wallet-funds-migration.mjs`

所有子进程显式设置 `ALLOW_REAL_WECHATPAY=false`、`ALLOW_REAL_WECHATPAY_WRITES=false`，并同时关闭真实
WestDigital 读写；测试 provider 全部使用 fixture。

## 2. 应用判定（106 项）

| 分组                                     |    数量 | 独立行为承重点                                                                                             |
| ---------------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------- |
| policy schema / 每字段调用点             |      32 | 固定 CNY/never/Shanghai/公式、schema/version、三个金额字段每个 schema 调用点、布尔开关、note、两个耦合关系 |
| policy admin / CAS / audit / append-only |       6 | active system_admin、expected/current version、`RETURNING`、单条审计、版本 update/delete 拒绝              |
| runtime/top-up/spend/account cap 调用点  |      10 | 非 CNY、三项上限、充值创建/确认、余额支付、B-1 credit ceiling                                              |
| scenario system boundaries               |       5 | 四个资金场景和共享充值退款入口分别拒绝 customer principal                                                  |
| duplicate source/refund                  |      13 | 两单 ID/customer/account/currency/amount/status/paid/credited/交易号逐字段来源，冻结金额与退款 ceiling     |
| B-1 credit fact source                   |       6 | transaction type/status/account/customer/safe amount/amount equality 独立核验                              |
| ordinary spend/recovery ledger           |       4 | available 原子谓词、负余额开关、recovery 符号和 posted 扣减                                                |
| closure/no-service                       |       4 | active closure key、正余额分支、部分消费来源金额、D5/B-3 dispatch 调用点                                   |
| payment recovery source/CAS/A3/audit     |      13 | 充值证据逐字段、credit 调用点、claim/final key/`RETURNING`、负余额限制值、单条审计                         |
| emergency renewal                        |       3 | 配置开关、唯一限制数量、限制值来源                                                                         |
| statement owner/boundary/integrity/audit |       9 | customer scope、账户 SQL、上海偏移、366 天、start-inclusive、sequence/snapshot/version、审计               |
| refund target hook                       |       1 | refund 必须且只能关联 order 或 top-up 一种目标                                                             |
| **合计**                                 | **106** | **106/106**                                                                                                |

关键独立用例：

- `refunds a duplicate top-up once under concurrent requests and uses the existing WeChat refund path once`
- `routes no-service refunds only from paymentChannel and always uses the frozen order amount`
- `recovers a consumed disputed top-up into a negative balance and immediately disables balance spending`
- `never lets ordinary concurrent deductions create a negative balance`
- `serializes a payment recovery against N normal spends with one recovery and an exact ledger equation`
- `blocks closure on positive balance and permits continuation only after the original refund succeeds`
- `exports opening and closing balances at the fixed Asia/Shanghai day boundary`
- `fails statement export closed when an append-only ledger snapshot is corrupted`

## 3. 数据来源替换与 fixture 去相关

| 来源判定                             | 去相关方式                                                                                                     | 删除/替换后的唯一失败                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 退款渠道只读 `orders.paymentChannel` | balance 订单保留微信 decoy；native 订单移除微信交易号                                                          | no-service 用例必须沿存储渠道 dispatch，不能从交易信号推断                      |
| 重复充值两单事实                     | original 与 duplicate 的 currency、customer、account、amount、status、paid/credited 时间、交易号逐字段单独覆盖 | `reads every duplicate-top-up evidence field independently`                     |
| 退款金额                             | 订单/充值冻结金额与当前余额、provider 返回和 decoy 字段使用不同值                                              | 冻结金额变异分别由 duplicate/no-service/ceiling 用例杀死                        |
| 充值 recovery 与 B-1 credit          | top-up amount 与 transaction amount 分离；type/status/account/customer 分别覆盖                                | `revalidates payment-recovery evidence against the independent B-1 credit fact` |
| recovery claim/finalization          | 实际 DB 状态为 `provider_confirmed` 但读取 fixture 提供 creditedAt；事务内单独篡改 recovery key                | status、零行 `RETURNING`、final key 三项互不代杀                                |
| 三个规则上限                         | 默认值分别为 5,000,000 / 10,000,000 / 3,000,000 分                                                             | 三个越限用例和调用点分别失败，不使用相等 fixture                                |
| 上海日切                             | entry 分别置于 `15:59:59.999Z` 与 `16:00:00.000Z`                                                              | UTC 偏移或 start-exclusive 任一变异改变期初/区间/期末                           |

## 4. Migration 与发布元数据判定（93 项）

| 分组                      |   数量 | 行为验证                                                                                           |
| ------------------------- | -----: | -------------------------------------------------------------------------------------------------- |
| enum                      |      8 | recovery、CNY、never、Shanghai、公式与三个既有 enum 扩展精确匹配                                   |
| policy values/head        |     15 | 版本/schema/金额/耦合/actor/note、固定 head key；删除冗余且被 FK 蕴含的 head 数值约束              |
| recovery ledger           |      4 | recovery transaction posted/unresolved、负数 safe minimum、正 posted 覆盖 held                     |
| refund target/amount      |      4 | exactly-one target；金额整数、正数、不得超过 top-up                                                |
| top-up state evidence     |     38 | created/pending/confirmed/credited 四态 × 四个新增字段，普通退款/追回 pending/refunded 各字段独立  |
| unique/FK                 |      5 | policy version、top-up refund/recovery key 唯一，head 与 refund target FK                          |
| approved seed             |      5 | 三个上限、负余额追回默认开、紧急续费默认关                                                         |
| down fail-closed          |      7 | 额外/篡改 policy、refund、recovery transaction/entry、provider operation、top-up evidence 分别阻断 |
| release policy / manifest |      7 | 精确 migration 名、promotion 顺序、旧代码兼容、expand、具体 reason、retain、manifest 顺序          |
| **合计**                  | **93** | **93/93**                                                                                          |

迁移 verifier 对每个无效写入单独执行真实 PostgreSQL 语句；down 每次只放入一种新事实，避免多个 guard
相关。变异期间曾发现并删除三类逻辑冗余：充值/消费 safe max 已由账户 safe max 与耦合保证，账户正数
已由两个正上限与耦合保证，head 数值范围已由 FK 指向的 policy version 保证。删除后每个保留谓词都能被
单一行为断言杀死。

## 5. 并发与计数限定

- 重复充值退款 N 路：只允许一个 refund、一个 provider create、一个 provider query、一个 refund hold 和
  一个 capture；所有 count 使用 top-up/refund/account/transaction key/status 的 `where`。
- recovery 与普通消费竞争：4 路相同 recovery key 与 8 路独立 hold 同时执行，恰好一条 recovery entry，
  最终方程为 `posted=−成功 hold 总额`、`held=成功 hold 总额`、`available=−成功 hold 总额`。
- 普通消费 N 路：100 分余额并发 12 路各 100 分，只成功 1 路，非 recovery 快照绝不为负。
- policy 更新使用 head `UPDATE ... WHERE current_version ... RETURNING`；并发 stale update 不创建第二个
  current 版本。

最终源状态恢复后，应用矩阵 106/106、migration/发布矩阵 93/93，合计 **199/199**。完整代码门禁另以最终
commit 的 `make check` 和 CI 结论记录，不以变异期间的定向运行替代。
