# 前端 API 接入契约

## 1. 适用范围与扫描口径

本文供独立仓库中的新前端对照使用。最终前端会合并回
`apps/web/src/app/(frontend)/`，与 Next.js/Payload 同源部署；普通用户和管理员的认证模型、
Cookie 与 Session 均不改变。

本文基于 `main@b5a42d7` 机械扫描 `apps/web/src/app/api/**/route.ts`：共 106 个
`route.ts`、122 个 HTTP 方法。路径中的 `:name` 对应 Next.js 的 `[name]` 动态段。端点表只记录
路由或其直接服务边界**实际执行**的 Zod 校验，不把 TypeScript 参数、Payload 文档类型或返回对象
臆测为 schema。

表中 `file.ts:line#name` 默认位于 `apps/web/src/schemas/`，同时给出真实声明行和导出名；
`route-local` 表示 schema 只在对应 `route.ts` 内声明、不是导出；`—` 表示当前没有该方向的 Zod
边界。若响应列为 `—`，前端不得手写响应类型，应先补后端导出 schema 再接入。二进制下载和
微信回调按协议标注，不应作为 JSON 解析。

## 2. 全部端点清单

### 2.1 工具

| 方法   | 路径                          | 请求 schema                                     | 响应 schema                                    |
| ------ | ----------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `POST` | `/api/v1/tools/dns`           | `dns.ts:11#dnsLookupRequestSchema`              | `dns.ts:161#dnsLookupResultSchema`             |
| `POST` | `/api/v1/tools/domain-search` | `domain-search.ts:16#domainSearchRequestSchema` | `domain-search.ts:67#domainSearchResultSchema` |
| `POST` | `/api/v1/tools/idn`           | `idn.ts:7#idnConversionRequestSchema`           | `idn.ts:25#idnConversionResultSchema`          |
| `POST` | `/api/v1/tools/pricing`       | `pricing.ts:8#pricingRequestSchema`             | `pricing.ts:74#pricingResultSchema`            |
| `POST` | `/api/v1/tools/ssl-check`     | `tls.ts:11#sslCheckRequestSchema`               | `tls.ts:150#sslCheckResultSchema`              |
| `POST` | `/api/v1/tools/whois`         | `whois.ts:5#whoisLookupRequestSchema`           | `whois.ts:39#whoisLookupResultSchema`          |

### 2.2 内容、表单与统计

| 方法   | 路径                                       | 请求 schema                                                            | 响应 schema                                    |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `POST` | `/api/v1/content/:collection/:id/workflow` | `content.ts:5#contentWorkflowInputSchema`                              | —                                              |
| `POST` | `/api/v1/events`                           | `analytics.ts:157#firstPartyEventSchema`                               | —                                              |
| `POST` | `/api/v1/forms/submissions`                | `forms.ts:51#publicFormSubmissionRequestSchema`（由 service 边界解析） | `forms.ts:65#publicFormSubmissionResultSchema` |

### 2.3 账号、认证、身份与实名

#### 账号

| 方法     | 路径                                                 | 请求 schema                                                                                           | 响应 schema                                           |
| -------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST`   | `/api/v1/account/closure-requests/:requestId/revoke` | `auth.ts:317#accountClosureRequestIdSchema`；`auth.ts:321#accountClosureRevokeSchema`                 | `auth.ts:328#accountClosureRevokeResponseSchema`      |
| `POST`   | `/api/v1/account/consents`                           | `privacy.ts:8#customerConsentDecisionSchema`                                                          | `privacy.ts:24#consentDecisionResponseSchema`         |
| `PATCH`  | `/api/v1/account/default-profile-type`               | `auth.ts:234#defaultCustomerProfileTypeSchema`                                                        | —                                                     |
| `DELETE` | `/api/v1/account/identities/:identityId`             | `auth.ts:269#identityIdParamsSchema`                                                                  | —                                                     |
| `POST`   | `/api/v1/account/identities/bind`                    | `auth.ts:238#identityBindSchema`                                                                      | —                                                     |
| `POST`   | `/api/v1/account/invitations/bind`                   | `auth.ts:242#invitationBindSchema`                                                                    | `auth.ts:256#invitationBindResponseSchema`            |
| `POST`   | `/api/v1/account/invitations/code/disable`           | —                                                                                                     | `auth.ts:265#invitationCodeDisableResponseSchema`     |
| `POST`   | `/api/v1/account/legacy-profile-completion`          | `privacy.ts:15#legacyProfileCompletionSchema`                                                         | `privacy.ts:30#legacyProfileCompletionResponseSchema` |
| `PATCH`  | `/api/v1/account/notification-preferences`           | `admin-approvals.ts:130#notificationPreferenceUpdateSchema`                                           | —                                                     |
| `POST`   | `/api/v1/account/notifications/:eventId/read`        | `apps/web/src/app/api/v1/account/notifications/[eventId]/read/route.ts:9#paramsSchema`（route-local） | —                                                     |
| `GET`    | `/api/v1/account/notifications`                      | —                                                                                                     | —                                                     |
| `GET`    | `/api/v1/account/personal-information/export`        | —                                                                                                     | `privacy.ts:85#personalInformationResponseSchema`     |
| `GET`    | `/api/v1/account/personal-information`               | —                                                                                                     | `privacy.ts:85#personalInformationResponseSchema`     |
| `POST`   | `/api/v1/account/vip/appeals`                        | `vip-tiers.ts:32#vipTierAppealCreateSchema`                                                           | —                                                     |
| `GET`    | `/api/v1/account/vip`                                | —                                                                                                     | —                                                     |

#### 认证与微信身份

