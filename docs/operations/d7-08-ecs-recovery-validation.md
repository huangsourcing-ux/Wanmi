# D7-08 真实 ECS 部署与恢复演练验证记录

日期：2026-08-10～2026-08-11；RTO 更正与重测：2026-08-13（证据时间均为 UTC）

状态：**实机演练已完成；D7-08 原 RTO 结论无效，D7-11 从完全重置后的空节点重测为 582 秒并通过 2 小时目标。OSS 误删恢复在本记录对应轮次按既定规则跳过。**

## 边界与脱敏

- 演练目标是上海唯一获授权的 2 vCPU/4 GiB、Ubuntu 24.04、VPC ECS，以及同 VPC 的隔离 PostgreSQL RDS 和专用私有 OSS Bucket。记录不包含实例 ID、IP、端点、Bucket 名、账号、口令、AccessKey、连接串或密钥值。
- 应用源码为包含已合并重建工具链的 `main@573005f`，其祖先包含 `main@a4a659b`。应用镜像为 `linux/amd64`，Web 与 Worker 使用同一 digest。
- `ALLOW_REAL_PROVIDER_WRITES` 与其余 11 个 `ALLOW_REAL_*` 细分能力闸在 Web、Worker 和所有演练进程中均为 `false`。没有发起真实支付、退款、短信、域名注册、续费或 Name Server 写请求。
- RDS `SSLEnabled=off`、`Category=Basic`，以及本次对话中披露的云、ECS、RDS 凭据待轮换，均按负责人指令作为生产上线缺口记录，不阻断本次演练。
- `docs/planning/` 保持未跟踪、未修改。

## 2026-08-13 更正声明（D7-11）

D7-08 曾把 `2026-08-10T13:57:25Z` 到 `2026-08-11T04:43:25Z` 的 **53,160 秒（14 小时 46 分）**整体记为“完全重置至 Nginx ready”，并据此判定 RTO 失败。项目负责人随后明确说明，其中约 14 小时是目标 ECS 处于关机状态、等待负责人开机的时间；这不是系统重建耗时，也不是自动化恢复过程。原数字在本记录中保留作为更正痕迹，但其 RTO 失败结论自本次更正起作废，不得再作为 RTO 失败证据。

D7-11 在负责人确认机器全程可用后重新执行：先精确验证上海唯一获授权的 2 vCPU/4 GiB 专用 ECS 及其唯一系统盘，普通停止后重新初始化系统盘并自动启动；新系统确认无旧部署路径、Docker、Node 或业务监听后，才从该完全重置节点开始正式计时。全过程没有等待负责人或其他人工介入，人工等待剔除量为 **0 秒**。

## 开工前机内硬停止检查

项目负责人完成系统重置和重启后，先登录目标 ECS，只执行只读检查。起点为 `2026-08-10T13:57:25Z`。

| 检查       | 命令/字段                                          | 脱敏输出摘要                                           | 结论             |
| ---------- | -------------------------------------------------- | ------------------------------------------------------ | ---------------- |
| 主机身份   | `nproc`、`free -m`、`uname -m`、`/etc/os-release`  | 2 CPU、宿主可见内存 3499 MiB、`x86_64`、Ubuntu 24.04   | 与获授权目标一致 |
| 服务与进程 | `systemctl --type=service --state=running`、`ps`   | 只有系统服务、SSH 和阿里云系统代理；无疑似其他项目进程 | 通过             |
| 容器       | `docker ps -a`、运行时包检查                       | 重置后无 Docker 业务容器或旧业务运行时                 | 通过             |
| 监听端口   | `ss -lntup`                                        | 只有 SSH 与系统基础监听；无其他业务端口                | 通过             |
| 计划任务   | `systemctl list-timers`、系统/用户 `crontab`       | 只有发行版系统任务，无业务 cron                        | 通过             |
| 数据目录   | 只读枚举 `/opt`、`/srv`、`/var/lib` 下常见业务目录 | 无其他项目数据目录或数据库目录                         | 通过             |

未发现疑似其他项目运行负载，因此没有触发唯一硬停止条件，之后才开始安装工具链和部署。

