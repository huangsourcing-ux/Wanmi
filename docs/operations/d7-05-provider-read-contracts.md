# D7-05 provider 预算持久化与只读真实联调记录

日期：2026-08-09（America/New_York）

状态（最新事实）：**预算持久化已完成；WestDigital、私有 OSS、Wechat Pay 和生产应用主密钥注入已有真实证据，生产 ECS 已注入三类 provider 运行配置；短信因签名、两类模板和测试号码仍未配置而未完成。** 四类尚未齐备，本记录不构成开发计划 11.1 第 2 项完成证据，该项保持未勾选。

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

## 8. D7-12 剩余契约与主密钥注入验证（2026-08-12～13 EDT / 2026-08-13 UTC）

本轮先在本地契约环境和目标 ECS 当前运行容器执行脱敏预检。下表只记录开关布尔值或配置状态，没有读取或输出凭据值、密钥内容、PEM 路径内容、手机号或云资源标识。

| 开关/配置                               |                本地契约环境 |           目标 ECS 运行容器 |
| --------------------------------------- | --------------------------: | --------------------------: |
| `ALLOW_REAL_PROVIDER_WRITES`            |                     `false` |                     `false` |
| `ALLOW_REAL_WECHATPAY`                  |                     `false` |                     `false` |
| `ALLOW_REAL_WECHATPAY_PAYMENTS`         |                     `false` |                     `false` |
| `ALLOW_REAL_WECHATPAY_REFUNDS`          |                     `false` |                     `false` |
| `ALLOW_REAL_ALIYUN_SMS_SENDS`           |                     `false` |                     `false` |
| `WECHATPAY_MODE`                        | `configured` (`live=false`) | `configured` (`live=false`) |
| `WECHATPAY_APP_ID`                      |                `configured` |                   `missing` |
| `WECHATPAY_MERCHANT_ID`                 |                `configured` |                   `missing` |
| `WECHATPAY_API_V3_KEY`                  |                `configured` |                   `missing` |
| `WECHATPAY_MERCHANT_CERTIFICATE_SERIAL` |                `configured` |                   `missing` |
| `WECHATPAY_MERCHANT_PRIVATE_KEY_PATH`   |                `configured` |                   `missing` |
| `WECHATPAY_PLATFORM_CERTIFICATE_SERIAL` |                `configured` |                   `missing` |
| `WECHATPAY_PLATFORM_PUBLIC_KEY_PATH`    |                `configured` |                   `missing` |
| `WECHATPAY_NOTIFY_URL`                  |                `configured` |                   `missing` |

`ALLOW_REAL_WECHATPAY_PAYMENTS` 与 `ALLOW_REAL_WECHATPAY_REFUNDS` 在两个环境均为 `false`，硬停止条件未触发。负责人先补充的商户材料经本地校验确认：商户号与证书主体一致，商户证书序列号一致，RSA 私钥与证书公钥匹配，证书当前有效，API v3 key 精确 32 字节。随后提供的微信支付公钥可解析为至少 2048-bit RSA 公钥，与 `PUB_KEY_ID_...` 形态的公钥 ID 一并完成本地注入；至此本地 8 项微信配置均为 `configured`。证书目录权限为目录 `0700`、文件 `0600`，并仅在本机排除版本控制；配置文件同样不进入版本控制。目标 ECS 没有注入这组待轮换的微信材料。运行模式保持 fixture；真实查单只在一次性进程中临时启用总闸、微信 provider 闸和 live 模式，两个资金写闸始终为 `false`。收尾时资金写闸、短信发送闸、微信 provider 闸和总闸均为 `false`。

### 8.1 Wechat Pay 不存在订单查单

最初为判定旧平台证书是否仍可下载，使用微信支付官方 CertificateDownloader 以同一商户 RSA-SHA256 签名只读调用证书列表接口；接口返回 HTTP `403`、真实错误码 `NOT_ENOUGH`，语义为平台证书已过期失效，耗时 3,497 ms，且没有生成平台证书。该结果仅保留为证书模式不可用的前置证据。