| 方法   | 路径                                         | 请求 schema                                 | 响应 schema                                        |
| ------ | -------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `POST` | `/api/v1/auth/account-recovery`              | `auth.ts:409#accountRecoveryRequestSchema`  | `auth.ts:421#accountRecoveryRequestResponseSchema` |
| `POST` | `/api/v1/auth/deletion-request`              | `auth.ts:298#customerDeletionRequestSchema` | `auth.ts:309#customerDeletionResponseSchema`       |
| `POST` | `/api/v1/auth/logout`                        | `auth.ts:190#logoutSchema`                  | —                                                  |
| `POST` | `/api/v1/auth/register`                      | `auth.ts:194#customerRegistrationSchema`    | —                                                  |
| `POST` | `/api/v1/auth/sms/request`                   | `auth.ts:152#smsRequestSchema`              | —                                                  |
| `POST` | `/api/v1/auth/sms/verify`                    | `auth.ts:158#smsVerifySchema`               | —                                                  |
| `POST` | `/api/v1/auth/step-up/request`               | `auth.ts:166#stepUpRequestSchema`           | —                                                  |
| `POST` | `/api/v1/auth/step-up/verify`                | `auth.ts:174#stepUpVerifySchema`            | `auth.ts:183#stepUpGrantResponseSchema`            |
| `GET`  | `/api/v1/auth/wechat/callback`               | 微信服务号原始回调协议；无 Zod schema       | 微信回调协议响应；无 Zod schema                    |
| `POST` | `/api/v1/auth/wechat/callback`               | 微信服务号原始回调协议；无 Zod schema       | 微信回调协议响应；无 Zod schema                    |
| `GET`  | `/api/v1/auth/wechat/oauth/callback`         | `auth.ts:275#wechatOAuthCallbackSchema`     | HTTP 跳转；无 JSON schema                          |
| `POST` | `/api/v1/auth/wechat/oauth/start`            | `auth.ts:271#wechatOAuthStartSchema`        | —                                                  |
| `POST` | `/api/v1/auth/wechat/qrcode/confirm/preview` | `auth.ts:290#wechatQrConfirmSchema`         | —                                                  |
| `POST` | `/api/v1/auth/wechat/qrcode/confirm`         | `auth.ts:290#wechatQrConfirmSchema`         | —                                                  |
| `POST` | `/api/v1/auth/wechat/qrcode/consume`         | `auth.ts:294#wechatQrConsumeSchema`         | —                                                  |
| `POST` | `/api/v1/auth/wechat/qrcode/create`          | `auth.ts:280#wechatQrCreateSchema`          | —                                                  |
| `POST` | `/api/v1/auth/wechat/qrcode/poll`            | `auth.ts:288#wechatQrPollSchema`            | —                                                  |

#### 实名模板与私有证件

| 方法     | 路径                                               | 请求 schema                                                                                                                       | 响应 schema                                                       |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `POST`   | `/api/v1/realname/documents/:documentId/access`    | `realname-documents.ts:3#realnameDocumentIdSchema`；`realname-documents.ts:6#realnameDocumentAccessRequestSchema`                 | `realname-documents.ts:18#realnameDocumentAccessResponseSchema`   |
| `DELETE` | `/api/v1/realname/documents/:documentId`           | `realname-documents.ts:3#realnameDocumentIdSchema`                                                                                | `realname-documents.ts:23#realnameDocumentMutationResponseSchema` |
| `POST`   | `/api/v1/realname/documents/:documentId/submit`    | `realname-documents.ts:3#realnameDocumentIdSchema`                                                                                | `realname-documents.ts:23#realnameDocumentMutationResponseSchema` |
| `GET`    | `/api/v1/realname/documents/access`                | `ticket` 查询参数；无 Zod schema                                                                                                  | 私有文件二进制流                                                  |
| `POST`   | `/api/v1/realname/templates/:templateId/documents` | `realname-documents.ts:4#realnameTemplateIdSchema`；受控 multipart 文件                                                           | `realname-documents.ts:10#realnameDocumentSummarySchema`          |
| `DELETE` | `/api/v1/realname/templates/:templateId`           | `realname-documents.ts:4#realnameTemplateIdSchema`                                                                                | —                                                                 |
| `PATCH`  | `/api/v1/realname/templates/:templateId`           | `realname-documents.ts:4#realnameTemplateIdSchema`；`apps/web/src/services/realname/templates.ts:85#createRealnameTemplateSchema` | —                                                                 |

### 2.4 报价、订单与支付

| 方法   | 路径                                   | 请求 schema                                | 响应 schema                                 |
| ------ | -------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `POST` | `/api/v1/quotes`                       | `quotes.ts:7#quoteCreateRequestSchema`     | `quotes.ts:61#quoteCreationResultSchema`    |
| `POST` | `/api/v1/orders`                       | `orders.ts:7#orderCreateRequestSchema`     | `orders.ts:25#orderCreationResultSchema`    |
| `GET`  | `/api/v1/orders/:orderNumber/payments` | —                                          | `payments.ts:52#paymentStatusResultSchema`  |
| `POST` | `/api/v1/orders/:orderNumber/payments` | `payments.ts:7#paymentCreateRequestSchema` | `payments.ts:43#paymentSessionResultSchema` |
| `POST` | `/api/v1/payments/wechat/notify`       | 微信支付验签原始通知；无 Zod schema        | 微信支付通知协议响应；无 Zod schema         |
| `POST` | `/api/v1/refunds/wechat/notify`        | 微信退款验签原始通知；无 Zod schema        | 微信退款通知协议响应；无 Zod schema         |

### 2.5 钱包

| 方法   | 路径                                                | 请求 schema                                        | 响应 schema                                                           |
| ------ | --------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `GET`  | `/api/v1/wallet/statement`                          | `wallet-statement.ts:6#walletStatementQuerySchema` | `wallet-statement.ts:16#walletStatementSchema`（由 service 边界解析） |
| `POST` | `/api/v1/wallet/top-ups`                            | `wallet.ts:8#walletTopUpCreateRequestSchema`       | `wallet.ts:21#walletTopUpOrderResultSchema`                           |
| `GET`  | `/api/v1/wallet/top-ups/:topUpOrderNumber/payments` | —                                                  | `wallet.ts:21#walletTopUpOrderResultSchema`                           |
| `POST` | `/api/v1/wallet/top-ups/:topUpOrderNumber/payments` | `payments.ts:17#wechatPaymentCreateRequestSchema`  | `payments.ts:43#paymentSessionResultSchema`                           |