## 完整重置、重建与 RTO

### 执行过程

1. 在重置后的 Ubuntu 24.04 节点安装 Docker、Buildx、Git、`jq`、PostgreSQL client、Node.js 24 和 pnpm。
2. 本地按 `linux/amd64` 构建同一应用镜像，传输前后校验 digest；ECS 上使用 loopback 私有 registry 保存应用、Nginx 和 Who-Dat 的不可变 digest。
3. 在 ECS 内生成 Payload、Session、TOTP 和实名应用主密钥材料，写入 root-only `0600` 环境文件；Docker 只使用 `--env NAME` 注入变量名，不把值写入镜像或命令输出。
4. 生成并验证 release manifest，执行 `make rebuild` 的固定八步：环境/网络、digest 拉取、Payload migrations、Web、readyz、`commerce --limit 1` Worker、未完成 Job 恢复、Nginx。

目标 ECS 直接访问外部 registry 多次超时；固定 Nginx/Who-Dat 镜像因此先在受控开发环境按准确 `linux/amd64` child digest 保存，再传至节点的 loopback registry。为继续保持不可变引用，`scripts/rebuild.mjs` 新增 `WANMI_NGINX_IMAGE` 和 `WANMI_WHODAT_IMAGE` 可选覆盖，且只接受 `repository@sha256:<64 hex>`；默认固定引用不变。一次节点内应用构建使主机长时间资源饱和并由负责人重启，但内核记录没有 OOM 证据，故不把它写成 OOM。

成功轮次在依赖和镜像已经准备好后，`make rebuild` 八步全部通过，耗时 **30.4 秒**，于 `2026-08-11T04:43:25Z` 达到 Nginx ready；空 RDS 中全部 Payload migrations 成功，Worker 为 `commerce --limit 1`，启动恢复扫描为 0。

### RTO 结论

#### 原 D7-08 记录（已更正、不得用于 RTO 判定）

- 原记录起点：`2026-08-10T13:57:25Z`
- 原记录 Nginx ready：`2026-08-11T04:43:25Z`
- 原记录数字：**53,160 秒（14 小时 46 分）**
- 无效原因：其中约 14 小时是 ECS 关机并等待负责人开机，不属于系统重建；旧记录又没有把人工等待与自动恢复逐步分开。因此“超出 45,960 秒、RTO 失败”的旧结论无效。
- 当时镜像、依赖和 secret 已备齐后的 `make rebuild` 30.4 秒仍是有效的局部工具链事实，但不能单独替代完整重建 RTO。

#### D7-11 有效重测

- 系统盘正常停止并重新初始化：正常停止 25 秒；重新初始化请求被接受后 19 秒恢复到新系统控制面可用。这 44 秒发生在“完全重置节点”计时边界之前，单独保留；若采用更保守的“发起正常停止即开始”口径，总耗时也仅为 **632 秒（10 分 32 秒）**。
- 正式 RTO 起点（重置后的新系统可用）：`2026-08-13T02:20:02Z`
- Nginx ready：`2026-08-13T02:29:44Z`
- 有效端到端实测：**582 秒（9 分 42 秒）**
- ADR-0006 目标：7,200 秒（2 小时）
- 余量：**6,618 秒（1 小时 50 分 18 秒）**
- 人工等待：**0 秒**；没有从 RTO 中剔除任何人工等待。
- 结论：**通过。** 开发计划 11.1 第 10 项可勾选。

正式计时的墙钟分解如下。墙钟阶段包含 SSH/API 调度、摘要复核和证据采集等自动化开销，因此不会用各命令内部耗时之和缩短 RTO：

