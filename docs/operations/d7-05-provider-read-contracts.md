# D7-05 provider 预算持久化与只读真实联调记录

日期：2026-08-09（America/New_York）

状态（当日事实）：**预算持久化已完成；四类只读真实联调因生产配置/KMS 外部条件未满足而阻塞。** 本记录不构成开发计划 11.1 第 2 项完成证据，该项保持未勾选。

2026-08-10 后续决策：项目负责人依据本记录中的 `AccountStatus=NotEnabled` 事实，批准 D7-06 移除 KMS 并改用应用自管主密钥。下列 KMS 预检与阻塞结论作为历史证据保留，不再是当前联调前提；当前执行入口已移除 KMS adapter、能力闸和往返检查。

## 1. 本轮安全边界

- 开始前已查阅仓库根目录只读《西部数码业务API接口文档（v2）新.md》的鉴权、`getprice`、`query`、`view` 和 `checkbalance` 章节。
- 仓库默认值、测试 setup 与 CI 均将总闸和全部 provider/能力闸显式固定为 `false`，`verify-provider-write-policy` 会永久检查这三处文件。
- 一次性人工命令要求 `RUN_REAL_PROVIDER_READ_CONTRACTS=D7-05-READ-ONLY`，拒绝 CI，并在构造任何 live transport 前确认西部数码实名/注册/续费/NS、微信下单/退款和短信发送能力闸全部为 `false`。
- OSS 只允许在 `OSS_REALNAME_PREFIX/contract-tests/d7-05/<uuid>.bin` 创建本轮随机测试对象；脚本只读取、签名读取并在 `finally` 删除该对象，不列举或触碰其他对象。
- 脚本不输出余额、域名、Bucket、对象键、商户号、订单号、证书、密钥或响应正文。只记录 HTTP 状态、provider code、字段路径、映射 code、脱敏 request ID 摘要和响应时间。
- 本轮未发送短信，未下单、关单或退款，未调用西部数码任何写接口。

## 2. 预算持久化契约

预算范围固定为：

| Provider    | 能力范围         | 扣减维度                  |
| ----------- | ---------------- | ------------------------- |
| WestDigital | `register_renew` | 操作次数 + 整数分累计金额 |
| Wechat Pay  | `payment`        | 整数分累计金额            |
| Wechat Pay  | `refund`         | 整数分累计金额            |

`provider_write_budgets` 保存跨进程、跨重启累计值，`provider_write_budget_debits` 以 scope 与 operation key 的 SHA-256 摘要唯一记录已扣减操作。扣减与 debit 写入处于同一数据库事务；承重语句使用单条：

```sql
UPDATE provider_write_budgets
SET used_operations = used_operations + $delta,
    used_amount_fen = used_amount_fen + $amount
WHERE scope_key = $scope
  AND used_operations + $delta <= $operation_limit
  AND used_amount_fen + $amount <= $amount_limit
RETURNING id
```

命中 0 行即拒绝并回滚 debit，不使用 Payload `update({ where })` 或读—改—写。相同 operation key 并发重试只允许一笔 debit；不同 amount/delta 复用同一 operation key 会以幂等冲突拒绝。上限仍只来自环境配置，0 或未配置继续 fail-closed。

历史回填依据 D7-04 已留存的“没有发起任何真实调用”证据，将三个 scope 初始化为 0；migration verifier 已覆盖空库、历史升级、约束/索引、down 后对象清理及再次 up 的零值回填。

## 3. 只读真实联调预检事实

本机没有把 provider 凭据写入仓库。当前进程与 `apps/web/.env.local` 未配置 WestDigital、Wechat Pay、私有 OSS、KMS 或短信模板所需生产键值，因此没有绕过 factory 从 CLI 配置偷取密钥。

受控 Aliyun CLI 身份只执行了以下只读预检，输出中的账号、资源名和 request ID 均未保存：

| 预检                                   | 真实响应字段                                           | 结果                                          | 响应时间 |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------------------- | -------: |
| STS `GetCallerIdentity`                | 身份响应未持久化                                       | 鉴权成功                                      |   2.12 s |
| KMS `DescribeAccountKmsStatus`（上海） | `AccountStatus`, `RequestId`                           | `AccountStatus=NotEnabled`                    |   4.55 s |
| OSS Bucket 只读列举                    | `CreationTime`, `Region`, `StorageClass`, `BucketName` | 可见 3 个 Bucket，其中 1 个在上海；名称未记录 |   2.74 s |