### 2.6 域名资产、DNS 与续费

| 方法     | 路径                                                          | 请求 schema                                                                                                                                                                                                | 响应 schema                                                    |
| -------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/api/v1/domains`                                             | `domains.ts:90#domainAssetListQuerySchema`                                                                                                                                                                 | `domains.ts:80#domainAssetListResultSchema`                    |
| `GET`    | `/api/v1/domains/:assetId`                                    | `apps/web/src/app/api/v1/domains/[assetId]/route.ts:12#assetIdSchema`（route-local）                                                                                                                       | `domains.ts:206#domainAssetDetailResultSchema`                 |
| `POST`   | `/api/v1/domains/:assetId/sync`                               | `apps/web/src/app/api/v1/domains/[assetId]/sync/route.ts:14#assetIdSchema`（route-local）                                                                                                                  | `domains.ts:206#domainAssetDetailResultSchema`                 |
| `GET`    | `/api/v1/domains/:assetId/capabilities`                       | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`                                                                                                           | `domain-management.ts:67#domainCapabilitiesResultSchema`       |
| `GET`    | `/api/v1/domains/:assetId/certificate`                        | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`                                                                                                           | 域名证书二进制流                                               |
| `PUT`    | `/api/v1/domains/:assetId/contact-information`                | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domain-management.ts:23#domainContactUpdateRequestSchema`                                               | `domain-management.ts:40#domainManagementMutationResultSchema` |
| `GET`    | `/api/v1/domains/:assetId/dns-records`                        | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`apps/web/src/app/api/v1/domains/[assetId]/dns-records/route.ts:25#listQuerySchema`（route-local）                                  | `dns-management.ts:108#dnsRecordListResultSchema`              |
| `POST`   | `/api/v1/domains/:assetId/dns-records`                        | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`dns-management.ts:67#dnsRecordAddRequestSchema`                                                                                    | `dns-management.ts:134#dnsRecordMutationResultSchema`          |
| `GET`    | `/api/v1/domains/:assetId/dns-records/:recordId`              | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`apps/web/src/app/api/v1/domains/_dns-request.ts:11#dnsProviderRecordIdSchema`                                                      | `dns-management.ts:117#dnsRecordDetailResultSchema`            |
| `PATCH`  | `/api/v1/domains/:assetId/dns-records/:recordId`              | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`apps/web/src/app/api/v1/domains/_dns-request.ts:11#dnsProviderRecordIdSchema`；`dns-management.ts:73#dnsRecordModifyRequestSchema` | `dns-management.ts:134#dnsRecordMutationResultSchema`          |
| `DELETE` | `/api/v1/domains/:assetId/dns-records/:recordId`              | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`apps/web/src/app/api/v1/domains/_dns-request.ts:11#dnsProviderRecordIdSchema`；`dns-management.ts:81#dnsRecordDeleteRequestSchema` | `dns-management.ts:134#dnsRecordMutationResultSchema`          |
| `POST`   | `/api/v1/domains/:assetId/dns-records/:recordId/status`       | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`apps/web/src/app/api/v1/domains/_dns-request.ts:11#dnsProviderRecordIdSchema`；`dns-management.ts:86#dnsRecordStatusRequestSchema` | `dns-management.ts:134#dnsRecordMutationResultSchema`          |
| `POST`   | `/api/v1/domains/:assetId/dns-records/batch-delete/preview`   | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`dns-management.ts:94#dnsRecordBatchPreviewRequestSchema`                                                                           | `dns-management.ts:136#dnsRecordBatchPreviewResultSchema`      |
| `POST`   | `/api/v1/domains/:assetId/dns-records/batch-delete`           | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`dns-management.ts:98#dnsRecordBatchDeleteRequestSchema`                                                                            | `dns-management.ts:144#dnsRecordBatchDeleteResultSchema`       |
| `GET`    | `/api/v1/domains/:assetId/dns-records/batch-delete/:batchKey` | `apps/web/src/app/api/v1/domains/_dns-request.ts:10#dnsAssetIdSchema`；`batchKey` 无 Zod schema                                                                                                            | `dns-management.ts:144#dnsRecordBatchDeleteResultSchema`       |
| `PUT`    | `/api/v1/domains/:assetId/lock`                               | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domains.ts:128#domainLockRequestSchema`                                                                 | `domains.ts:141#domainLockResultSchema`                        |
| `POST`   | `/api/v1/domains/:assetId/management-password`                | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domain-management.ts:11#domainManagementPasswordRevealRequestSchema`                                    | `domain-management.ts:36#domainManagementPasswordResultSchema` |
| `PUT`    | `/api/v1/domains/:assetId/management-password`                | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domain-management.ts:16#domainManagementPasswordModifyRequestSchema`                                    | `domain-management.ts:40#domainManagementMutationResultSchema` |
| `POST`   | `/api/v1/domains/:assetId/nameservers`                        | `apps/web/src/app/api/v1/domains/[assetId]/nameservers/route.ts:12#assetIdSchema`（route-local）；`domains.ts:214#nameserverChangeRequestSchema`                                                           | `domains.ts:221#nameserverChangeResultSchema`                  |
| `POST`   | `/api/v1/domains/:assetId/renewal-mandate/preview`            | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domains.ts:158#renewalMandatePreviewRequestSchema`                                                      | `domains.ts:185#renewalMandatePreviewResultSchema`             |
| `GET`    | `/api/v1/domains/:assetId/renewal-mandate`                    | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`                                                                                                           | `domains.ts:202#renewalMandateResultSchema`                    |
| `PUT`    | `/api/v1/domains/:assetId/renewal-mandate`                    | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domains.ts:169#renewalMandateChangeRequestSchema`                                                       | `domains.ts:202#renewalMandateResultSchema`                    |
| `DELETE` | `/api/v1/domains/:assetId/renewal-mandate`                    | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domains.ts:169#renewalMandateChangeRequestSchema`                                                       | `domains.ts:202#renewalMandateResultSchema`                    |
| `PUT`    | `/api/v1/domains/:assetId/tags`                               | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domains.ts:101#domainAssetTagsRequestSchema`                                                            | `domains.ts:121#domainAssetPreferenceResultSchema`             |
| `POST`   | `/api/v1/domains/:assetId/template-transfer`                  | `apps/web/src/app/api/v1/domains/_domain-management-request.ts:10#domainManagementAssetIdSchema`；`domain-management.ts:30#domainTemplateTransferRequestSchema`                                            | `domain-management.ts:40#domainManagementMutationResultSchema` |
| `POST`   | `/api/v1/domains/nameservers/batch/preview`                   | `domains.ts:226#nameserverBatchPreviewRequestSchema`                                                                                                                                                       | `domains.ts:264#nameserverBatchPreviewResultSchema`            |
| `POST`   | `/api/v1/domains/nameservers/batch`                           | `domains.ts:232#nameserverBatchRequestSchema`                                                                                                                                                              | `domains.ts:273#nameserverBatchResultSchema`                   |
| `GET`    | `/api/v1/domains/nameservers/batch/:batchKey`                 | `batchKey` 无 Zod schema                                                                                                                                                                                   | `domains.ts:273#nameserverBatchResultSchema`                   |
| `PATCH`  | `/api/v1/domains/reminder-preferences`                        | `domains.ts:106#domainExpiryReminderPreferencesRequestSchema`                                                                                                                                              | `domains.ts:121#domainAssetPreferenceResultSchema`             |