| 阶段                           |   墙钟耗时 | 内部实测与结果                                                                                                                       |
| ------------------------------ | ---------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| 系统准备与空节点核验           |      50 秒 | Ubuntu 24.04、`x86_64`、2 CPU；旧部署路径、Docker、Node、业务监听均不存在                                                            |
| 工具安装                       |      85 秒 | 基础工具与 Docker 28 秒，Node.js 24 安装 35 秒；其余为 SSH/校验开销                                                                  |
| 源码、配置与镜像获取           |     238 秒 | 源码/配置 18 秒；约 280 MB 镜像包 SCP 202 秒；其余为连接与双端 SHA-256 复核；没有超时或重试                                          |
| 镜像导入与本地发布准备         |     130 秒 | `docker load` 25 秒、loopback registry 推入 5 秒；同时完成源码解包、digest-only manifest、root-only 运行配置和 12 个全关闭能力闸复核 |
| 固定八步入口调度至 Nginx ready |      79 秒 | `make rebuild` 内部八步实测 28.417 秒；阶段墙钟保留命令调度和证据落盘开销                                                            |
| **合计**                       | **582 秒** | **低于 7,200 秒，余量 6,618 秒**                                                                                                     |

`make rebuild` 内部逐步时间戳分解为：

| 固定步骤                         |          耗时 |
| -------------------------------- | ------------: |
| 环境与隔离网络                   |      0.173 秒 |
| 按不可变 digest 拉取             |      0.587 秒 |
| Payload migrations 与状态核对    |     14.598 秒 |
| Web 启动                         |      0.201 秒 |
| database-backed `readyz`         |      3.948 秒 |
| `commerce --limit 1` Worker 启动 |      0.325 秒 |
| 未完成 Job 查询与原子恢复        |      7.934 秒 |
| Nginx 配置校验、启动与 health    |      0.651 秒 |
| **八步合计**                     | **28.417 秒** |

启动恢复扫描看到 1 个原本已是 runnable、非 processing 的 commerce Job，因此正确返回 `recoveredCount=0`，没有清除并不存在的 processing lock；Worker 随后正常完成该 Job，复核时未完成/processing/runnable 均为 0，近 5 分钟 Worker 错误为 0。Web 与 Worker 使用同一应用 digest，Nginx health 和 Web `readyz` 均为 `ready`，两容器各 12 个真实能力闸全部为 `false`。

本次应用镜像来源是 D7-08 已在该专用 ECS 验证过的 `linux/amd64` 不可变镜像内容；计时前从旧系统导出到受控开发机并校验 SHA-256，重置后再通过 SCP 传回、校验、`docker load`，最后推入节点 loopback registry 并按 registry 返回的 digest 部署。源码与重建工具链来自 `main@c527a3b`。目标 ECS 本次没有直接访问外部 registry，因此镜像获取没有遭遇 registry 超时；这不否定 D7-08“目标 ECS 直连外部 registry 反复超时”的真实约束。计时前一次节点内构建新应用镜像还使 2 vCPU/4 GiB 主机资源饱和并被丢弃，进一步说明目标节点不适合承担发布构建。后续仍应由 CI 预构建 `linux/amd64` 镜像并通过稳定受控 registry 以不可变引用交付；本切片不实施该改造。

安全收尾时先用云助手复核 Nginx health 与 readyz 在撤销 SSH 后仍为 `ready`，再解绑并删除本轮系统盘重置导入的一次性云密钥对；远端一次性公钥和重复运行配置已清除，本机精确清理 25 个临时私钥、证书、加密包、运行配置、工件及证据文件。专用 ECS 保持运行，后续可由云助手建立正式受控入口。

## 常驻内存与 4 GiB 余量

使用 Docker cgroup `memory.current`/`memory.peak` 和宿主 `free` 在初始稳态、处理中 Job、密钥轮换后稳态三次采样；下表的峰值取三轮最大值，稳态取最后一轮 `2026-08-11T05:33:53Z`。

| 进程          |      最大峰值 |      最终稳态 |
| ------------- | ------------: | ------------: |
| Web           |     294.9 MiB |     199.5 MiB |
| Worker        |     385.5 MiB |     160.6 MiB |
| Who-Dat       |       4.6 MiB |       2.1 MiB |
| 三者合计      | **685.0 MiB** | **362.2 MiB** |
| Nginx（补充） |       5.3 MiB |       3.3 MiB |

三项服务相对配置的 4096 MiB 峰值余量为 **3411.0 MiB**；相对操作系统实际可见 3499 MiB 的保守余量为 **2814.0 MiB**。最终宿主 `used=983 MiB`、`available=2515 MiB`。这是短时演练数据，不替代上线后的长周期 RSS/泄漏监控。