补齐微信支付公钥 ID/文件并通过本地解析、权限与 Git 排除检查后，一次性契约脚本经既有 provider factory 对随机生成的不存在商户订单号执行只读查单。证据完整的一次调用返回 HTTP `404`，耗时 2,715.5 ms；真实响应字段为 `code`、`message`，错误码为 `ORDER_NOT_EXIST`。非 2xx 响应先通过微信支付公钥验签和响应 `Wechatpay-Serial` 匹配，随后才进入错误映射，因此适配器返回非验签错误本身也证明验签与序列号匹配通过。微信接受了请求并返回商户订单语义，商户 RSA-SHA256 请求签名通过。

| 验证项                         | 真实结果                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 目标请求                       | 不存在商户订单号只读查单；证据完整调用 `1` 次                                                                         |
| 真实响应字段与 Zod schema 差异 | `code`, `message`；现有非 2xx schema 要求 `code` 并允许透传其他字段，无字段差异                                       |
| 真实错误码与既有映射差异       | HTTP `404` / `ORDER_NOT_EXIST`；原实现映射为通用 `WECHATPAY_REQUEST_REJECTED`，记录后改为 `WECHATPAY_ORDER_NOT_FOUND` |
| 响应时间                       | 2,715.5 ms                                                                                                            |
| 商户 RSA-SHA256 请求签名       | 通过                                                                                                                  |
| 微信响应验签/序列号匹配        | 通过/匹配                                                                                                             |
| 验签模式                       | 微信支付公钥模式                                                                                                      |
| 下单/支付/退款次数             | `0/0/0`                                                                                                               |

真实错误语义与既有通用映射不一致，故先完成上述记录，再把 `ORDER_NOT_EXIST` 仅在 `GET /v3/pay/transactions/out-trade-no/...` 路径映射为 `WECHATPAY_ORDER_NOT_FOUND`；其他请求错误和退款映射不变。新增签名 fixture 以 HTTP `404`、`code/message` 和 `ORDER_NOT_EXIST` 覆盖该真实语义，自动化测试仍不访问真实接口。命令编排中另有一次已确认发出的同类只读 GET 因 shell 状态变量冲突丢失记录，还有一次失败调用无法确认是否到达上游；因此本轮实际只读 GET 数为至少 `2`、最多 `3`，没有隐瞒重试，也没有任何写请求。

### 8.2 阿里云短信

`ALLOW_REAL_ALIYUN_SMS_SENDS=false`，且目标 ECS 的测试号码、凭据、Region、签名、OTP 模板和到期模板均为 `missing`；当前短信模式也不是 live。因此本轮走不发送分支，既有 `validateAliyunSmsLiveConfiguration` 不能通过，live provider 不能正确构造；本轮只完成了门禁与缺项预检，不用 fixture 冒充配置加载或真实发送。

| 验证项                                      | 真实结果                             |
| ------------------------------------------- | ------------------------------------ |
| 凭据/签名/模板配置加载                      | 未通过；配置缺失                     |
| live provider 构造                          | 未通过；配置缺失且模式非 live        |
| 走既有 OTP 路径与四维限频                   | 未执行；无获授权测试号码且发送闸关闭 |
| 真实返回字段、BizId/RequestId、错误码与时延 | N/A                                  |
| 回执对账                                    | N/A                                  |
| 本轮短信发送数                              | **0**                                |

短信项记为**部分完成（预检完成）**；尚缺受控真实凭据/签名/模板配置加载证据，以及向负责人提供测试号码的恰好一条 OTP 真实发送与可用时回执证据。

### 8.3 目标 ECS 生产应用主密钥注入

目标 ECS 已在运行，本轮无需重建，因此重建耗时单独记为 **0 秒**，不修改 D7-11 的 RTO 数字。一次性脱敏探针在当前运行 Web 容器中复用生产 `getEnv`、`createRealnameDocumentMasterKeyring`和 `WANMI-RN1` 证件信封加解密实现，直接使用 ECS 已注入的应用主密钥环境。探针不输出 key ring、密钥值或临时对象路径。