### 2.7 后台

| 方法     | 路径                                                          | 请求 schema                                                                                                                                                                         | 响应 schema                                                                                                        |
| -------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POST`   | `/api/v1/admin/account-closures/:requestId/execute`           | `auth.ts:317#accountClosureRequestIdSchema`；`auth.ts:334#accountClosureExecuteSchema`                                                                                              | `auth.ts:341#accountClosureExecuteResponseSchema`                                                                  |
| `POST`   | `/api/v1/admin/account-recoveries/:reviewId/decision`         | `apps/web/src/app/api/v1/admin/account-recoveries/[reviewId]/decision/route.ts:11#reviewIdSchema`（route-local）；`auth.ts:427#accountRecoveryDecisionSchema`                       | —                                                                                                                  |
| `GET`    | `/api/v1/admin/approval-policy`                               | —                                                                                                                                                                                   | —                                                                                                                  |
| `PATCH`  | `/api/v1/admin/approval-policy`                               | `admin-approvals.ts:25#adminApprovalPolicyUpdateSchema`                                                                                                                             | —                                                                                                                  |
| `POST`   | `/api/v1/admin/approval-requests/:requestId/decision`         | `admin-approvals.ts:126#adminApprovalRequestIdSchema`；`admin-approvals.ts:122#adminApprovalDecisionSchema`                                                                         | —                                                                                                                  |
| `POST`   | `/api/v1/admin/approval-requests/:requestId/execute`          | `admin-approvals.ts:126#adminApprovalRequestIdSchema`                                                                                                                               | —                                                                                                                  |
| `GET`    | `/api/v1/admin/approval-requests`                             | —                                                                                                                                                                                   | —                                                                                                                  |
| `POST`   | `/api/v1/admin/approval-requests`                             | `admin-approvals.ts:35#adminApprovalCreateSchema`                                                                                                                                   | —                                                                                                                  |
| `DELETE` | `/api/v1/admin/auth/invitations/:id`                          | `auth.ts:91#adminInvitationIdParamsSchema`                                                                                                                                          | `auth.ts:131#adminInvitationRevokeResponseSchema`                                                                  |
| `POST`   | `/api/v1/admin/auth/invitations/accept`                       | `Authorization`：`auth.ts:62#adminInvitationBearerSchema`；body：`auth.ts:57#adminInvitationAcceptSchema`                                                                           | `auth.ts:126#adminInvitationAcceptResponseSchema`                                                                  |
| `POST`   | `/api/v1/admin/auth/invitations/resolve`                      | `Authorization`：`auth.ts:62#adminInvitationBearerSchema`                                                                                                                           | `auth.ts:121#adminInvitationResolveResponseSchema`                                                                 |
| `GET`    | `/api/v1/admin/auth/invitations`                              | —                                                                                                                                                                                   | `auth.ts:112#adminInvitationListResponseSchema`                                                                    |
| `POST`   | `/api/v1/admin/auth/invitations`                              | `auth.ts:52#adminInvitationCreateSchema`                                                                                                                                            | `auth.ts:116#adminInvitationCreateResponseSchema`                                                                  |
| `POST`   | `/api/v1/admin/auth/login`                                    | `auth.ts:18#adminLoginSchema`                                                                                                                                                       | `auth.ts:110#adminLoginResponseSchema`                                                                             |
| `POST`   | `/api/v1/admin/auth/logout`                                   | `auth.ts:190#logoutSchema`                                                                                                                                                          | `auth.ts:144#adminLogoutResponseSchema`                                                                            |
| `DELETE` | `/api/v1/admin/auth/sessions/:adminId/:sessionId`             | `auth.ts:99#adminSessionIdParamsSchema`                                                                                                                                             | `auth.ts:140#adminSessionRevokeResponseSchema`                                                                     |
| `GET`    | `/api/v1/admin/auth/sessions/:adminId`                        | `auth.ts:95#adminSessionAdminParamsSchema`                                                                                                                                          | `auth.ts:135#adminSessionListResponseSchema`                                                                       |
| `DELETE` | `/api/v1/admin/auth/sessions/:adminId`                        | `auth.ts:95#adminSessionAdminParamsSchema`                                                                                                                                          | `auth.ts:140#adminSessionRevokeResponseSchema`                                                                     |
| `GET`    | `/api/v1/admin/commerce/balance-control`                      | —                                                                                                                                                                                   | —                                                                                                                  |
| `PATCH`  | `/api/v1/admin/commerce/balance-control`                      | `balance-control.ts:19#balanceControlUpdateSchema`                                                                                                                                  | —                                                                                                                  |
| `POST`   | `/api/v1/admin/customers/:customerId/account-security`        | `apps/web/src/app/api/v1/admin/customers/[customerId]/account-security/route.ts:18#customerIdSchema`（route-local）；`auth.ts:376#adminCustomerAccountActionSchema`                 | 按 action：`auth.ts:405#customerSessionSecurityResponseSchema` 或 `auth.ts:397#customerAccountStateResponseSchema` |
| `GET`    | `/api/v1/admin/customers/:customerId/personal-information`    | `privacy.ts:159#adminPersonalInformationQuerySchema`                                                                                                                                | `privacy.ts:85#personalInformationResponseSchema`                                                                  |
| `POST`   | `/api/v1/admin/domains/nameserver-changes/:changeId/recheck`  | `apps/web/src/app/api/v1/admin/domains/nameserver-changes/[changeId]/recheck/route.ts:11#changeIdSchema`（route-local）                                                             | —                                                                                                                  |
| `GET`    | `/api/v1/admin/notification-deliveries`                       | —                                                                                                                                                                                   | —                                                                                                                  |
| `POST`   | `/api/v1/admin/orders/:orderNumber/manual-actions`            | `apps/web/src/app/api/v1/admin/orders/[orderNumber]/manual-actions/route.ts:11#orderNumberSchema`（route-local）；`admin-commerce.ts:20#manualOrderActionRequestSchema`             | —                                                                                                                  |
| `POST`   | `/api/v1/admin/orders/:orderNumber/payment-reconcile`         | `apps/web/src/app/api/v1/admin/orders/[orderNumber]/payment-reconcile/route.ts:14#orderNumberSchema`（route-local）；`admin-commerce.ts:13#paymentRecoveryRequestSchema`            | —                                                                                                                  |
| `POST`   | `/api/v1/admin/orders/:orderNumber/sales-stop-resolution`     | `apps/web/src/app/api/v1/admin/orders/[orderNumber]/sales-stop-resolution/route.ts:11#orderNumberSchema`（route-local）；`balance-control.ts:37#salesStopResolutionSchema`          | —                                                                                                                  |
| `POST`   | `/api/v1/admin/payments/notifications/:notificationId/replay` | `apps/web/src/app/api/v1/admin/payments/notifications/[notificationId]/replay/route.ts:14#notificationIdSchema`（route-local）；`admin-commerce.ts:13#paymentRecoveryRequestSchema` | —                                                                                                                  |
| `POST`   | `/api/v1/admin/realname/documents/:documentId/access`         | `realname-documents.ts:3#realnameDocumentIdSchema`；`realname-documents.ts:6#realnameDocumentAccessRequestSchema`                                                                   | `realname-documents.ts:18#realnameDocumentAccessResponseSchema`                                                    |
| `GET`    | `/api/v1/admin/realname/documents/access`                     | `ticket` 查询参数；无 Zod schema                                                                                                                                                    | 私有文件二进制流                                                                                                   |
| `POST`   | `/api/v1/admin/realname/templates/:templateId/review`         | `realname-documents.ts:4#realnameTemplateIdSchema`；`apps/web/src/services/realname/templates.ts:108#manualReviewResolutionSchema`                                                  | —                                                                                                                  |
| `POST`   | `/api/v1/admin/vip/promotions`                                | `vip-tiers.ts:28#vipOperationalPromotionSchema`                                                                                                                                     | —                                                                                                                  |
| `POST`   | `/api/v1/admin/vip/tier-rules`                                | `vip-tiers.ts:20#vipTierRulePublishSchema`                                                                                                                                          | —                                                                                                                  |
| `GET`    | `/api/v1/admin/wallet/policy`                                 | —                                                                                                                                                                                   | —                                                                                                                  |
| `PATCH`  | `/api/v1/admin/wallet/policy`                                 | `wallet-policy.ts:43#walletFundsPolicyUpdateSchema`                                                                                                                                 | —                                                                                                                  |

