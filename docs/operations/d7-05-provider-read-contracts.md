# D7-05 provider 预算持久化与只读真实联调记录

日期：2026-08-09（America/New_York）

状态（最新事实）：**预算持久化已完成；WestDigital 与私有 OSS 真实分项已完成，Wechat Pay 与短信按负责人指示暂记 N/A。** 四类尚未齐备，本记录不构成开发计划 11.1 第 2 项完成证据，该项保持未勾选。

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

## 6. D7-07 前置自检追加记录（2026-08-10）

D7-07 开始前再次检查当前运行环境，只判断键是否存在，不输出、复制或持久化任何值。KMS 已由批准的 D7-06 冻结项变更移除，本次第四类前提改为版本化应用主密钥注入。

| 契约类别            | 缺失前提                                                                  | 实际字段/错误码/响应时间 | 结论                                            |
| ------------------- | ------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| WestDigital 只读    | username、API password、lookup domain、账号内 asset domain                | N/A                      | 未调用 `query`/`getprice`/`view`/`checkbalance` |
| Wechat Pay 只读查单 | app/merchant ID、证书序列、API v3 key、商户私钥、平台验签材料、notify URL | N/A                      | 未调用查单                                      |
| 私有 OSS 契约对象   | bucket、endpoint、access key/secret                                       | N/A                      | 未上传、读取、签名或删除对象                    |
| 应用主密钥注入      | `REALNAME_DOCUMENT_MASTER_KEYS` 与 active version                         | N/A                      | 未以临时或推测密钥冒充生产注入验证              |

仓库默认、测试、CI 和本次进程中的 `ALLOW_REAL_PROVIDER_WRITES` 及 WestDigital 注册/续费/实名/NS、Wechat Pay 支付/退款、短信发送、私有 OSS 写入能力闸均保持 `false`。因为四类前提仍不完整，没有执行一次性 `verify:providers:read-contracts`，没有取得可填入第 4 节的真实字段、错误码或响应时间，也没有修改 Zod schema/断言迁就 fixture。开发计划 11.1 第 2 项继续保持未勾选。

## 7. D7-10 分项真实联调记录（2026-08-12）

项目负责人指示先完成 WestDigital 与私有 OSS，Wechat Pay 和短信暂不调用。因此本轮对一次性脚本显式选择 `westdigital`、`aliyun.oss_private`；部分选择输出 `partial` 并返回非零，不能作为四类完整验收证据。执行前只输出能力闸名称与布尔值，状态如下：

| 能力闸                                       |    状态 |
| -------------------------------------------- | ------: |
| `ALLOW_REAL_PROVIDER_WRITES`                 |  `true` |
| `ALLOW_REAL_WESTDIGITAL`                     |  `true` |
| `ALLOW_REAL_WESTDIGITAL_READS`               |  `true` |
| `ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES`     | `false` |
| `ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES` | `false` |
| `ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES`      | `false` |
| `ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES`   | `false` |
| `ALLOW_REAL_WECHATPAY`                       |  `true` |
| `ALLOW_REAL_WECHATPAY_PAYMENTS`              | `false` |
| `ALLOW_REAL_WECHATPAY_REFUNDS`               | `false` |
| `ALLOW_REAL_ALIYUN_OSS_REALNAME`             |  `true` |
| `ALLOW_REAL_ALIYUN_SMS_SENDS`                | `false` |

真实调用结果如下。`N/A` 表示本轮没有调用，不以 fixture 或推测补齐：

