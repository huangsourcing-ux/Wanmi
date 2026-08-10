# AGENTS.md

本文件是 Wanmi.AI 仓库内 Codex/AI 开发代理的执行规范。适用于仓库根目录及全部子目录；更深目录如有 `AGENTS.md`，只可补充局部约束，不得放宽本文件的产品、安全和上线门槛。

当前项目负责人批准并冻结的 P1 文档基线为 `P1-BASELINE-2026-08-10.1`，对应批准标签 `p1-docs-approved-2026-08-10-1`。本基线在上一基线 `P1-BASELINE-2026-08-08.1`（标签 `p1-docs-approved-2026-08-08-1`）之上包含一项冻结项变更：D7-05 实测阿里云 KMS `AccountStatus=NotEnabled` 后，项目负责人于 2026-08-10 明确指示移除 KMS，实名证件保留每对象 32 字节数据密钥与 AES-256-GCM 信封加密，改由环境注入的版本化应用主密钥包裹数据密钥；对应文档为 `Wanmi.AI-技术栈.md` v5.6 与 ADR-0005。上一基线已批准的 `pending_payment → manual_review` 及其他冻结项（P1 范围、其余固定架构、其余订单状态与迁移、退款规则、实名归属、12～16 周工期口径和生产上线门槛）不变；上线门槛中的加密要求仅将 KMS 实现替换为应用主密钥注入、轮换和紧急恢复。

## 1. 项目目标

Wanmi.AI P1 是面向中文用户的“域名工具 + 站内代理注册平台”。核心链路为：

```text
查询域名 → 获取报价 → 手机登录 → 选择已验证实名模板
→ 创建订单 → 微信支付 → 服务端确认到账 → 西部数码注册
→ 生成域名资产 → 短信通知
```

P1 以产品完成度、工具使用量、注册成功率、状态明确率和用户增长为主要指标，不设置强制收入或盈亏平衡门槛。

## 2. 文档优先级

### 2.1 优先级

开始工作前阅读与任务相关的文档。发生冲突时按以下顺序处理：

1. 用户当前明确指令；
2. `Wanmi.AI-产品需求文档-PRD.md`：功能、状态、流程和验收；
3. `Wanmi.AI-技术栈.md`：架构、安全和工程基线；
4. `Wanmi.AI-P1开发计划.md`：里程碑、顺序和完成定义；
5. `开发日志.md`：按阶段和日期记录已完成工作、验证证据与遗留问题，不得改变上级文档的范围或门槛；
6. `Wanmi.AI-现有阿里云资源.md`：资源事实和上线门槛；
7. `Wanmi.AI-产品规划与商业评估.md`；
8. `Wanmi.AI-App技术规划.md`。

不得擅自改变 P1 功能范围、订单状态、退款规则、实名归属、工期口径或上线门槛。发现冲突时先记录证据，能按上述优先级消解则修正；会 materially 改变产品结果时询问项目负责人。

### 2.2 冻结与变更控制

- 冻结项包括 P1 产品范围、固定架构、订单状态与合法迁移、退款规则、实名归属、12～16 周工期口径和生产上线门槛；
- 开发计划的任务勾选、验证证据、阻塞记录、ADR 和 Runbook 可以持续更新，但不得借此改变冻结项；
- 修改冻结项必须取得项目负责人明确指令，更新所有受影响文档的版本与变更记录，完成跨文档一致性验证，并建立新的批准标签；
- D0 失败只允许延长验证、修正假设或重新提交架构决策，不自动解除冻结，也不得引入第二套后端绕过。

## 3. 工作方式

每次实现任务：