## 3. 浏览器调用约定

### 3.1 同源凭据、请求头与缓存

- 所有新前端对 `/api/v1` 的 `fetch` 都显式设置 `credentials: 'same-origin'`。认证 Cookie 由浏览器
  同源发送；不要读取、复制或写入 Session token。即使工具和公开表单当前允许匿名，也统一采用该
  选项，避免组件复用到认证端点时静默丢 Cookie。
- JSON 写请求设置 `content-type: application/json`；文件上传使用 schema/路由要求的 multipart，
  不手写 multipart boundary。
- 账户、订单、钱包、域名和后台读取设置 `cache: 'no-store'`。不要把 OTP、`stepUpToken`、
  `previewToken` 或私有文件 `ticket` 放进 URL、日志或持久存储。
- 所有成功响应和 RFC 9457 错误都应读取 `X-Request-Id`，把它用于错误展示/客服定位；前端自己
  产生的 correlation id 不能替代服务端返回值。

标准 JSON 调用模板：

```ts
import { z } from 'zod'

import { readProblemResponse } from '@/lib/errors'
import { domainAssetDetailResultSchema } from '@/schemas/domains'

type DomainAssetDetailResult = z.infer<typeof domainAssetDetailResultSchema>

export async function readDomainAsset(assetId: string): Promise<DomainAssetDetailResult> {
  const response = await fetch(`/api/v1/domains/${encodeURIComponent(assetId)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (!response.ok) throw await readProblemResponse(response)
  return domainAssetDetailResultSchema.parse(await response.json())
}
```

`readProblemResponse(response)` 只用于非 2xx 的顶层 RFC 9457 响应：它会用
`problemDetailsSchema` 校验 body，并在上游响应损坏时生成安全的 `HTTP_<status>` 兜底。成功 body
必须用端点表中的 `xxxResponseSchema.parse()` / `xxxResultSchema.parse()` 校验，不能用类型断言绕过
运行时边界。

`POST /api/v1/forms/submissions`、订单支付 GET/POST 和钱包充值支付 GET/POST 会把业务问题装入
对应 `createResultSchema` 的 `problem` 分支，即使 HTTP 状态非 2xx 也应先用表中 Result schema
解析，再按 `state` 和 `problem.code` 分支。其余使用 `problemResponse` 的端点先判断
`response.ok`，再调用 `readProblemResponse`。

### 3.2 类型唯一来源

浏览器代码的请求、响应、view model 边界类型一律从 schema 推导：

```ts
type PaymentRequest = z.infer<typeof paymentCreateRequestSchema>
type PaymentResult = z.infer<typeof paymentSessionResultSchema>
```

不得为 API body/response 手写 `interface`、复制字段形成平行 type，也不得使用
`as PaymentResult` 代替 `.parse()`。schema 文件已经导出的类型只有在其定义本身是
`z.infer<typeof schema>` 时才可复用。端点表响应列为 `—` 的能力，在补齐后端响应 schema 前只能
保持 `unknown`，不能由前端猜测契约。

## 4. 错误信封与前端分支

`apps/web/src/lib/errors.ts` 的 `problemResponse` 输出 `application/problem+json`，结构由
`apps/web/src/schemas/api.ts:8#problemDetailsSchema` 校验，符合 RFC 9457 Problem Details，并加入
Wanmi 扩展字段：

