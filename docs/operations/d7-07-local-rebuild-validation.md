# D7-07 本地受限重建验证记录

日期：2026-08-10（America/New_York）

状态：**容器受限等价验证已完成，真实 ECS 验证待授权**。本记录不是 2 vCPU/4 GiB 生产 Linux、ECS 与 RDS 同 VPC 或真实 OSS 的证据；开发计划 11.1 第 10、11 项及 D0 第 4 节对应项均保持未勾选。

## 边界与方法

- 全程只使用本地 Docker Desktop、两个一次性 Docker-in-Docker daemon、一次性本地 registry 和 PostgreSQL fixture；没有连接或修改真实 ECS、RDS、OSS、WestDigital、Wechat Pay 或其他生产系统。
- 应用只构建一次 `linux/amd64` 镜像，推入本地 registry 后取得 digest；删除源 daemon，再由空目标 daemon 按 digest 拉取。Web、migration、Worker、恢复 probe 均使用该 digest，Web/Worker 的 `.Config.Image` 还会相互比较。
- 整个目标 daemon 由宿主设置 `--cpus=2 --memory=4g` 并读取 `NanoCpus=2000000000`、`Memory=4294967296` 复核；Web、Worker、Who-Dat 和一次性运行容器也分别设置相同上限。本地 PostgreSQL fixture 位于该节点边界内，因此资源压力比生产 RDS 位于节点外更保守。
- `make validate-rebuild-local` 是一次性人工入口，不进入 CI；每轮使用唯一名称并在 `finally` 精确清理本轮容器、网络、镜像和临时目录。

最终通过轮次的应用引用为 `host.docker.internal:50925/wanmi-web@sha256:8042abd956feae9196c9985d23de93d8a6dcd7993da74bb50e861fcde163d637`。host/port 属于已清理的本地 registry，仅作为本轮原始证据，不是可部署地址。

## 重建与 RTO

`make rebuild` 依次执行 ADR-0006 的 8 个固定步骤：环境/网络、digest 拉取、Payload migrations、Web、readyz、commerce limit 1 Worker、未完成 Job 恢复、Nginx。目标 daemon 在开始前没有应用镜像或 Wanmi 容器；计时从调用重建入口开始，到 Nginx `/nginx-healthz` 返回 `ready` 结束。

| 项目            | 实测                | 门槛        | 结论                 |
| --------------- | ------------------- | ----------- | -------------------- |
| 完整重建总耗时  | 93.4 秒             | 7,200 秒    | 余量 7,106.6 秒      |
| 应用架构        | amd64               | linux/amd64 | 相符                 |
| Web/Worker 镜像 | 同 digest           | 必须相同    | 相符，仅启动命令不同 |
| readyz 门禁     | 通过后才启动 Worker | fail-closed | 相符                 |

镜像在源节点上的构建与推送、演练后的 secret 扫描不计入 ADR-0006 的“空节点到 Nginx 就绪”；真实 ECS 演练仍应使用已经批准并存在 registry 的 release digest，按相同计时边界记录。

## 常驻内存

在强制中断 fixture 正由 Worker 处理期间，每秒采样一次、共 8 次；“稳态”是最后 3 次样本的平均值。下表只列计划要求的三个常驻服务：

| 服务    | 峰值 MiB | 稳态 MiB |
| ------- | -------: | -------: |
| Web     |    304.3 |    226.3 |
| Worker  |    298.2 |    298.0 |
| Who-Dat |     37.1 |     37.0 |
| 合计    |    639.6 |    561.3 |

相对 4,096 MiB，三服务峰值余量为 3,456.4 MiB，稳态余量为 3,534.7 MiB。Nginx、Docker daemon 与本地 PostgreSQL fixture 仍实际受整个节点 4 GiB 硬限制，但未混入计划指定的三服务表。该采样时长只能证明本轮重建与中断场景，不替代真实 ECS 长时峰值、内核 page cache、实际流量或生产数据库网络行为。

## 日志轮转

常驻容器使用 Docker `local` driver、`max-size=1m`、`max-file=3`。独立轮转 probe 使用同一应用 digest 和 2 vCPU/4 GiB 限制，以 `max-size=1m`、`max-file=2` 写入 50,000 行、至少 9,500,000 bytes：

- inspect 读取到的 driver、大小和文件数与配置完全一致；
- 最早一行已经不可读取，最新一行仍可读取，证明发生轮转而非仅写入；
- 最终 `docker logs` 可读留存为 1,093,349 bytes，低于 2.5 MiB 上限，旧文件已清理，磁盘不会随该日志流无界增长。

真实 ECS 必须继续验证 Docker 数据目录容量、宿主磁盘告警、实际运行时长和所有常驻容器的轮转文件。

## 独立重启与强制中断恢复

fixture transport 只在 `WANMI_D7_REBUILD_VALIDATION=D7-07-LOCAL-ONLY`、所有真实写闸关闭时，才允许在 provider write claim 已落库后维持 60 秒异步 Promise；adapter 复用既有超时配置，本轮为 90 秒。执行时序为：

1. Payload 投递一个真实 `commerce` registration Job；等待 provider operation 达到 `submitted|attempt_count=1` 且 Job `processing=true`。
2. 重启 Web 并等待 readyz；Worker container ID 不变、仍运行，Job 仍为 processing，证明 Web 重启未中断 Worker Job。
3. 关闭 Worker 自动重启并发送 `SIGKILL`；Web readyz 保持通过，数据库中 Job 仍为 `processing=true` 且未完成，证明实际制造了处理中断。
4. 重启 Worker，同时以 `Promise.all` 启动两个恢复容器；返回的恢复数为 `[1,0]`，合计严格为 1。
5. 既有 Payload Jobs runner 重新执行同一 handler。由于 provider operation 已是 `submitted`，业务逻辑只查询 fixture 资产，不再次提交；最终 Job 完成、订单 `succeeded`。