| 验证项                            | 真实结果                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `getEnv` 完整校验                 | 通过；版本名合法、无重复版本、标准 Base64、解码后精确 32 字节、active version 存在于 ring |
| active version                    | `prod-20260811-v2`                                                                        |
| 新证件信封对象使用 active version | 通过                                                                                      |
| 加密后解密回原文                  | 通过                                                                                      |
| 临时对象精确清理                  | 通过                                                                                      |
| 探针端到端耗时                    | 7.727 s                                                                                   |

该分项通过。探针仅在 ECS 容器临时文件系统创建并删除本轮唯一的加密证件信封对象，未访问 Bucket；私有 OSS 的真实往返与 exact-key 清理证据仍以 D7-10 为准。

### 8.4 结论与收尾

WestDigital、私有 OSS、Wechat Pay 不存在订单查单和生产应用主密钥注入已有真实证据；短信仍缺真实配置/发送证据。因此开发计划 11.1 第 2 项**保持未勾选**，11.1 第 13 项及所有生产硬门槛未修改。

本地收尾完全使用 fixture/mock 和一次性随机测试主密钥，12 个真实 provider 能力闸显式为 `false`。商户材料补充前的完整 `make check` 已通过 639/639 单元与 105/105 集成。真实语义映射补充后，前两次重跑分别因测试 shell 未注入主密钥、临时 key ring 分隔符错误而在生成类型前 fail-closed，没有进入测试或真实接口；改为正确的一次性随机 `version:base64` 测试 key ring 后从头重跑，最终退出码 0：88 个文件 640/640 单元测试、28 个文件 105/105 PostgreSQL/MinIO 集成测试、全部 migration 往返、lint、TypeScript strict、Next.js 生产构建、linux/amd64 同镜像构建、Node audit、工作树/161 个提交完整历史 Gitleaks 与 Trivy 均通过。没有把真实联调写成 CI 测试，`verify-provider-write-policy` 未削弱。

一次云 CLI 诊断请求超时时，CLI 的错误路径将本应脱敏的请求元数据写入了瞬时代理工具输出；本记录、代码库和 PR 不包含该值，后续命令也已关闭 CLI 原始标准错误并只保留白名单状态。负责人提供的配置附件还包含完整商户私钥和 API v3 key，两者应视为已披露，不能作为生产长期凭据；补齐微信支付公钥前后均须轮换商户 API 证书/私钥和 API v3 key。负责人应在本轮后复核所有真实能力闸为 `false`，并轮换已被列为必须轮换的云/provider 凭据。

## 9. D7-13 生产 ECS 注入与部署侧补证（2026-08-13）

### 9.1 注入、权限与重启

目标部署在开工时已经运行，Nginx、Web、Worker 与 `/readyz` 均健康，因此没有执行 `make rebuild`；重建耗时单独记为 **0 秒**，不修改 D7-11 RTO。运行时环境文件在仓库检出目录之外，属主 root、权限 `0600`；两份 PEM 同样位于仓库外、权限 `0600`，属主收敛到生产镜像声明的非 root 运行身份，使 Web/Worker 可读而其他本机用户不可读。配置通过环境文件进入当前 shell，Docker 仅使用 `--env NAME` 传递变量名；没有把值放入 Docker 参数、镜像层或持久日志。

8 项 Wechat Pay 配置、WestDigital 只读配置和私有 OSS 配置均为 `configured`。项目负责人本轮明确决定不轮换微信商户私钥与 API v3 key，并以微信支付侧 IP 白名单作为补偿控制；本次按该决定注入现有材料。该决定只取代 D7-12 对这两项微信材料的轮换提醒，不代表其他已披露云/provider 凭据或主密钥离线备份门槛完成。

Web 与 Worker 仅精确重建这两个既有容器，保留同一 digest、网络、资源限制、日志轮转和 Worker `commerce --limit 1` 参数，并把两个 PEM 只读挂载；重启耗时 **35 秒**。重启后 Web/Worker 同 digest，Nginx health 与数据库-backed `/readyz` 均通过。运行配置、PEM 或任何资源标识均未写入仓库。

### 9.2 ECS 开工前预检

以下为 ECS 持久运行配置在任何一次性覆写之前的脱敏结果；只记录布尔值或配置状态：