| 接口                                             | 真实响应字段/错误                                                                                                                                                                                                  | 当前 schema/映射                                                                                   | 差异与结论                                                                                                                                                        |                   真实响应时间 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------------: |
| WestDigital 可售性 `query`（初次默认 transport） | 无 provider 响应字段；transport `RESTRICTED_ADDRESS`                                                                                                                                                               | adapter 映射为 `WESTDIGITAL_UNAVAILABLE`                                                           | 本机强制代理把系统 DNS 结果映射到保留地址，现有公网地址检查 fail-closed；请求未到达 provider                                                                      |                        17.3 ms |
| WestDigital 可售性 `query`（显式环境代理复测）   | `clientid`, `data[].avail`, `data[].name`, `result`；HTTP/provider code 均为 `200`                                                                                                                                 | `clientid`, `result`, `data[].name/avail/type?/price?` → `available/currency/domainAscii/premium`  | 普通非溢价域名省略本地文档成功示例中的 `type`、`price`，现有 Zod 已正确按 optional 接受；无断言修改                                                               |                      4996.2 ms |
| WestDigital 价格 `getprice`                      | `clientid`, `data.buyprice`, `data.buyyear`, `data.proid`, `data.renewprice`, `result`；HTTP/provider code 均为 `200`                                                                                              | 同名上游字段 → `currency/domainAscii/productId/purchaseYears/registrationPriceFen/renewalPriceFen` | 真实字段与 Zod、本地文档一致                                                                                                                                      |                       956.7 ms |
| WestDigital 域名详情 `view`                      | `clientid`, `data.bizcnorder`, `data.dns1..dns6`, `data.dom_em`, `data.dom_org_cn`, `data.dom_ph`, `data.domain`, `data.expdate`, `data.id`, `data.proid`, `data.regdate`, `result`；HTTP/provider code 均为 `200` | schema 接受必需资产字段并 passthrough；当前 registrar 映射只读取 `registrars?`                     | 真实响应新增本地 `view` 章节未列出的 `data.bizcnorder`；现有实现会忽略该 registrar 语义并回退默认值。已先记录，随后改为显式接受并映射该字段，fixture 覆盖真实语义 |                       522.8 ms |
| WestDigital 余额 `checkbalance`                  | `clientid`, `data.balance`, `data.freezemoney`, `result`；HTTP/provider code 均为 `200`                                                                                                                            | `data.balance/freezemoney` → `availableMinor/frozenMinor`                                          | 真实字段与 Zod、本地文档一致；额外 `clientid` 由 passthrough 安全忽略                                                                                             |                       448.0 ms |
| Wechat Pay 不存在订单查单                        | N/A                                                                                                                                                                                                                | 成功响应为 payment order schema；签名有效的非 2xx 映射 `WECHATPAY_REQUEST_REJECTED`                | 按项目负责人本轮指示暂不调用                                                                                                                                      |                            N/A |
| 私有 OSS 测试对象上传                            | `etag`                                                                                                                                                                                                             | adapter 领域结果，无 Zod 网络 envelope                                                             | 字段一致，上传成功                                                                                                                                                |                      2981.5 ms |
| 私有 OSS 测试对象读取                            | `body[]`, `etag`                                                                                                                                                                                                   | adapter 领域结果，无 Zod 网络 envelope                                                             | 字段一致；读取字节与上传前一致                                                                                                                                    |                       389.1 ms |
| 私有 OSS 测试对象签名读取                        | `url`；HTTP `200`                                                                                                                                                                                                  | adapter 领域结果，无 Zod 网络 envelope                                                             | 签名地址可读，返回字节与上传前一致                                                                                                                                |                      2812.6 ms |
| 私有 OSS 测试对象删除                            | `deleted`                                                                                                                                                                                                          | adapter 领域结果，无 Zod 网络 envelope                                                             | 普通删除成功；因 Bucket 已启用版本控制，随后按本轮时间窗、48 字节大小和 UUID 文件名格式只读锁定唯一测试键，精确移除 1 个对象版本与 1 个删除标记，复查两者均为 0   | 458.8 ms；版本清理与复查 8.7 s |
| 短信配置加载                                     | N/A                                                                                                                                                                                                                | 要求凭据、Region、签名、OTP 模板、到期模板全部非空                                                 | 按项目负责人本轮指示暂不调用；短信发送数为 0                                                                                                                      |                            N/A |

本轮 WestDigital 写入数为 0、Wechat Pay 写入数为 0、短信发送数为 0。私有 OSS 分项通过并完成全部版本清理；一次性脚本已补充相同的 exact-key 全版本清理与清理后 0 残留断言，默认四类全跑行为不变，显式分项执行不能冒充完整验收。WestDigital 四项在显式环境代理路径下全部取得真实成功响应；该路径仍固定目标、TLS 校验与请求路径白名单，生产默认 transport 与公网地址检查不变。Wechat Pay/短信尚未调用，所以 11.1 第 2 项保持未勾选。