| 字段                                           | 含义                                                 |
| ---------------------------------------------- | ---------------------------------------------------- |
| `type`                                         | `urn:wanmi:problem:<CODE>`，稳定问题类型 URI         |
| `title`                                        | 面向用户的短标题                                     |
| `status`                                       | HTTP 状态码，必须与实际 response status 一致         |
| `detail` / `message`                           | 当前兼容期内两者相同的用户可读说明；不得用于逻辑分支 |
| `code`                                         | 稳定机器码；前端逻辑分支的唯一依据                   |
| `action`                                       | 建议用户采取的动作                                   |
| `retryable`                                    | 是否允许自动/手动重试                                |
| `retryAfterSeconds`                            | 建议等待秒数；存在时响应同时带 `Retry-After`         |
| `traceId`                                      | 与响应头 `X-Request-Id` 对应的请求标识               |
| `dataSource`、`lastSuccessfulAt`、`observedAt` | 降级、陈旧数据或上游观测上下文；可选                 |

前端优先采用 `Retry-After` 响应头；缺失时再读 `retryAfterSeconds`。只在
`retryable === true` 时自动重试，并使用退避；写请求还必须满足幂等键/业务状态约束，不能因 5xx
盲目重放。任何分支都匹配 `code`，不得匹配或正则解析 `detail`、`message`、`title` 文案。

当前接入最关键的稳定 code：

| code                                                          | 前端含义与动作                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `INVALID_REQUEST`                                             | body、query 或 path 未通过校验；定位表单字段，不重试原请求           |
| `UNSUPPORTED_MEDIA_TYPE`                                      | JSON/multipart 类型错误；修正请求头或上传方式                        |
| `INTERNAL_ERROR`                                              | 未识别的服务端错误；显示通用错误和 `traceId`                         |
| `CUSTOMER_AUTH_REQUIRED`                                      | 普通用户 Session 缺失/失效；进入登录流程                             |
| `ADMIN_AUTH_REQUIRED`                                         | 管理员 Session 缺失/失效；进入管理员登录流程                         |
| `AUTH_RATE_LIMITED`                                           | OTP/短信请求限频；按 `Retry-After` 倒计时                            |
| `AUTH_INVALID_CHALLENGE`                                      | 登录验证码无效、过期或已消费；重新取验证码                           |
| `REGISTRATION_TOKEN_INVALID`                                  | 注册确认 token 失效/已使用；重新走验证与注册分离流程                 |
| `CAPTCHA_REJECTED`                                            | 人机校验未通过；重新完成人机验证                                     |
| `STEP_UP_CHALLENGE_INVALID`                                   | step-up 验证码无效或过期；重新 request                               |
| `STEP_UP_GRANT_REQUIRED`                                      | 当前动作需要 step-up；启动第 5 节取票序列                            |
| `STEP_UP_GRANT_INVALID`                                       | token 过期、已消费、设备或 purpose 不匹配；清空内存 token 并重新取票 |
| `STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE`                       | 换绑/找回后的身份冷静期未结束；禁止绕过，展示稍后再试                |
| `QUOTE_EXPIRED`                                               | 报价已过期；重新报价，不复用旧订单输入                               |
| `QUOTE_PRICE_CHANGED`                                         | 价格规则变化；展示新价格并要求用户重新确认                           |
| `ORDER_NOT_FOUND`                                             | 当前用户不可见或订单不存在；回订单列表                               |
| `ORDER_NOT_PENDING_PAYMENT`                                   | 订单当前状态不可再次支付；刷新订单/支付状态                          |
| `PAYMENT_CREATE_CONFLICT` / `BALANCE_PAYMENT_CREATE_CONFLICT` | 支付创建正在并发处理；查询状态，不重复创建                           |
| `WALLET_BALANCE_INSUFFICIENT`                                 | 可用余额不足；提示充值或改用允许的单一支付渠道                       |
| `WALLET_SPEND_LIMIT_EXCEEDED`                                 | 超出单笔余额消费策略；不得拆单或绕过策略                             |
| `DOMAIN_ASSET_NOT_FOUND`                                      | 域名资产不存在或不属于当前用户                                       |
| `NAMESERVER_CONFIRMATION_REQUIRED`                            | NS 请求缺少明确二次确认                                              |
| `DNS_RECORD_CONFIRMATION_REQUIRED`                            | 高风险 DNS/MX 变更缺少明确二次确认                                   |
| `RENEWAL_MANDATE_PREVIEW_INVALID`                             | 自动续费预览过期或资产已变化；重新 preview                           |
| `DOMAIN_REALNAME_CONFIRMATION_REQUIRED`                       | 联系人/模板变更缺少二次确认                                          |
| `REALNAME_TEMPLATE_NOT_USABLE`                                | 模板未满足 approved/归属/上游确认条件；返回模板选择                  |
| `TOOL_QUOTA_INSUFFICIENT`                                     | 工具额度不足；引导米币兑换入口（入口接通后）                         |