## 真实磁盘日志轮转

Web、Worker、Who-Dat 和 Nginx 均使用 Docker `local` 日志驱动，`max-size=1m`、`max-file=3`。在 ECS 真实磁盘对独立标记的 probe 容器写入约 64.8 MiB 随机日志后，容器日志目录只保留：

- 当前段 573,400 bytes；
- 两个压缩轮转段 627,201 / 627,261 bytes；
- 合计表观 1,827,862 bytes，实际分配 1,839,104 bytes。

最早日志已被淘汰，保留段数和大小均有界；probe 容器及其精确日志目录随后删除。结论：轮转在真实 ECS 磁盘生效，单容器日志不会无界增长。

## Web/Worker 独立重启与 commerce 强杀恢复

在同 VPC RDS 中建立专用 commerce 演练 fixture，并在 provider write claim 后用 60 秒延迟保持 Job 为 processing。全部 provider 写闸为 `false`，只调用既有本地 fixture transport。

1. Job 处理中重建 Web；Worker 容器和 processing Job 均未改变，Web 恢复 ready。
2. Web ready 时对 Worker 发送真实 `SIGKILL`；Web 始终 ready，RDS 中 Job 仍为 `processing=true`、`completed_at=NULL`。
3. 重启 Worker 后并发运行两个恢复者，返回 **`[0,1]`**，合计只恢复 1 行。
4. 最终 Job complete、订单 `succeeded`；provider operation 行数 1、attempt 最小/最大值均为 1、status `succeeded`、write-claim 审计 1、续费 0、退款 0。

结论：Web 与 Worker 独立重启互不终止对方工作；真实强杀后未完成 Job 恰好恢复一次，没有重复注册、续费或退款，也没有真实 provider 写入。

## 第 9 项恢复演练

### 支付通知重放

在 ECS 内通过 D5-07 `system_admin` 入口调用正式 HTTP replay route：

- 无已验签归档的请求返回 `404 VERIFIED_PAYMENT_NOTIFICATION_NOT_FOUND`，没有 replay 审计，不能借重放入口绕过验签；
- 已验签通知首次和再次重放均返回 HTTP 200、`idempotentReplay=true`、订单保持 `succeeded`；
- 两次已验签重放前后订单事件数不变，replay 审计只增加 2，未产生第二次状态迁移。

临时管理员清理时触发既有“最后一个 active system_admin 不可停用”数据库约束：6 个临时管理员中 5 个已停用，全部临时 Session 为 0；剩余 1 个使用 ECS 内生成且已丢弃的随机密码/TOTP，无法登录，但仍须在负责人通过 invitation 建立正式 `system_admin` 后停用。此待办不改变重放结果。

### ECS 重建与未完成 Job

系统盘由负责人完整重置后，使用已合并工具链从空节点恢复 migrations、Web、Worker、Who-Dat 和 Nginx；服务最终 ready。RDS 持久化的未完成 Job 随后在同一真实 ECS 上通过上述 Worker `SIGKILL` 和双恢复者竞争恢复一次。两项均使用真实 Linux/VPC/RDS；完整重置与强杀是两个连续演练阶段，未声称 30.4 秒为完整节点 RTO。

### RDS PITR

- 自动 Snapshot 每日执行、保留 7 天，`EnableBackupLog=1`；演练前刷新可恢复窗口为 `2026-08-05T01:09:59Z`～`2026-08-11T05:13:17Z`。
- 选择 `2026-08-11T05:12:17Z`，按 PITR 创建同 VPC、同 PostgreSQL 16 规格的临时 Basic 副本。首次 API 响应为 `SYSTEM.CONCURRENT_OPERATE`，但只读查询发现恰好一个已创建副本，因此没有重试，避免重复计费资源。
- 副本 `Running` 后，从 ECS 只经 VPC 私网连接；对 7 张订单/实名相关表按主键排序完整行 JSON，逐表比较 count 和规范化 MD5。结果全部一致：订单 2、订单事件 3、实名模板 1、适用范围 1，其余人工订单动作、证件和备份对象均为 0。
- 一致性确认时间 `2026-08-11T05:31:27Z`。副本身份、描述、引擎、按量计费和删除保护关闭状态经精确校验后释放；随后控制面已不可见，源库未修改。临时副本连接文件和诊断导出已删除且不可恢复。

