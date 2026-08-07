# 私有实名证件运行手册

## 边界

实名证件只进入 `realnameDocuments` 与 `OSS_REALNAME_BUCKET/OSS_REALNAME_PREFIX`。生产前缀必须以 `private/` 开头，默认是 `private/realname`；Bucket 不得与 `S3_BUCKET` 相同。公共 `media`、`adMedia`、`public/media` 和 `public/advertising` 均不参与证件链路。

对象正文是 `WANMI-RN1` 信封：每个对象通过 KMS `GenerateDataKey` 获取独立 AES-256 数据密钥，正文使用 AES-256-GCM 加密，明文数据密钥只在进程内短暂存在并在使用后清零；KMS 密文数据密钥、IV、认证标签、摘要和版本随密文对象保存，并在受限数据库记录中保留校验副本。浏览器不会获得 OSS object key 或密文对象 URL。

## 配置与写门禁

- `ALIYUN_OSS_REALNAME_MODE=live` 与 `ALIYUN_KMS_MODE=live` 才选择真实 adapter；
- `ALLOW_REAL_PROVIDER_WRITES=false` 时工厂不会构造真实 OSS/KMS client，读、写、签名和删除均 fail-closed；
- `OSS_REALNAME_BUCKET`、`OSS_REALNAME_ENDPOINT`、`OSS_REALNAME_PREFIX` 和 `KMS_KEY_ID` 必须显式配置；
- `REALNAME_DOCUMENT_MAX_BYTES` 默认 10 MiB，最大可配置 20 MiB；
- `REALNAME_DOCUMENT_ACCESS_TTL_SECONDS` 默认 60 秒，允许范围 15～120 秒。

真实凭据只通过运行环境或受控密钥系统注入，不写入仓库。启用真实模式仍须项目负责人明确授权，D4-03 测试不得改变 `ALLOW_REAL_PROVIDER_WRITES=false`。

## RAM 最小权限

为 Wanmi 私有证件建立独立 RAM 身份。OSS 仅授予目标 Bucket 的 `${OSS_REALNAME_PREFIX}/*` 对象 `PutObject`、`GetObject` 和 `DeleteObject`；不授予公共 Bucket、其他前缀、Bucket ACL 修改、策略修改或全局列举权限。KMS 仅对指定 `KMS_KEY_ID` 授予 `GenerateDataKey` 与 `Decrypt`，不授予创建/删除密钥、轮换策略修改或 `kms:*`。

应用层会再次拒绝前缀外 object key、超过 120 秒的 provider 签名请求，以及私有 Bucket 与公共媒体 Bucket 复用。RAM 策略仍是第一道边界，不能用应用校验替代。

## 文件与访问控制

允许类型只有 JPG、PNG、PDF。服务按魔术字节识别，验证图片解码和结构完整性，并重新编码图片以移除元数据和附加负载；同时拒绝追加 polyglot、可执行文件、EICAR 测试签名，以及包含 JavaScript、启动动作、嵌入文件、表单提交、加密或富媒体等主动内容的 PDF。大小在读入后再次校验；扩展名和客户端 `Content-Type` 不参与信任判断。

客户只能读取本人证件的安全元数据。密文位置、KMS 密文数据密钥、IV、认证标签和摘要字段不返回客户。查看或下载前先签发带随机 nonce、客户、证件、操作和过期时间的 HMAC 票据；兑换时再次校验有效 Session、所有权、操作和期限，响应设置 `no-store`、`nosniff`、same-origin 与 sandbox CSP。

上传、查看、下载、提交和删除分别写 `realname.document.*` 审计。审计只含操作、安全文件类型/大小和关联 ID，不含文件正文、object key、访问票据或明文数据密钥。`realnameDocuments` 在 Payload Admin 中隐藏；普通日志的正文、buffer、object key、数据密钥和认证标签字段均强制脱敏。

## 故障处置

- 上传在数据库先进入 `uploading`，OSS 成功后才进入 `active`；失败进入 `upload_failed`，不能签发访问票据。
- 删除先进入 `deleting` 以阻止新访问；OSS 删除失败时恢复 `active` 并返回可重试的安全错误；成功后进入 `deleted`。
- 历史 D0 占位记录迁移后统一为 `upload_failed`，不会被当作已加密可访问对象。
- KMS 解封、GCM 认证、摘要或元数据副本任一不一致均返回通用不可用错误，不回显 provider 原始响应或对象内容。

30 天主存储/备份清理与失败重试 Job 不属于本切片，由 D4-04（开发计划 8.2 第 11 项）实现。生产启用前仍须完成真实 KMS key、私有 Bucket、密钥轮换、删除恢复和告警演练。
