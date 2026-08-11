# D7-09 OSS 误删恢复演练记录

- 日期：2026-08-11
- 状态：通过
- 范围：私有实名 OSS 测试对象的版本删除、恢复、原主密钥版本解密与精确清理

本记录不包含凭据、密钥、Bucket 名、对象键、对象版本 ID、实例 ID、IP 或 Endpoint；相关生产配置均仅以环境变量名和“由负责人提供”引用。

## 开工闸门

开工前只输出以下名称与布尔值：

| 能力闸                                       | 值      |
| -------------------------------------------- | ------- |
| `ALLOW_REAL_PROVIDER_WRITES`                 | `true`  |
| `ALLOW_REAL_WESTDIGITAL`                     | `true`  |
| `ALLOW_REAL_WESTDIGITAL_READS`               | `true`  |
| `ALLOW_REAL_ALIYUN_OSS_REALNAME`             | `true`  |
| `ALLOW_REAL_WECHATPAY`                       | `true`  |
| `ALLOW_REAL_WECHATPAY_PAYMENTS`              | `false` |
| `ALLOW_REAL_WECHATPAY_REFUNDS`               | `false` |
| `ALLOW_REAL_ALIYUN_SMS_SENDS`                | `false` |
| `ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES`     | `false` |
| `ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES` | `false` |
| `ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES`      | `false` |
| `ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES`   | `false` |

应用主密钥包格式校验通过，共 2 个版本，active 版本存在。自动化测试继续使用 fixture；`make check` 不加载真实 provider 配置，全部真实能力闸保持关闭，`verify-provider-write-policy` 未削弱。

## 只读预检

在任何对象操作前完成只读检查：

- `GetBucketVersioning` 返回 `Status=Enabled`；
- 私有实名存储与公共媒体存储分离；
- 生效生命周期规则无标签条件，并覆盖既有私有实名前缀；
- `NoncurrentVersionExpiration` 为 30 天，满足“非当前版本保留不少于 30 天”；
- 候选配置唯一。

环境组合排查中有两次入口在创建 OSS client 前失败，均未执行对象操作：一次为命令参数解析失败，一次为未填写的其他 provider 占位符被配置校验拒绝。修正为仅向一次性进程注入已填写变量后才执行演练。

## 演练步骤与结果

脚本生成随机精确对象键和 64×64 合成 PNG；测试文件先经过既有实名文件验证，再使用当前 keyring 与 `WANMI-RN1` 信封加密上传。开始前确认该精确键没有历史版本或 delete marker。

| 断言                                | 结果                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| 上传时 `masterKeyVersion`           | `prod-20260811-v2`                                                 |
| 上传前内容 SHA-256                  | `118dba063cb418a0f1d26dbd7d8ec3e3c17292876db2a74cf95f7457bf6daf7b` |
| 普通删除后当前版本不可读            | 通过                                                               |
| 删除后版本结构                      | 1 个本次对象历史版本、1 个本次 delete marker                       |
| 按版本控制恢复                      | 删除本次 delete marker 后恢复，通过                                |
| 使用上传时主密钥版本解密            | 通过                                                               |
| GCM 认证、摘要与完整字节一致        | 通过                                                               |
| 清理范围                            | 仅本次完整对象键                                                   |
| 对象版本与 delete marker 清理后复查 | 0，完成                                                            |

恢复验证读取的是上传时随信封记录的主密钥版本，而不是直接使用当前 active 版本；若旧版本缺失、密文被篡改或摘要不一致，演练必须失败。因此核心结论不只是“对象重新可读”，而是“恢复对象仍可由当时的主密钥版本正确解密且内容未变化”。

## 自动化与变异验证

新增 fixture 测试覆盖：版本控制未启用时零写入停止、非当前版本仅保留 29 天时零写入停止、完整恢复与精确清理、恢复密文被篡改时失败且仍执行清理。

三处关键变异均被测试杀死：

1. 移除 `Status=Enabled` 门禁后，禁用版本控制用例失败；
2. 用上传前明文绕过恢复解密后，密文篡改用例失败；
3. 把完整键过滤扩大为前缀过滤后，带相邻对象的范围用例失败。

恢复实现后，TypeScript strict、定向 ESLint、4/4 聚焦单测和 diff 检查通过。随后先执行 `docker compose down -v` 删除本仓库测试卷并由 Compose 重建；只向测试进程注入一次性随机主密钥、显式关闭全部真实能力闸后，完整 `make check` 退出码 0，通过 bootstrap、`verify-provider-write-policy`、生成物/schema 漂移、全部 migration 往返、Nginx/运维/重建/发布契约、lint、TypeScript strict、82 文件 613/613 单元、28 文件 105/105 PostgreSQL/MinIO 集成、Next.js 生产构建、linux/amd64 镜像、Node audit、工作树/144 个提交完整历史 Gitleaks 和 Trivy。再在同一全新库上运行第二轮完整集成，28 文件 105/105 通过。

## 结论与边界

D7-08 已通过支付通知重放、ECS 重建、RDS PITR 和主密钥轮换；本次补齐 OSS 误删恢复后，开发计划 11.1 第 9 项的五个子项全部有真实演练证据，因此勾选 11.1 第 9 项与第 14 节“OSS 版本与误删恢复”。

本次未读取、修改或删除任何既有对象，也未触发西部数码写入、微信下单/退款、短信发送、部署或数据库修改。其他未完成上线门槛不因本演练改变。