KMS 未启用意味着无法取得 `KMS_KEY_ID`，也不能完成 SDK `GenerateDataKey → Decrypt` 往返。虽然当前身份能看到上海 OSS Bucket，本轮仍未上传测试对象：应用环境没有注入明确的 `OSS_REALNAME_BUCKET`/`OSS_REALNAME_ENDPOINT`，且 OSS/KMS 必须作为同一类私有证件契约完整通过，不能拿 CLI 可见性冒充 adapter 联调。

## 4. 接口响应、Zod 与错误映射差异

下表如实记录本轮状态。`N/A` 表示因预检阻塞而没有发起接口调用，不以 fixture 或推测填写真实字段。

| 接口                                 | 实际响应字段                                   | 当前 schema/映射                                                                    | 差异与结论                                                                          |       实际响应时间 |
| ------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -----------------: |
| WestDigital 可售性 `query`           | N/A                                            | `clientid`, `result`, `data[].name/avail/type/price?`                               | 未注入账号/API 密码，未调用                                                         |                N/A |
| WestDigital 价格 `getprice`          | N/A                                            | `clientid`, `result`, `data.proid/buyyear/buyprice/renewprice`                      | 未注入账号/API 密码，未调用                                                         |                N/A |
| WestDigital 域名详情 `view`          | N/A                                            | `clientid`, `result`, `data.id/domain/regdate/expdate/dns1..dns6/registrars?`       | 未注入账号/API 密码与明确的账号内测试域名，未调用                                   |                N/A |
| WestDigital 余额 `checkbalance`      | N/A                                            | `result`, `data.balance/freezemoney`                                                | 未注入账号/API 密码，未调用                                                         |                N/A |
| Wechat Pay 不存在订单查单            | N/A                                            | 成功响应为 payment order schema；签名有效的非 2xx 映射 `WECHATPAY_REQUEST_REJECTED` | 未注入商户号、证书序列、私钥及平台公钥，未调用                                      |                N/A |
| 私有 OSS 测试对象上传/读/签名读/删除 | N/A                                            | adapter 领域结果，无 Zod 网络 envelope                                              | Bucket/endpoint 未明确注入，未调用                                                  |                N/A |
| KMS `GenerateDataKey`/`Decrypt`      | `AccountStatus`, `RequestId`（仅账号状态预检） | SDK 往返要求 `ciphertextBlob/plaintext`                                             | 真实账号状态为 `NotEnabled`，与“已有可用 KMS key”的联调前提不符；实现未因该差异放宽 | 4.55 s（状态预检） |
| 短信配置加载                         | N/A                                            | 要求 AK、Region、签名、OTP 模板、到期模板全部非空                                   | 当前未注入签名/模板配置；未发送短信                                                 |                N/A |

由于目标业务接口尚未调用，本轮没有可比较的 WestDigital/Wechat Pay 真实错误码；实现断言未做任何迁就性修改。KMS 的真实 `NotEnabled` 是本轮新增外部差异；原“启用 KMS 后重试”方案已由 2026-08-10 D7-06 冻结项变更废止。

## 5. 一次性执行入口与补证要求

执行入口为：

```text
pnpm --filter @wanmi/web verify:providers:read-contracts
```

凭据必须由本地环境变量或部署密钥注入。除各 provider 既有配置外，还需显式提供 `WESTDIGITAL_READ_CONTRACT_LOOKUP_DOMAIN` 与属于该 WestDigital 账号的 `WESTDIGITAL_READ_CONTRACT_ASSET_DOMAIN`。运行时只临时开启总闸、西部 provider/只读、微信 provider 和 OSS 闸；所有资金/域名写能力闸及短信发送闸必须保持 `false`。命令会输出脱敏 JSON 契约证据，任何一类失败均返回非零。

补证后必须把本文件第 3、4 节替换为真实四类结果，逐接口记录字段路径、provider code、映射差异和响应时间；确认 OSS 测试对象已删除、短信发送数为 0、西部数码写数为 0、微信写数为 0。四类全部完成前，开发计划 11.1 第 2 项不得勾选。