1. 检查 Git 状态、现有文件、测试、环境示例和用户未提交修改；
2. 找到开发计划中第一个相关且未完成的任务；
3. 给出简短执行计划，标明假设、风险和验证方式；
4. 做最小完整切片，不创建与当前里程碑无关的空模块；
5. 运行与风险匹配的 lint、typecheck、测试、构建或迁移验证；
6. 更新开发计划中的完成项、证据和未解决问题；
7. 按阶段在 `开发日志.md` 的当天条目追加完成内容、验证结果、遗留门槛和 Git 状态；
8. 将已完成且验证通过的代码与文档提交到当前 `codex/*` 工作分支并正常推送到 GitHub；
9. 阶段完成后必须创建指向默认分支的 GitHub PR；已有本阶段 PR 时推送更新，不得停在只有远程分支而没有 PR 的状态；
10. 汇报变更、验证结果、剩余风险、分支、提交、PR 和下一步。

项目负责人已持续授权 Codex 对每个完成的代码切片或阶段执行普通 Git 暂存、提交、推送，并在阶段完成后创建或更新 GitHub PR。执行前必须检查实际 diff、排除用户无关修改和秘密、通过风险匹配的验证；只推送当前 `codex/*` 分支，禁止 force push、直接推送或合并到受保护分支。每个 D0、D1 等阶段使用独立分支和 PR；上一阶段 PR 未合并时，不在同一分支混入下一阶段代码，除非项目负责人明确批准堆叠 PR。Claude 负责 PR 审核，Codex 不得自行批准或合并 PR；审核意见处理和合并仍按项目负责人后续指令执行。

`开发日志.md` 必须按 D0、D1 等阶段分组，并在阶段内按日期升序追加。每条至少记录阶段状态、完成内容、验证证据、遗留风险/门槛和 Git 分支；不得改写历史事实来掩盖失败，后续修正使用新日期条目。

保留用户已有修改，不覆盖、重置或删除不属于当前任务的内容。上述持续授权不包含部署、资源采购、备案申请、发送真实交易、调用西部数码写接口、force push、批准/合并 PR 或修改生产数据；这些操作仍需明确授权。

## 4. P1 范围

### 必须实现

- 六类域名工具、RDAP/WHOIS、DNS、IDN、SSL/CAA；
- 内容、专题、TLD 页面、媒体、SEO、导航和轻量 CMS；
- 自营广告位、素材、排期和基础统计；
- 手机验证码登录、管理员密码 + TOTP、RBAC；
- 实名模板和私有证件；
- 报价、订单、微信 Native/H5 支付、退款和对账；
- 西部数码新注册、主动续费、域名资产和 Name Server 修改；
- 站内与短信到期提醒；
- 审计、人工复核、监控、备份和恢复演练。

### 明确不实现

- 域名转入/转出、完整 DNS 托管、默认自动续费；
- 余额钱包、自动开票、社区和 App；
- 微信 JSAPI；
- 第三方程序化广告；
- 微服务、独立消息队列或第二套业务后端；
- Payload Ecommerce/Stripe 插件。

## 5. 固定架构

- Node.js 24 LTS；
- Next.js 16.2.11、React、TypeScript strict、App Router；
- Payload 3.86.0；全部 `payload` 与 `@payloadcms/*` 包必须为相同精确版本；
- Payload 官方插件固定为 `@payloadcms/plugin-seo`、`@payloadcms/plugin-redirects`、`@payloadcms/plugin-form-builder`，全部锁定 `3.86.0`；
- PostgreSQL + `@payloadcms/db-postgres`；Payload migrations；`push: false`；
- Payload Jobs；Web 与独立 Worker 使用同一镜像；
- Tailwind CSS + shadcn/ui；共享 Zod request/response schemas；
- 阿里云 OSS；公共媒体使用 `@payloadcms/storage-s3`，私有实名文件使用 `ali-oss`，两者分离；
- 阿里云短信使用 Alibaba Cloud TypeScript SDK；实名证件使用环境注入的版本化应用主密钥完成信封加密；
- Who-Dat 负责 RDAP/WHOIS；
- Nginx + Next.js/Payload + Payload Jobs Worker + Who-Dat。

不得重新引入第二套业务后端、迁移系统、认证系统、任务系统或跨语言接口生成链路。需要新技术时先写清现有方案为什么不能解决、运行成本和退出方案，并由项目负责人确认。

