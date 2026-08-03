# Wanmi.AI App 候选技术规划

> 文档版本：v2.2（Payload Web 主架构同步版）
>
> 更新日期：2026-08-02
>
> 冻结基线：`P1-BASELINE-2026-08-03`；对应 Git 标签 `p1-docs-approved-2026-08-03`
>
> 当前结论：App 不进入 P0、P1 或默认 P2；只有 Web 数据证明必要时进入 P3 候选
>
> Web P1 基线：项目负责人一人 + ChatGPT/Codex；全量一次交付，目标 12～16 周；开发已批准、生产上线附条件批准
>
> 关联文档：[产品规划与商业评估](./Wanmi.AI-产品规划与商业评估.md) · [产品需求文档](./Wanmi.AI-产品需求文档-PRD.md) · [技术栈与工程规范](./Wanmi.AI-技术栈.md)

本文件仅保留未来可能建设 App 时的技术边界，不构成开发、采购、排期或应用商店承诺。Web P1 已批准手机账号、实名、微信支付、代理注册、续费和域名资产，不代表这些能力自动进入未来 App。

## 1. 为什么暂不建设 App

Wanmi P1 的核心是通过 Web 工具和内容获得搜索流量，并在 Web 内完成代理注册服务闭环。原生 App：

- 不能承担 SEO 获客；
- 需要额外的开发、测试、推送和商店运营；
- 工具的低频查询场景未必产生安装意愿；
- 会分散 P1 对工具质量、内容、支付和注册履约的建设；
- 不因为已有 React Native 技术方案就自动产生产品价值。

因此 P1 只建设响应式 Web，并用真实数据判断用户是否需要 App。

## 2. 启动门槛

以下条件必须全部满足：

- Web 已有稳定自然流量；
- 移动端访问占比和 30 日回访率达到产品负责人批准的门槛；
- 用户访谈和候补名单证明存在明确安装意愿；
- 至少一个能力必须依赖或显著受益于原生客户端，例如可靠推送、设备快捷入口或高频监控；
- App 能提高留存、订阅、会员或广告价值；
- 团队具备 iOS、国产 Android 真机和应用商店维护能力；
- 已有版本化 API、账号体系和推送合规方案；
- Web 支付、实名、注册、续费和域名资产已经稳定运行；
- 预计增量收益能覆盖双端开发、测试、商店和长期维护成本。

如果响应式 Web、PWA 或邮件订阅已经满足需求，不建设 App。

## 3. 候选产品范围

### 3.1 首发候选

- 域名可注册查询；
- RDAP/WHOIS；
- DNS、NS、SSL 和 CAA 检查；
- TLD 价格和成本；
- 跨设备收藏与历史；
- 域名、DNS、证书和价格变化提醒；
- 资讯、专题和收藏内容；
- 账号、安全中心和设备管理；
- 会员或去广告权益。

### 3.2 首发不做

- App 运营后台；
- 自营域名交易；
- 实名资料上传；
- App 内支付；
- DNS 写操作；
- 社区、私信和群聊；
- 独立 App 用户数据库；
- 交易或高风险操作离线队列；
- 只依赖推送承担关键通知。

即使 Web P1 已具备代理注册能力，App 支付、实名上传、注册、续费和域名管理仍需单独 PRD、应用商店支付政策与合规评审，不因复用 API 自动进入 App 首发。

## 4. 技术方向