结论：真实 PITR 创建和订单/实名数据一致性通过。`Category=Basic` 和 `SSLEnabled=off` 仍不满足生产 HA/传输安全门槛。

### OSS 误删恢复

先只读调用专用 Bucket 的版本控制接口，结果为 `NotConfigured`，不是 `Enabled`。按负责人指令只跳过此子项：**没有上传、删除或恢复任何 OSS 对象，也没有用 fixture 冒充。** 因此开发计划 11.1 对应的复合恢复条目保持未勾选，生产 OSS 版本控制、30 天删除保护和误删恢复门槛仍未通过。

### 应用主密钥轮换

- 初始版本 `prod-20260810-v1` 在 ECS 内生成，通过 root-only `0600` 环境文件注入 Web/Worker；值从未输出。
- 先用 v1 生成受控密文测试对象；再在 ECS 内生成 `prod-20260811-v2`，将 key ring 原子更新为 v1+v2 并把 active version 切到 v2。
- 按 Web → Worker 顺序滚动重建：重建 Web 时旧 Worker 保持运行，重建 Worker 时 Web 保持 ready。最终两者读取相同 `[v1,v2]` key ring，active 均为 v2。
- 轮换后旧对象仍由 v1 解密，新对象记录并使用 v2；直接请求未知版本 `prod-unknown-v999` 被拒绝为 `REALNAME_DOCUMENT_UNAVAILABLE`。

结论：版本新增、active 切换、滚动重启、新旧读取和未知版本拒绝均通过。**主密钥离线双人备份尚未完成**，由项目负责人另行执行，故生产上线复合门槛仍未通过。

## RDS 是唯一业务数据源

`2026-08-11T05:11:59Z` 从同 VPC ECS 查询：RDS 中有订单 2、订单事件 3、Payload Jobs 52（完成 51）、实名模板 1、支付通知归档 8。Web、Worker、Who-Dat 均无业务 volume mount；ECS 无 PostgreSQL 进程、容器或 5432 监听，也没有业务数据库目录。容器重启和完整节点重建均从 RDS 恢复状态。

结论：订单、状态事件、Job、实名元数据和支付通知归档均位于 RDS；ECS 文件系统不是任何业务数据的唯一来源。OSS 仍负责未来证件密文对象，但本次专用 Bucket 无证件对象，且未执行 OSS 写入。

## 条目结论与遗留门槛

| 条目                                          | 结论                                                        |
| --------------------------------------------- | ----------------------------------------------------------- |
| D0 单 ECS 内存、独立重启、Jobs 恢复、节点重建 | 真实 Linux/VPC 证据完成，可勾选                             |
| 11.1 第 9 项复合恢复                          | 支付、ECS、RDS、密钥通过；OSS 因无版本控制跳过，整项不勾    |
| 11.1 第 10 项内存、轮转、2 小时 RTO           | 内存/轮转沿用 D7-08 实测；D7-11 完整 RTO 582 秒通过，可勾选 |
| 11.1 第 11 项独立重启、同 VPC 强杀恢复        | 通过，可勾选                                                |
| 14.4 ECS 重建、RDS PITR、支付重放、密钥轮换   | 各自有实测证据，可分别勾选                                  |
| 14.4 OSS 版本与误删恢复                       | 未执行，不勾选                                              |

完整重置 2 小时 RTO 已由 D7-11 重测通过。其余生产上线门槛不受本次更正影响：启用 RDS SSL 和 HA；完成应用主密钥离线双人备份；轮换本次对话披露的云、ECS 和 RDS 凭据；建立正式 `system_admin` 后停用演练 sentinel；配置稳定的受控镜像 registry。D7-08 当时跳过的 OSS 子项已由后续 D7-09 独立补证，本记录不改写其原始实测事实。