## 6. Payload 边界

### Collections 与 services

Payload 管理内容、媒体、广告、身份、实名、报价、订单、支付、退款、provider 操作、域名资产、对账、审计和 Jobs。

高风险业务逻辑必须位于 `src/services`：

- 身份挑战与 Session；
- 报价和金额计算；
- 订单状态迁移；
- 支付验签、查单和退款；
- 注册、续费、NS 修改和对账；
- 私有证件的加密、访问与删除。

Hooks 只做字段规范化、审计、派生字段和入队。禁止在 Hook 中直接调用微信、西部数码、短信或其他外部写接口。使用 Hook 发起嵌套 Payload 操作时传递 `req`；需要防止递归时使用明确的 `context` 标记。

### 官方插件边界

- SEO 元数据使用 `@payloadcms/plugin-seo`，不建立平行 SEO 字段系统；
- 页面改址使用 `@payloadcms/plugin-redirects`，写入受 RBAC 和审计保护，必须阻止循环与开放跳转；
- 联系、反馈和需求收集使用 `@payloadcms/plugin-form-builder`，不得承载订单、支付、退款、实名或文件上传；
- 使用插件生成的 Collection 时仍必须配置项目 access control，不能依赖后台隐藏代替权限校验。

### Local API

Payload Local API 默认绕过 access control，必须显式防护：

```ts
await payload.find({
  collection: 'orders',
  user: req.user,
  overrideAccess: false,
})
```

- 代表用户调用时始终传 `user` 和 `overrideAccess: false`；
- 只有明确命名、仅供系统任务使用并有审计的函数可以绕过权限；
- 系统权限函数不得直接暴露给浏览器 endpoint；
- 每个敏感 Collection 都要测试匿名、customer 和各管理员角色；
- 通用 REST create/update/delete 对敏感 Collection 默认关闭。

### 迁移与生成类型

- Payload 是业务 schema 的唯一所有者；
- 禁止生产 `push` 或运行时 schema 同步；
- 迁移和 `payload-types.ts` 必须进入版本控制；
- 生成文件不得手改；
- CI 检查类型和迁移漂移；
- 嵌套写操作传递同一 `req` 以维持事务。

## 7. 认证和权限

### 管理员

- `admins` 是独立 Auth Collection；
- 使用 Payload 本地密码认证和 Session；
- 角色固定为 `content_editor`、`ad_operator`、`analyst`、`system_admin`；
- 密码后必须通过自定义 TOTP 才能访问 `/admin`；
- TOTP secret 加密保存，恢复码只保存哈希；
- 高风险操作仅限 `system_admin` 并记录审计。

### 普通用户

- `customers` 手机号唯一，关闭密码登录；
- OTP challenge 只保存哈希，短有效期、有限次数、一次性消费；
- 对手机号、IP、设备和全局流量限频，响应不得泄露手机号是否存在；
- 登录生成随机 256-bit opaque token，数据库只保存 token hash；
- Cookie 必须 Secure、HttpOnly、SameSite，并防 Session fixation；
- Custom Strategy 从 Cookie 恢复 customer；
- 支持撤销当前和全部会话。

## 8. API 与前端

- 公开内容由 Server Components 使用 Payload Local API 读取已发布版本；
- 浏览器业务写操作只经过 `/api/v1` 自定义 endpoints；
- 请求/响应使用共享 Zod schema；
- 前端类型使用 `payload-types.ts` 和明确的 view model；
- 优先 Server Component，只有交互或浏览器 API 才使用 Client Component；
- 必须实现 loading、empty、partial、error、rate-limited 和 stale 状态；
- 查询结果页 `noindex`；不得长期保存完整查询域名；
- 错误返回稳定 code、用户可读 message 和 traceId，不返回堆栈或秘密。

## 9. 交易不变量

### 订单状态

只允许：

```text
pending_payment
paid
fulfilling
succeeded
refund_pending
refunding
refunded
manual_review
cancelled
```