## 5. 需要 step-up 的端点

本节合并 `docs/operations/frontend-step-up-endpoints.md` 的服务端事实。step-up token 按
`purpose` 和 `deviceId` 绑定；`realname_change`、`renewal_mandate_change`、
`account_deletion` 是一次性 token。即使 `oneTime` 为 false，也不得把 token 持久化或跨 purpose
复用。

### 5.1 完整取票序列

1. `POST /api/v1/auth/step-up/request`，body 为
   `auth.ts:166#stepUpRequestSchema`：`captchaVerifyParam`、稳定的浏览器 `deviceId`、目标
   `purpose`。以 `credentials: 'same-origin'` 发送。成功返回 `challengeId`（当前 request 响应尚无
   导出 Zod schema，接入前应补齐，不得手写类型）。
2. 用户收到短信后，`POST /api/v1/auth/step-up/verify`，body 为
   `auth.ts:174#stepUpVerifySchema`：第一步的 `challengeId`、六位 `code`、**同一个**
   `deviceId`、**同一个** `purpose`。用 `auth.ts:183#stepUpGrantResponseSchema.parse()` 校验
   `stepUpToken`、`expiresAt`、`oneTime`、`purpose`。
3. 立即调用目标端点，发送同一个 `deviceId`、匹配 purpose 的 `stepUpToken` 及下表的业务、预览、
   确认和幂等字段。成功后从内存清除 OTP、challenge 和 token；一次性 token 的失败重试按返回
   `code` 决定，不得假设 token 未消费。

### 5.2 目标端点与字段