| 名称                                    | 结果         |
| --------------------------------------- | ------------ |
| `ALLOW_REAL_PROVIDER_WRITES`            | `false`      |
| `ALLOW_REAL_WECHATPAY`                  | `false`      |
| `ALLOW_REAL_WECHATPAY_PAYMENTS`         | `false`      |
| `ALLOW_REAL_WECHATPAY_REFUNDS`          | `false`      |
| `ALLOW_REAL_ALIYUN_SMS_SENDS`           | `false`      |
| `WECHATPAY_MODE`                        | `configured` |
| `WECHATPAY_MERCHANT_ID`                 | `configured` |
| `WECHATPAY_APP_ID`                      | `configured` |
| `WECHATPAY_MERCHANT_CERTIFICATE_SERIAL` | `configured` |
| `WECHATPAY_MERCHANT_PRIVATE_KEY_PATH`   | `configured` |
| `WECHATPAY_API_V3_KEY`                  | `configured` |
| `WECHATPAY_NOTIFY_URL`                  | `configured` |
| `WECHATPAY_PLATFORM_CERTIFICATE_SERIAL` | `configured` |
| `WECHATPAY_PLATFORM_PUBLIC_KEY_PATH`    | `configured` |

两个资金写闸均为 `false`，硬停止条件未触发。一次性进程只临时开启总闸和微信 provider 闸以允许只读查单；没有开启下单、支付或退款闸。

### 9.3 从 ECS 发起的 Wechat Pay 查单

一次性脚本在生产 digest 的业务源码上，对随机生成且不存在的商户订单号发起 **1 次**只读查单。前序执行器与文件权限诊断均在 provider 构造或 transport 之前失败，没有产生上游请求；修正为 PEM `0600` 且由容器运行身份持有后，唯一真实请求取得完整证据：

| 验证项                   | ECS 真实结果                                                |
| ------------------------ | ----------------------------------------------------------- |
| HTTP/真实错误码          | `404` / `ORDER_NOT_EXIST`                                   |
| 真实响应字段             | `code`, `message`                                           |
| 与 Zod schema 的差异     | 无；非 2xx schema 要求 `code` 并允许透传 `message`          |
| 与既有错误映射的差异     | 无；D7-12 已将该查单语义映射为 `WECHATPAY_ORDER_NOT_FOUND`  |
| 商户 RSA-SHA256 请求签名 | 通过；微信接受请求并返回订单语义                            |
| 响应验签/公钥 ID 匹配    | 通过/匹配                                                   |
| 验签模式                 | 微信支付公钥模式                                            |
| 响应时间                 | 316.3 ms                                                    |
| IP 白名单实际行为        | ECS 来源被接受；未返回 IP 白名单拒绝，无需补充本次 ECS 来源 |
| 下单/支付/退款           | `0/0/0`                                                     |

真实语义与 D7-12 已修正的实现一致，本轮没有再改 Zod schema、错误映射或 fixture，也没有修改断言迁就上游。

### 9.4 生产应用主密钥与真实证件对象

复用 D7-09 的真实私有 OSS 证件对象恢复路径，直接使用 ECS 注入的 key ring：`getEnv` 对版本名合法性、重复版本、标准 Base64、解码后精确 32 字节和 active membership 的完整校验通过。随机新对象使用 active version `prod-20260811-v2` 加密；对象普通删除后，通过移除本轮 delete marker 恢复原版本，并严格按对象记录的原主密钥版本解密回原文。最后只清理本轮精确键的全部版本与删除标记，零残留复查通过。记录不包含 key ring、密钥值、对象键、Bucket、端点或路径。

生产主密钥的离线双人备份仍由负责人完成，本轮不代为标记完成。

### 9.5 短信分支

`ALLOW_REAL_ALIYUN_SMS_SENDS=false`，且 `WANMI_CONTRACT_TEST_PHONE=missing`，因此严格走不发送分支。ECS 可加载云访问凭据与 Region，但短信签名、OTP 模板和到期模板均为 `missing`；一次性配置校验返回失败，live provider 不能正确构造。没有从账号内候选签名/模板推测或替负责人选择配置，没有进入 OTP 发送路径或绕过四维限频。