状态迁移集中到 commerce service 并进行单元和集成测试。保存当前状态与追加 `orderEvents`。前端跳转、管理员直接改字段或 provider 未确认响应不得跳过状态机。

合法迁移以 `Wanmi.AI-技术栈.md` 第 6.1 节矩阵为唯一工程基线。`manual_review` 的恢复履约、确认成功、发起退款或确认已退款均必须有外部查询/书面证据、处理备注和审计；未定义迁移一律拒绝。

### 金额和报价

- 金额使用整数最小货币单位或精确 decimal，禁止浮点；
- 报价保存上游成本、加价规则、最终价和 5 分钟有效期快照；
- 未配置加价的 TLD 不开放购买；
- 创建订单时重新验证报价、TLD、实名模板和域名状态；
- 支付金额必须与服务端订单一致。

### 支付、注册和退款

- 只接受服务端验签并确认的微信通知/查单结果；
- 微信交易号、商户订单号和退款号有唯一约束；
- 已支付订单通过 Payload `commerce` Job 履约；
- 每个 provider operation 有唯一业务键；
- 明确未提交前可重试；请求发出后超时进入 `manual_review`，之后只查询状态；
- 禁止对状态不明的注册或续费自动重复提交；
- 注册成功不可退款，明确失败自动原路全额退款；
- 退款失败、争议、余额不足和状态不明进入人工处理；
- 用户域名必须注册在用户实名模板名下，不得登记在 Wanmi 公司名下；
- P1 不建设钱包，微信资金与西部数码预充值余额分别对账。

## 10. Payload Jobs

队列固定为：

- `publishing`：定时发布、sitemap；
- `background`：通知、同步、聚合、清理；
- `commerce`：注册、续费、退款、NS 变更和对账。

规则：

- Worker 是独立进程，不能依赖 Web 请求持续执行；
- `commerce` 从并发 1 开始并与其他队列隔离；
- Payload retry/concurrency 不能替代唯一约束和业务幂等；
- 任务重复执行、Worker 重启和通知重放必须安全；
- provider 写请求发出后的超时不能自动重试；
- 工具实时查询不进入 Jobs。

## 11. 外部适配器

外部能力统一放入 `src/providers` 并通过接口注入：

- `westdigital`：可售、价格、实名、注册、续费、NS 和余额；
- `wechatpay`：Native/H5 下单、通知验签、查单、退款和账单；
- `aliyunsms`：通过 Alibaba Cloud TypeScript SDK 完成 OTP、订单通知和到期提醒；
- `whodat`：RDAP/WHOIS；
- `oss-public`：通过 `@payloadcms/storage-s3` 管理公共媒体；
- `oss-realname`：通过 `ali-oss` 管理私有证件对象；
- `realname/master-key`：使用版本化应用主密钥包裹每对象随机数据密钥；旧版本有对象引用时必须保留。

凡涉及西部数码 API 的调研、字段映射、fixture/mock、transport、错误映射、联调或代码审核，开始前必须先查阅仓库根目录的本地文档 `西部数码业务API接口文档（v2）新.md`，并以该文档作为当前项目的西部数码接口依据。不得凭记忆、网络搜索结果或其他项目实现猜测 URL、请求字段、响应字段、价格单位、鉴权或错误语义；文档缺失、描述不明确或与现有实现冲突时，停止相关实现并向项目负责人确认。该本地文档仅供只读参考，不因本规则自动纳入版本控制，也不构成真实接口、真实凭据或写操作授权。

每个 adapter 需具备超时、限流、错误映射、结构化脱敏日志、fixtures/mock、健康状态和可审计请求标识。没有项目负责人明确授权，测试不得执行真实资金、域名或短信写操作。

## 12. 安全和隐私