最终数据库证据为：provider operation 数/最小 attempt/最大 attempt/状态=`1|1|1|succeeded`，provider write claim 审计数=`1`，该订单 renewal=`0`、refund=`0`。反向独立性也通过：Worker 被 `SIGKILL` 和重启期间 Web readyz 始终成功。

恢复工具没有实现第二套任务或 provider 恢复逻辑。它通过 Payload runner 调用 service；service 在同一事务执行带 queue、processing、completed、error、cutoff 条件的 PostgreSQL `UPDATE ... RETURNING`，随后仍由既有 Payload commerce handler 和 provider operation 幂等语义承担恢复。

## Secret 与凭据验证

每轮生成只存在于进程环境的随机 Payload secret、Session pepper、TOTP key、应用主密钥和 Who-Dat auth sentinel。验证结果全部通过：

- Docker image config/history 和重建输出不含任何 sentinel；完整 key-ring 与其中原始应用主密钥分别独立匹配，避免前缀掩盖裸 key 泄漏；
- OCI 每一层不含任何 sentinel；
- 最终 rootfs 的 `/app` 不含任何 sentinel；
- 所有含 `/app` 的 OCI 层通过仓库 `.gitleaks.toml` secret 形态扫描；
- Web、Worker、Who-Dat、Nginx 运行日志不含 sentinel、私钥头或 AccessKey 形态。

工具只用 Docker `--env KEY` 从执行环境传值，错误与子进程输出按敏感键对应值脱敏；manifest、Nginx 文件、镜像 build args 和仓库文件不保存运行 secret。`.env.example` 没有加入真实值。

## 变异验证

动手前先确认承重层：readyz 的承重层是顺序执行器对第 5 步 rejection 的传播，而 Worker 启动函数内部没有必要重复 readyz；恰好一次恢复的承重层是同一 SQL 中的 processing+截止时间条件与 PostgreSQL 行更新竞争，Payload handler 的 provider 幂等是下游第二层，不能拿它掩盖恢复器重复释放。

| 变异点                                                                      | 实际失败信息                                                          | 结论                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| 在固定计划中吞掉 `verify-readyz` rejection，使其继续调用 Worker             | `AssertionError [ERR_ASSERTION]: Missing expected rejection (Error).` | 变异被 `verify:rebuild` 杀死；恢复后通过             |
| 同时删除原子恢复 SQL 的 `processing IS TRUE` 与 `updated_at <= cutoff` 条件 | `AssertionError: expected [ 3, 3, 3, 3, 3 ] to deeply equal [ 3 ]`    | 5 路恢复重复命中，变异被并发集成测试杀死；恢复后通过 |

第二处必须同时删除两个互补谓词：只删一个仍可能被另一个正确限制，不应把这种存活误报为冗余项。恢复源码后，聚焦恢复集成在 `docker compose down -v` 重建的全新数据库上连续两轮通过；完整本地演练也在每次全新隔离 daemon/数据库上多次运行，最终严格节点边界轮次通过。

## Provider 前置自检

执行前已查阅根目录只读《西部数码业务API接口文档（v2）新.md》。当前运行环境缺少 WestDigital 账号/API 密码与两个契约域名、Wechat Pay 商户/证书/密钥/通知配置、私有 OSS bucket/endpoint/访问凭据，以及版本化应用主密钥注入；所有资金、域名、短信和 OSS 写入能力闸均为 `false`。因此没有执行 D7-05 一次性真实只读契约脚本，所有真实字段、错误码和响应时间均如实记为 N/A，没有用 fixture 或推测填充；11.1 第 2 项保持未勾选。详见 `docs/operations/d7-05-provider-read-contracts.md` 的 D7-07 追加记录。

## 真实环境待重跑

获得下一个切片的真实 ECS/RDS/OSS 执行授权后，至少机械重跑以下各项，并把真实资源标识仅以批准的脱敏形式留证：

1. 核对 ECS CPU 架构，在空节点从批准 registry 按 release digest 执行完整 8 步重建，重新计时并与 2 小时 RTO 对比。
2. 在真实 2 vCPU/4 GiB 生产 Linux 上，以实际流量/有界压力运行并记录 Web、Worker、Who-Dat 峰值与长时稳态，同时记录 Nginx、Docker、内核和 page cache 的节点总余量。
3. 以宿主实际 Docker 日志目录持续写入，确认轮转、旧段删除、磁盘空间和磁盘告警。
4. 在真实 ECS 上分别重启 Web、Worker，证明进程、readyz 和正在处理 Job 的相互独立性。
5. 在 ECS 与 RDS 同 VPC 条件下，于真实 commerce Job 处理中强杀 Worker，启动两个并发恢复者，并核对 Payload Job、订单事件、provider operation/write claim，确认注册、续费、退款或 NS 没有重复提交。
6. 核对生产 secret 注入、完整应用主密钥 key ring 恢复、日志脱敏和镜像 digest；不得把本轮随机 sentinel 或本地 manifest 带到真实环境。

在上述真实环境证据完成前，不勾选开发计划 11.1 第 10、11 项，不勾选 D0 第 4 节对应项，也不把本记录表述为生产 ECS 验收。