| 验证项                        | 结果                              |
| ----------------------------- | --------------------------------- |
| 凭据与 Region                 | `configured`                      |
| 签名、OTP 模板、到期模板      | `missing` / `missing` / `missing` |
| 测试号码                      | `missing`                         |
| 配置加载/live provider 构造   | 未通过；缺少签名和两类模板        |
| BizId/RequestId、回执与响应码 | N/A；没有发送                     |
| 本轮短信发送数                | **0**                             |

短信项为**部分完成**，仍缺负责人明确选定并注入的真实签名、OTP/到期模板，以及在发送闸明确开启且提供测试号码后，通过既有 OTP 路径和四维限频发送恰好一条并在可用时取得回执的证据。

### 9.6 收尾、勾选与长期闸建议

一次性容器和探针文件均已清理。ECS 运行配置、Web、Worker 与开发机两侧的 12 个真实能力闸最终全部为 `false`；Web/Worker 同 digest，Nginx health 与 `/readyz` 仍通过。请负责人再次核对这些实际布尔值。

当前尚未取得最终生产上线批准，建议所有能力闸继续保持 `false`。正式启用时由负责人按功能逐项决定：只读 WestDigital 需要总闸、provider 闸和只读闸；私有证件 OSS 需要总闸与私有 OSS 闸；Wechat Pay 收款需要总闸、微信 provider 闸和支付闸；真实短信登录需要总闸与短信发送闸；退款和西部数码四类写闸只在对应业务、预算、白名单与上线门槛全部批准后开启。这里仅给出依赖关系，没有替负责人改变任何长期运行开关。

D7-10 的 WestDigital/私有 OSS、D7-12 与本轮 ECS 查单、以及本轮生产主密钥真实对象证据均有效；短信仍没有配置加载/真实发送证据。因此 11.1 第 2 项**保持未勾选**，第 13 项及任何生产硬门槛均未修改。

## 10. D7-14 短信契约（2026-08-13）

首次执行前同时检查 ECS 运行容器和仓库外持久运行配置，二者结果一致：

| 名称                                            | 结果      |
| ----------------------------------------------- | --------- |
| `ALIYUN_SMS_MODE`                               | `mock`    |
| `ALLOW_REAL_PROVIDER_WRITES`                    | `false`   |
| `ALLOW_REAL_ALIYUN_SMS_SENDS`                   | `false`   |
| `ALIBABA_CLOUD_SMS_SIGN_NAME`                   | `missing` |
| `ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE`           | `missing` |
| `ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE` | `missing` |
| `WANMI_CONTRACT_TEST_PHONE`                     | `missing` |

硬预检不通过，按约束立即停止。没有以负责人提供的单个模板编号推测两个不同用途的模板配置，没有临时切换 live 模式或开启能力闸，没有进入 OTP 服务、四维限频或 provider transport；首次预检阶段短信发送数为 **0**。

负责人随后提供了独立到期提醒模板配置。签名、OTP 模板、到期提醒模板和测试号码经仓库外 root-only 运行配置安全注入；记录、日志和提交物均未保存其值。一次性、无自动重启的 Web 容器在执行前确认：

| 名称                                            | 结果         |
| ----------------------------------------------- | ------------ |
| `ALIYUN_SMS_MODE`                               | `live`       |
| `ALLOW_REAL_PROVIDER_WRITES`                    | `true`       |
| `ALLOW_REAL_ALIYUN_SMS_SENDS`                   | `true`       |
| `ALIBABA_CLOUD_SMS_SIGN_NAME`                   | `configured` |
| `ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE`           | `configured` |
| `ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE` | `configured` |
| `WANMI_CONTRACT_TEST_PHONE`                     | `configured` |

### 10.1 唯一一次 OTP 服务路径尝试

从该一次性 Web 容器内向既有 `/api/v1/auth/sms/request` 发起恰好 1 个请求，号码为“负责人提供的测试号码”。请求通过共享 Zod 输入校验、Payload 服务和手机号/IP/设备/全局四维限频后创建 challenge，并调用 live provider；没有直接调用 SDK，也没有绕过任一门禁。真实结果：