- 输入使用 Zod 并在业务层再次验证权限与状态；
- DNS/TLS/URL 查询防 SSRF：阻止 loopback、私网、link-local、元数据地址和重绑定；
- 限制超时、响应大小、记录数、并发和允许端口；
- Unicode 域名规范化并显示 Punycode；
- 实名文件使用独立私有 Collection、OSS 私有前缀和版本化应用主密钥信封加密；
- 证件只允许短时访问，访问、替换和删除全审计；
- 删除模板或注销后 30 天内清理主存储和备份；
- 日志不得包含完整手机号、身份证号、Cookie、OTP、证件、私钥、支付密钥或 provider secret；
- Secret 只通过环境与受控密钥系统提供，`.env.example` 不含真实值。

## 13. 测试与完成定义

至少运行：

- `pnpm lint`；
- `pnpm typecheck`；
- `pnpm test`；
- 涉及数据库、Payload access、Jobs 或 provider 时运行集成测试；
- 涉及路由、Admin 或核心交互时运行生产构建和必要的浏览器验证；
- 涉及迁移时在空库和升级路径验证。

必测场景：

- Local API 未设置 `overrideAccess: false` 的防护回归；
- 权限矩阵和字段级隐私；
- OTP 限频、重放、Session 固定、撤销；
- 草稿、版本、定时发布和下线；
- 报价过期、价格变化和金额边界；
- 支付重复/乱序/伪造通知；
- Job 重复、Worker 重启和 provider 超时；
- 自动退款、退款失败、人工复核和三方对账；
- DNS/TLS SSRF、上传、OSS/应用主密钥、证件删除；
- Payload migrations、节点重建和通知重放。

“完成”必须同时满足：功能符合 PRD、权限和错误路径完整、测试通过、迁移/类型已同步、日志可审计、相关开发计划已更新。只实现 happy path 不算完成。

## 14. D0 约束

业务开发前以 3～5 天作为 D0 架构决策时间盒完成验证。通常任一退出条件未满足时必须延长 D0、记录证据并修正假设，不得自行跳过：

- Next.js 16.2.11 + Payload 3.86.0 + PostgreSQL；
- 草稿、版本、定时发布、角色权限；
- Payload SEO、Redirects、Form Builder 插件启动、迁移、类型生成和权限边界；
- 管理员密码/TOTP 原型；
- customer SMS OTP mock、opaque Session 和全部撤销；
- `commerce` Job、concurrency key、事务和状态事件；
- 公共媒体 `storage-s3` 的 OSS S3 兼容上传、读取、删除、签名地址和 ETag；
- 私有实名文件 `ali-oss` 与版本化应用主密钥的上传、信封加密、短时访问和删除原型；
- 单 ECS 内存、重启和 Jobs 恢复；
- `overrideAccess: false` 权限测试。

D0 未通过时修正假设，不引入第二套后端作为绕过。

项目负责人于 2026-08-04 明确批准 D0 条件通过并进入 D1。该批准只延期以下必须在部署阶段、D7 完成且在真实收款或生产上线前通过的运行环境门槛：

- 在 2 vCPU/4 GiB ECS 或等价生产 Linux 资源限制下测量 Web、Worker 和 Who-Dat 内存；
- Web/Worker 独立重启、同 VPC `commerce` Job 强制中断恢复；
- 空节点重建和两小时 RTO 演练。

当前共享 ECS 仍承载其他项目时不得部署 Wanmi、压测、重启现有服务或执行重建。条件通过不豁免任何功能、安全、迁移、幂等或生产上线门槛；D1 中若出现主架构、权限、迁移或 Jobs 假设失败，必须返回 D0 修正并记录证据。

## 15. 上线边界

开发批准不等于生产上线批准。以下项目完成前不得真实收款或上线：

- 西部数码写接口书面确认和联调；
- 域名代理资质、Wanmi 与西部数码责任边界和页面披露方式经外部专业人员复核，页面显著标明所代理的域名注册服务机构；
- ICP 与公安联网备案；
- RDS HA、PITR 和恢复验证；
- OSS 私有访问、应用主密钥信封加密、版本控制、删除和误删恢复；
- 密钥轮换、支付告警和三方对账；
- ECS 重建、Payload migrations、Jobs 恢复和支付通知重放演练；
- 项目负责人最终批准。