| 层 | 候选选择 | 约束 |
| --- | --- | --- |
| 双端框架 | React Native + Expo 稳定 SDK | 一套源码生成 iOS/Android |
| 开发客户端 | Expo Development Build | 不以 Expo Go 为生产基线 |
| 语言 | TypeScript strict | 接口边界必须校验 |
| 路由 | Expo Router | 客户端保护不能代替服务端鉴权 |
| 服务端状态 | TanStack Query | 写操作不无条件自动重试 |
| API 客户端 | 共享 Zod schemas + 生成的 Payload 领域类型 | 复用 Web 业务 endpoint，不直接访问敏感 Collections |
| 表单 | React Hook Form + Zod | 服务端最终校验 |
| 凭据 | expo-secure-store | 只保存轮换刷新凭据和设备密钥 |
| 普通数据 | AsyncStorage | 只保存非敏感偏好和只读缓存 |
| 离线数据 | expo-sqlite，按需 | 只读缓存和草稿 |
| UI | React Native 核心组件 + 设计令牌 | 不强行共享 Web UI |
| 构建 | EAS Build 或经验证的本地构建 | development、preview、production |
| 测试 | jest-expo、RN Testing Library、Maestro | 国产 Android 真机矩阵 |

启动时选择当时最新稳定 Expo SDK，完成推送、深链接、监控和目标商店 POC 后再冻结版本。

## 5. 统一账号与 API

- App、Web 和后台继续使用同一 Payload `customers.id` 和业务数据库；
- App 只访问 https://wanmi.net/api/v1；
- 不直连 RDS、OSS 私有 Bucket、Who-Dat、西部数码或广告数据库；
- Web 使用安全 Cookie；
- App 使用短访问令牌 + 单次轮换刷新令牌；
- 刷新凭据保存在 SecureStore；
- 服务端保存设备、会话摘要、最近使用和撤销状态；
- 用户可以查看和下线设备；
- 发现刷新令牌重放时撤销令牌家族。

## 6. 工具、广告与隐私

- 弱网可展示带更新时间的只读缓存；
- 不把缓存结果包装成实时结果；
- App 内广告必须与 Web 一样清晰标识；
- 广告不得遮挡工具输入和核心结果；
- 不向广告主传递完整查询域名、访问令牌或设备标识；
- 同一平台只保留一套远程推送；
- 推送内容不包含敏感查询详情；
- App 崩溃报告不包含令牌、完整域名或个人信息。

是否展示广告、会员去广告和 App 专属广告位，需要在独立 App PRD 中决定。

## 7. 深链接与推送

- 生产链接统一使用 https://wanmi.net；
- 配置 Universal Links 和 App Links；
- 工具、文章、TLD、收藏和通知映射到明确路由；
- Web 页面始终是未安装 App 时的完整降级；
- iOS 使用 APNs；
- Android 根据实际市场接入华为、荣耀、小米、OPPO、vivo 等厂商通道；
- 推送只用于用户主动订阅的状态、价格和内容提醒；
- 每类推送可单独关闭；
- 到达率、打开率、退订和无效 token 可观测。

## 8. 发布与质量门槛

发布前：

- iOS 与 Android 核心工具 E2E 通过；
- 覆盖最低支持系统和主流国产 Android 真机；
- 弱网、离线缓存、深链接、推送和会话轮换通过；
- 崩溃率、ANR、冷启动和 API 错误达到目标；
- 旧版 App 在后端升级后仍能完成核心工具和账号操作；
- 广告关闭或失败不影响工具；
- 隐私清单、SDK 清单和商店材料完成审核；
- 运营有版本更新、下架、紧急关闭和用户支持流程。

## 9. 重新评审要求

决定启动 App 时，必须重新编写：

- App 商业论证；
- App 产品 PRD；
- 平台功能范围；
- 推送与隐私评估；
- 广告和会员方案；
- 应用商店发布清单；
- 人员、工期和成本预算；
- 成功指标和停止线。
- App 是否包含 Web 已有的支付、实名、注册、续费和域名资产能力。

本文件不能单独作为 App 开工依据。

## 10. 官方资料

- [Expo SDK](https://docs.expo.dev/versions/latest/)
- [Expo Development Builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo Router](https://docs.expo.dev/router/introduction/)
- [Expo Authentication 与 SecureStore](https://docs.expo.dev/guides/authentication/)
- [TanStack Query React Native](https://tanstack.com/query/latest/docs/framework/react/react-native)
- [Expo Linking](https://docs.expo.dev/linking/overview/)
- [EAS Build 与 Update](https://docs.expo.dev/build/updates/)