| purpose                                  | 方法与端点                                                                | 最终请求必需字段/条件                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nameserver_change`                      | `POST /api/v1/domains/:assetId/nameservers`                               | `confirmed: true`、`deviceId`、`nameservers`、`stepUpToken`                                                                                                                                       |
| `nameserver_change`                      | `POST /api/v1/domains/nameservers/batch`                                  | 先调用 `/batch/preview`；提交 `assetIds`、`batchKey`、`confirmed: true`、`deviceId`、`nameservers`、`previewToken`、`stepUpToken`。后四个保护字段虽在边界 schema 条件可选，提交服务会 fail-closed |
| `balance_spend`                          | `POST /api/v1/orders/:orderNumber/payments` 的余额分支                    | `channel: 'balance'`、`deviceId`、`stepUpToken`                                                                                                                                                   |
| `account_deletion`                       | `POST /api/v1/auth/deletion-request`                                      | `confirmation: 'DELETE_MY_ACCOUNT'`、`deviceId`、`reason`、`stepUpToken`                                                                                                                          |
| `domain_lock_change`                     | `PUT /api/v1/domains/:assetId/lock` 的解锁分支                            | `locked: false`、`idempotencyKey`、`deviceId`、`stepUpToken`；加锁分支只有 `locked: true`、`idempotencyKey`，不取 step-up                                                                         |
| `renewal_mandate_change`                 | `PUT` / `DELETE /api/v1/domains/:assetId/renewal-mandate`                 | 先对相同 action 调 `/preview`；最终发送 `confirmed: true`、`deviceId`、`previewToken`、`stepUpToken`                                                                                              |
| `domain_management_password`             | `POST /api/v1/domains/:assetId/management-password`                       | `deviceId`、`stepUpToken`                                                                                                                                                                         |
| `domain_management_password`             | `PUT /api/v1/domains/:assetId/management-password`                        | `deviceId`、`idempotencyKey`、`managementPassword`、`stepUpToken`                                                                                                                                 |
| `realname_change`                        | `PUT /api/v1/domains/:assetId/contact-information`                        | `confirmed: true`、`contactType`、`deviceId`、`idempotencyKey`、`templateId`、`stepUpToken`                                                                                                       |
| `realname_change`                        | `POST /api/v1/domains/:assetId/template-transfer`                         | `confirmed: true`、`deviceId`、`idempotencyKey`、`templateId`、`stepUpToken`                                                                                                                      |
| `dns_record_change` / `mx_record_change` | `POST /api/v1/domains/:assetId/dns-records` 的高风险分支                  | `host`、`line`、`priority`、`ttl`、`type`、`value`、`idempotencyKey`，并补 `confirmed: true`、`deviceId`、`stepUpToken`；`type: 'MX'` 使用 `mx_record_change`，其余使用 `dns_record_change`       |
| `dns_record_change` / `mx_record_change` | `PATCH /api/v1/domains/:assetId/dns-records/:recordId` 的高风险分支       | `priority`、`ttl`、`value`、`idempotencyKey`，并补 `confirmed: true`、`deviceId`、`stepUpToken`；purpose 由现有记录类型决定                                                                       |
| `dns_record_change` / `mx_record_change` | `DELETE /api/v1/domains/:assetId/dns-records/:recordId` 的高风险分支      | `idempotencyKey`，并补 `confirmed: true`、`deviceId`、`stepUpToken`；purpose 由现有记录类型决定                                                                                                   |
| `dns_record_change` / `mx_record_change` | `POST /api/v1/domains/:assetId/dns-records/:recordId/status` 的高风险分支 | `paused`、`idempotencyKey`，并补 `confirmed: true`、`deviceId`、`stepUpToken`；purpose 由现有记录类型决定                                                                                         |
| `dns_bulk_delete`                        | `POST /api/v1/domains/:assetId/dns-records/batch-delete`                  | 先调 `/batch-delete/preview`；提交 `recordIds`、`previewToken`、`deviceId`、`stepUpToken`，服务端提交阶段 fail-closed                                                                             |

## 6. PR #117 的 a 类能力与接入边界

[PR #117](https://github.com/huangsourcing-ux/Wanmi/pull/117) 的
`docs/operations/d8-module-acceptance.md` 第 4.1 节把生产零调用项统一列为 a 类。这里必须区分
“实现存在”与“浏览器可调用”：前端只能调用第 2 节的 HTTP 端点，不能 import `src/services`、伪造
`PayloadRequest` 或通过 Payload 通用 REST 绕过受控入口。A-SRC-01～07 可视为等待批准的前端/运营
闭环，但在新增受控 endpoint、Job 或审批 executor 前**不是现成 API**；A-SRC-08/09 则按原审计
保留为删除/迁移候选，不能改写成前端能力。

| PR #117 ID | 用途                                                                                         | 真实服务参数                                                                                                                                                                                                                                                                                                                                                                         | 前端接入前置                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| A-SRC-01   | 发布版本化邀请奖励规则                                                                       | `createInvitationRewardRuleVersion(req, { bindingWindowHours, changeNote, effectiveAt, enabled, rewardExpiryDays, rewardPoints })`                                                                                                                                                                                                                                                   | 需 system_admin 受控 endpoint 或高风险审批 executor；不能直接从浏览器调用 service                                       |
| A-SRC-02   | 重复充值退款、未提供服务退款、注销余额退款、支付撤销/争议追回                                | `refundDuplicateWalletTopUp(req, { duplicateTopUpOrderNumber, evidence, originalTopUpOrderNumber, traceId })`；`refundOrderWhenServiceNotProvided(req, { evidence, note, orderId, traceId })`；`requestAccountClosureBalanceRefunds(req, { customerId, requestId, traceId })`；`recoverWalletTopUpPaymentReversal(req, { occurredAt, recoveryKey, recoveryType, topUpOrderNumber })` | 这些是 system-only 资金流程，需接入既有退款/注销/通知/审批 executor；前端最多提交批准的业务标识与证据，不能直接控制账本 |
| A-SRC-03   | 普通订单米币赚取/确认/冲正、米币兑换工具额度、消费额度及余额查询                             | `earnPendingOrderReward(req, { customerId, earningKey, expiresAt, orderId, points })`；确认/冲正传 `earningKey`；兑换传 `{ customerId, pointsCost, quotaUnits, redemptionKey, target }`；消费传 `{ customerId, quotaUnits, target, usageKey }`；查询传 customer/batch/target                                                                                                         | 订单奖励需接订单状态/Job；兑换与用户余额读取需新增 customer endpoint；工具消费应由工具服务端执行，不能信任浏览器报用量  |
| A-SRC-04   | 根据上游确定结果 capture/release 钱包 hold；unknown 时保持 hold                              | `resolveWalletHold(req, { outcome: 'confirmed' \| 'failed' \| 'unknown', transactionKey })`                                                                                                                                                                                                                                                                                          | 接 provider 查询/履约恢复 Job，不提供用户任意选择 outcome 的 UI                                                         |
| A-SRC-05   | 原路充值退款确认后标记充值单终态                                                             | `markWalletTopUpOriginalRefunded(req, { originalRefundNumber, refundedAt, topUpOrderNumber })`                                                                                                                                                                                                                                                                                       | 接已验签退款通知或受控查单 Job；system-only，不暴露浏览器写入口                                                         |
| A-SRC-06   | 系统管理员调查实名证件查看/下载审计轨迹                                                      | `readRealnameDocumentAccessTrail(req, { start, end })`                                                                                                                                                                                                                                                                                                                               | 可新增 system_admin 只读 endpoint 和运营页；时间范围由后端限制，响应需补 Zod schema                                     |
| A-SRC-07   | 判断客户是否有效同意商业短信                                                                 | `commercialSmsOptedIn(req, customerId)`                                                                                                                                                                                                                                                                                                                                              | 这是通知发送门禁，不是用户读取 API；未来营销短信发送点必须在服务端调用。用户同意变更已走 `/api/v1/account/consents`     |
| A-SRC-08   | 四个零引用 helper：解密身份标识、退款查询 digest、域名 owner id、customer identity assertion | 各自参数为 `identity`、verified refund `notification`、`asset`、`user`                                                                                                                                                                                                                                                                                                               | PR #117 明确判为零引用死代码候选；没有前端用途，不得为保留它们而造 endpoint                                             |
| A-SRC-09   | 与 form-builder 平行的 `UserFeedback` Collection                                             | Payload Collection 字段为 customer/category/message/status 等                                                                                                                                                                                                                                                                                                                        | 公共反馈继续使用 `/api/v1/forms/submissions`；不得接入该平行 Collection，待确认数据/迁移后删除                          |

因此，“后端已就绪、等待新前端接入”优先指第 2 节已存在而当前 `components/` 没有调用的 API，尤其是
域名 DNS/锁/管理密码/联系人/证书、续费授权、提醒偏好、余额支付、账户通知/VIP 和对应后台页。
PR #117 的 a 类 service 只有在补齐受控生产入口后才能进入前端工作清单。

## 7. 已知前端缺口：Name Server

PR #114 发现旧前端的单域名 NS 写请求只发送 `nameservers`，但
`domains.ts:214#nameserverChangeRequestSchema` 要求 `confirmed: true`、`deviceId`、`nameservers`、
`stepUpToken`。旧调用会稳定失败，因此按方案 B 删除写请求；当前
`apps/web/src/components/domains/domain-assets.tsx:198-217` 只展示当前 NS，textarea 和提交按钮均
disabled，并提示流程正在升级。

新前端不得简单恢复按钮，必须在同一交付中实现完整闭环：收集并规范化 2～15 个 NS → 展示明确
二次确认 → 以 `purpose: 'nameserver_change'` 完成 request/verify → 在内存中携带同一个
`deviceId` 和 `stepUpToken` → 发送 `confirmed: true` 的最终 POST → 用
`domains.ts:221#nameserverChangeResultSchema.parse()` 校验响应 → 展示 `pending`、`succeeded`、
`failed`、`manual_review` 和查询重放状态。批量入口还必须先 preview，并绑定 `batchKey`、资产列表、
目标 NS 与 `previewToken`。在这些状态和 step-up 流程全部完成前，保持写入口禁用。
