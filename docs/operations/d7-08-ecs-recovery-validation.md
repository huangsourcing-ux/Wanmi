# D7-08 真实 ECS 部署与恢复演练验证记录

日期：2026-08-10（America/New_York）

状态：**开工前预检阻塞，未开始部署或恢复演练**。开发计划 11.1 第 9、10、11 项与第 4 节 D0 单 ECS 项全部保持未勾选。

## 边界

- D7-07 的 PR #58 已于 `2026-08-10T12:02:00Z` 合并至 `main`，合并提交为 `a4a659b09217def3cb80f9d005ae7d949fbd26c8`；因此“D7-07 已合并”前置满足。
- 预检只使用 GitHub 元数据、阿里云 CLI 只读 API 与 SSH 目标身份/规格核对。未执行 `Modify*`、`RunCommand`、ECS 重启/重置、RDS 恢复、OSS 对象写入/删除、主密钥生成/轮换或 provider 请求。
- 本验证记录与仓库文件未写入任何凭据、主密钥、Bucket 名、实例 ID、公网 IP 或数据库连接串；只记录允许的字段名、状态、错误码、时间和结论。
- 现有唯一 SSH 目标与阿里云 API 返回的目标 ECS 地址不一致。一次只读主机事实查询显示该 SSH 目标是 8 vCPU/16 GiB；对 Docker 的只读列表查询被权限拒绝后立即停止。未对该非目标主机执行任何修改、容器变更或资源演练。

## 预检结果

| 预检项                                           | 只读实测证据                                                                                                                                                                                                                | 结论                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ECS 为 2 vCPU/4 GiB 且无其他业务负载             | `DescribeInstances` 在上海返回唯一台 `Running` ECS，`Cpu=2`、`Memory=4096 MiB`、VPC 存在、Ubuntu 24.04；但已配置 SSH 目标与该 ECS 不匹配，无法在目标节点核对架构、实际负载、容器、磁盘与专用性                              | **未通过**                                                           |
| RDS 已启用 SSL 并只经 VPC 内网                   | `DescribeDBInstances/Attribute` 显示 PostgreSQL 16、`Running`、`InstanceNetworkType=VPC`、VPC/vSwitch 存在；`DescribeDBInstanceSSL` 实测 `SSLEnabled=off`                                                                   | **未通过**：VPC 通过，SSL 失败                                       |
| RDS 自动备份与 PITR                              | 备份策略为每日自动 Snapshot、7 天保留、`EnableBackupLog=1`；近 7 日有 7 个 `Automated/FullBackup/Success` 备份；`DescribeLocalAvailableRecoveryTime` 返回 `2026-08-04T01:14:59Z` 至 `2026-08-10T12:09:47Z` 的本地可恢复窗口 | **预检通过**；但因全局前置失败，未创建 PITR 恢复实例、未执行恢复验证 |
| OSS 版本控制与 30 天删除保护                     | 上海唯一 Bucket 的 `GetBucketVersioning` 响应无 `Status=Enabled`，即未启用版本控制；`GetBucketLifecycle` 返回 `404 NoSuchLifecycle`；`GetBucketWorm` 返回 `404 NoSuchWORMConfiguration`                                     | **未通过**                                                           |
| 生产应用主密钥在受控环境生成、备份并注入目标 ECS | 本地进程无生产主密钥变量（这不作为目标节点失败证据）；因目标 ECS 无正确 SSH/受控运行入口，不能核对只有版本名的 key ring 启动校验、Web/Worker 一致性、生成来源与离线备份保管记录                                             | **未通过／无法确认**                                                 |
| 凭据轮换已完成                                   | 当前只读云身份可用，但没有可复核的生产应用/RDS/OSS 凭据轮换记录，且无法在目标 ECS 检查注入版本                                                                                                                              | **未通过／无法确认**                                                 |
| 写入能力闸保持关闭                               | 未启动 Wanmi 容器或 provider transport，未开启任何 `ALLOW_REAL_PROVIDER_WRITES`/细分写闸，未发起真实资金、域名、短信或 OSS 写入                                                                                             | **保持关闭**                                                         |

RDS 实例同时实测为 `Category=Basic`。这不改变本次对“自动备份/PITR 前置”的判定，但仍不满足已冻结的“RDS HA”生产上线门槛，不得在后续演练记录中隐去。

## 未执行的演练

因硬前置失败，以下项目全部为 **N/A（未开始）**，不得用 D7-07 本地数值、fixture、手工导出或推测代替：

- Web、Worker、Who-Dat 真实 Linux 峰值/稳态内存与 4 GiB 节点余量；
- 真实磁盘日志轮转、磁盘告警与长时间增长边界；
- Web/Worker 独立重启与同 VPC `commerce` Job 的 Worker `SIGKILL` 恢复；
- 从完全重置节点开始的 2 小时 RTO 计时重建；
- 订单、Job 与实名元数据的 RDS 唯一持久化来源核对；
- `system_admin` 支付通知重放；
- ECS 重建后未完成 Job 恢复；
- RDS PITR 恢复到新实例及订单/实名一致性验证；
- OSS 测试证件删除、版本恢复与指定主密钥版本解密；
- 应用主密钥新版本轮换、新旧对象可读与未知版本拒绝。

## 重新开工条件

重开 D7-08 前必须同时提供可复核证据：

1. SSH/受控运行入口精确指向上述 2 vCPU/4 GiB 目标 ECS，并在机内确认架构、系统、磁盘、容器和无其他业务负载；
2. RDS `SSLEnabled` 已开启，应用从 ECS 使用 VPC 内网 SSL 连接成功；
3. 专用私有 Bucket 的版本控制为 `Enabled`，且删除后的非当前版本至少保留 30 天（或更强且符合冻结要求的保护）；
4. 受控环境生成、受控 secret 注入、离线备份与保管记录可核对，且 Web/Worker 获得同一完整 key ring/active version；
5. 生产应用、RDS、OSS 凭据轮换记录可复核；
6. 仍使用已合并 D7-07 工具链，且全部 provider 写闸为 `false`。

任一条未满足时继续 fail-closed，不执行增量部署、不制造 Job 中断、不重置 ECS，也不创建 RDS/OSS/密钥的“等价”替代证据。
