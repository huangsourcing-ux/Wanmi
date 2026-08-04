# ADR-0005：公共 OSS 与私有实名存储分离

- 状态：D0 公共与私有存储路径通过
- 日期：2026-08-03；真实 OSS 验证更新：2026-08-04

## 决策

公共内容只进入 Payload `media` Collection，由 `@payloadcms/storage-s3` 写入 `public/media` 前缀。实名证件不进入 Media，使用 `ali-oss` adapter 写独立 Bucket/私有前缀；每个对象保存 KMS 加密的数据密钥、摘要和元数据。

私有访问只返回短时签名地址，上传、访问、替换和删除写审计。公共与私有 provider 接口不可互换。SDK live mode 缺配置时安全失败，且 `ALLOW_REAL_PROVIDER_WRITES=false` 时禁止真实调用。

## 验证状态

MinIO 已覆盖公共上传、读取、删除、签名地址和 ETag；注入式 `ali-oss` client 与 KMS mock 覆盖私有上传、读取、签名和删除。2026-08-04 在专用私有 D0 Bucket 完成真实 `storage-s3` 与 `ali-oss` 上传、读取、ETag、60 秒签名、删除及清理验证。真实 KMS 密钥验证仍属于后续实名功能和生产上线门槛，不影响本次仅延期 ECS 运行环境验证的 D0 条件通过决定。
