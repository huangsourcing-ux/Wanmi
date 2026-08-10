# 实名证件应用主密钥 Runbook

本 Runbook 适用于 `REALNAME_DOCUMENT_MASTER_KEYS` 与 `REALNAME_DOCUMENT_MASTER_KEY_VERSION`。实现入口是 `createRealnameDocumentMasterKeyring`，数据密钥包裹/解包由 `wrapDocumentDataKey` 与 `unwrapDocumentDataKey` 承担。主密钥进入应用配置，服务器或部署 secret 完整攻破即可取得主密钥；该风险不得以“等同 KMS”描述。

## 触发信号

- 例行轮换窗口到达，或项目负责人批准立即轮换；
- Web/Worker 启动因主密钥版本、Base64 或长度校验失败；
- 读取旧对象返回 `REALNAME_DOCUMENT_UNAVAILABLE`，且对象记录的 `masterKeyVersion` 不在当前 key ring；
- 部署 secret、服务器或有权读取主密钥的人员账号疑似泄露；
- 主密钥备份不可读、版本清单不一致或灾难恢复演练失败。

## 影响判定

先在不输出密钥值的前提下记录当前 active version、key ring 中的版本名、受影响对象记录 ID、`masterKeyVersion` 分布、镜像版本和部署 secret 版本。禁止把 `REALNAME_DOCUMENT_MASTER_KEYS` 的值写入日志、聊天、工单或审计。若缺少某旧版本，只影响引用该版本的对象；不得回退 active version 尝试解密。若应用节点或部署 secret 完整失陷，应假设 key ring 中全部版本均泄露，并按实名资料泄露事件处理。

## 处置步骤

1. 生成：在获授权的隔离运维环境使用密码学安全随机源生成 32 字节密钥，例如 `openssl rand -base64 32`。标准 Base64 结果必须直接进入受控 secret 和离线应急备份，不保存到仓库、普通 shell history、共享剪贴板或工单。为它分配唯一、不可复用的版本名，例如 `2026-08-r2`。
2. 初次注入：把 key ring 配为 `版本:Base64密钥`，多个版本以逗号分隔；把 active version 配为其中一个真实存在的版本。Web 与 Worker 必须获得同一 key ring。`.env.example` 不提供值；部署平台只向 Wanmi 运行身份和受控运维人员开放读取。
3. 启动验证：先在隔离节点启动同一镜像。`getEnv` 会验证版本名、重复版本、标准 Base64、解码后精确 32 字节及 active version 存在；失败时停止发布，不得临时使用固定默认值。确认 `/readyz` 通过后再继续，但 readyz 不单独回显主密钥组件或版本。
4. 轮换：生成新版本，将它追加到 `REALNAME_DOCUMENT_MASTER_KEYS`，保留全部仍被对象引用的旧版本，再把 `REALNAME_DOCUMENT_MASTER_KEY_VERSION` 切换为新版本。滚动重启 Web/Worker，上传一个批准的测试对象，确认新记录使用新版本，并确认至少一个旧版本对象仍可读取。
5. 旧版本保留：查询受限数据库确认旧 `master_key_version` 的对象计数。只要计数非零，就不得从 key ring 或应急备份删除该版本。当前系统不提供批量重包裹命令；旧对象只能随 30 天生命周期删除，或由后续单独批准、实现并审计的重包裹流程迁移。
6. 紧急恢复：节点重建时从双人受控离线备份恢复完整 key ring 和 active version，先在隔离节点验证旧/新版本对象，再恢复流量。若只是误删部署 secret，恢复相同版本和值，不能生成同名新密钥。若某版本永久丢失，将其引用对象标记不可恢复并启动隐私、客服和合规评估；不得伪造成功读取。
7. 泄露响应：保全访问证据，撤销失陷账号和节点访问，生成全新版本并切换 active version。仅切换 active version不能保护仍由泄露旧版本包裹的数据密钥；在没有获批重包裹流程前，旧版本对象必须按已暴露风险处置。涉及对象访问按 `docs/operations/realname-leak.md` 执行。

## 不可做

- 不把主密钥、完整 key ring 或包含其值的命令提交 Git、写入镜像层、日志、聊天或工单；
- 不使用 `TOTP_ENCRYPTION_KEY`、`SESSION_PEPPER`、Payload secret 或 provider 凭据兼任证件主密钥；
- 不删除仍有对象引用的旧版本，不以当前 active key 回退尝试旧对象；
- 不用固定测试密钥、构建时临时密钥或同名新密钥恢复生产数据；
- 不在未授权情况下读取真实证件来测试轮换，不因轮换扩大 `ALLOW_REAL_PROVIDER_WRITES` 或其他 provider 能力闸。

## 事后审计

记录变更单、批准人、操作者、版本名（不含密钥）、secret 版本、部署镜像、轮换前后对象版本计数、隔离验证结果、旧对象可读证据、生成/恢复设备和离线备份保管人。确认日志与审计不含主密钥值。例行轮换只有在新对象使用新版本、旧对象仍可读、旧版本保留策略明确且 Web/Worker 均恢复健康后才算完成；紧急恢复还必须记录不可恢复对象及通知决定。