- 服务层发送尝试数：**1**；被 provider 接受数：**0**；成功发送证据数：**0**；重试数：**0**。本切片没有第二次发送。
- HTTP 状态：`503`；稳定错误码：`SMS_UNAVAILABLE`；响应时间：339.4 ms；未返回 challengeId。
- 实际响应字段：`action`、`code`、`detail`、`message`、`retryable`、`status`、`title`、`traceId`、`type`。这些字段可由现有 `problemDetailsSchema` 完整验证，没有 schema 差异。
- 数据库脱敏核对：`deliveryStatus=failed`、provider 映射码 `SMS_PROVIDER_UNAVAILABLE`、`sentAt` 已记录；provider message ID/BizId 缺失，provider request ID 是适配器本地生成的关联 UUID，不是可作为真实阿里云 RequestId 形态证据的值。
- 只读 ActionTrail 在执行时间窗内未找到 `SendSms` 事件。因此原始阿里云响应字段、原始错误码、BizId 和真实 RequestId 均不可观察；不得推测为签名、模板或其他具体错误。现有适配器把 SDK 异常统一归为 `SMS_PROVIDER_UNAVAILABLE`，服务层再稳定映射为 `SMS_UNAVAILABLE`。没有拿到与既有 `SIGN_NAME_ILLEGAL` / `template_unapproved` 映射对比所需的真实原始码，故未修改实现、断言或 fixture。
- 到期提醒模板已由 live provider 配置校验加载，但按约束没有发送。由于没有 BizId/accepted 状态，不具备回执查询输入，回执对账状态与结果均为不适用。

### 10.2 恢复与完成判断

唯一尝试后立即删除两个一次性 live 容器，并删除 ECS 临时脚本/配置、开发机临时配置、一次性 SSH 私钥与对应 ECS 授权项；这些临时材料不可恢复。生产 Web 与 commerce Worker 随后用仓库外持久配置重新创建，二者运行于同一镜像，Worker 保持 `commerce` 队列并发 1，`/readyz` 返回 2xx。生产 Web/Worker 均确认四项短信配置为 `configured`；ECS 持久配置、两个生产容器和开发机最终状态如下：

| 名称                          | ECS 持久配置 | 生产 Web | 生产 Worker | 开发机  |
| ----------------------------- | ------------ | -------- | ----------- | ------- |
| `ALIYUN_SMS_MODE`             | `mock`       | `mock`   | `mock`      | `mock`  |
| `ALLOW_REAL_PROVIDER_WRITES`  | `false`      | `false`  | `false`     | `false` |
| `ALLOW_REAL_ALIYUN_SMS_SENDS` | `false`      | `false`  | `false`     | `false` |

额外复核 ECS Web/Worker 与开发机全部 12 个能力闸均为 `false`，一次性 live 容器为 0。负责人应继续核对这些恢复状态；在取得最终上线批准前建议维持关闭，是否长期开启由负责人另行决定。

本地最终回归使用一次性随机测试主密钥、`WECHATPAY_MODE=fixture`、`WESTDIGITAL_MODE=fixture`、短信/私有 OSS mock 和显式关闭的 12 个真实能力闸执行完整 `make check`，退出码 0：88 个文件 640/640 单元测试、28 个文件 105/105 PostgreSQL/MinIO 集成测试、全部 migration 空库/升级/回滚往返、bootstrap/generated/Nginx/operations/rebuild/release/provider-write-policy 门禁、lint、TypeScript strict、Next.js 生产构建、linux/amd64 同镜像构建、依赖审计、工作树与 165 个提交完整历史 Gitleaks、Trivy 均通过。第一次本地门禁调用把微信 fixture 枚举误写为不存在的 `mock`，在 `verify-generated` 的 `getEnv` 校验阶段即停止；修正为 `fixture` 后从头完整重跑并通过，全程没有真实 provider 调用。自动化仍完全依赖 fixture/mock，真实短信尝试没有写入 CI 测试，provider 写策略未削弱。

D7-10 西部数码/私有 OSS、D7-13 ECS 微信查单与生产主密钥证据仍有效，但本轮没有得到短信被 provider 接受或真实发送成功证据。故 11.1 第 2 项**继续保持未勾选**，第 13 项及生产硬门槛未修改。若要补齐，只能先查明本次 SDK 异常的上游原因，再在新的、明确授权的切片执行一次新的真实发送；本切片不得重试。

## 11. D7-15 短信 endpoint 假设验证停止记录（2026-08-13）

本轮先按要求执行只读验证，未调用短信 API。阿里云官方 [短信 API 集成说明](https://help.aliyun.com/zh/sms/getting-started/use-sms-api/) 与 [TypeScript SDK 示例](https://help.aliyun.com/zh/sms/developer-reference/using-typescript-openapi-example) 均使用集中式公网端点。仓库锁定的短信 SDK 自身声明 `central` 端点规则；用当前实现只提供 Region 构造客户端时，SDK 已解析到该集中式端点，并未拼接区域化主机。

ECS 内使用生产 Web 镜像、当前短信 SDK 和当前运行环境执行只读探针，结果如下。探针只构造客户端并做 DNS 解析，短信 API 调用数为 **0**：

| 验证项                        | 结果    |
| ----------------------------- | ------- |
| 官方集中式端点可解析          | `true`  |
| SDK 实际目标为官方集中式端点  | `true`  |
| SDK 实际目标可解析            | `true`  |
| 区域化候选主机可解析          | `false` |
| 区域化候选主机是 SDK 实际目标 | `false` |
| 本轮短信 API 调用数           | **0**   |
| 本轮 OTP 服务发送尝试数       | **0**   |
| provider 接受数/成功证据数    | **0/0** |

因此，“只传 Region 会让 SDK 使用不可解析的区域化短信主机”这一根因假设被实际 SDK 行为否定。虽然构造出的区域化候选主机确实不能解析，但当前 SDK 不使用它；不能据此新增 endpoint 配置或修改错误映射。按 D7-15 停止规则，本轮没有修改短信 provider、`.env.example`、fixture 或断言，没有部署新镜像，也没有执行新的真实发送。

同一只读检查发现当前生产 Web 与 commerce Worker 的运行环境状态一致：

| 名称                                            | 生产 Web     | 生产 Worker  |
| ----------------------------------------------- | ------------ | ------------ |
| `ALIYUN_SMS_MODE`                               | `mock`       | `mock`       |
| `ALLOW_REAL_PROVIDER_WRITES`                    | `false`      | `false`      |
| `ALLOW_REAL_ALIYUN_SMS_SENDS`                   | `false`      | `false`      |
| `ALIBABA_CLOUD_ACCESS_KEY_ID`                   | `missing`    | `missing`    |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET`               | `missing`    | `missing`    |
| `ALIBABA_CLOUD_REGION_ID`                       | `missing`    | `missing`    |
| `ALIBABA_CLOUD_SMS_SIGN_NAME`                   | `configured` | `configured` |
| `ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE`           | `configured` | `configured` |
| `ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE` | `configured` | `configured` |
| `WANMI_CONTRACT_TEST_PHONE`                     | `configured` | `configured` |

当前运行环境缺少云访问凭据与 Region，足以阻止当前容器发起经过认证的短信请求；但 D7-14 使用的一次性 live 容器已按当时的清理要求删除，原始 SDK 异常又被现有适配器归并，因此不能反推这些缺项就是 D7-14 的历史根因。记录只保留当前事实，不作推测。

另发现 commerce Worker 当前处于重启循环且重启计数非零；这是独立运行异常，不构成 endpoint 假设的证据。本轮因假设已被否定而按规则停止，没有扩大授权去修复 Worker 或重新注入运行配置。

收尾复核中，ECS Web/Worker 的 `ALIYUN_SMS_MODE=mock`，总闸、短信闸及其余真实 provider 能力闸全部为 `false`，未曾为本轮临时开启。D7-15 没有新增短信真实发送证据，11.1 第 2 项**继续保持未勾选**；第 13 项和所有生产硬门槛均未修改。
