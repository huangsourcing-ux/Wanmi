# Customer 短信认证与回执 Runbook

## 安全边界

- 普通用户只使用 `customers` Custom Strategy 与 `wanmi_customer_session` opaque Cookie；管理员只使用 `admins`、Payload 密码 + TOTP 与 `wanmi_admin-token`。两种 Cookie 不可配置为同名。
- OTP challenge 有效期默认 5 分钟，最多尝试 5 次，只保存带 pepper 的哈希并以 compare-and-swap 一次性消费。
- 限频分别使用手机号、IP、设备和全局四个 PostgreSQL 原子配额；任何一维达到阈值都拒绝发送。配额到期后由 `smsReceiptReconciliation` background workflow 清理。
- `ALLOW_REAL_PROVIDER_WRITES=false` 时，即使 `ALIYUN_SMS_MODE=live` 也拒绝发送真实短信。测试、开发和未获得上线授权的环境必须保持 false。

## 模式与配置

本地和自动化测试使用：

```text
ALIYUN_SMS_MODE=mock
ALLOW_REAL_PROVIDER_WRITES=false
MOCK_SMS_OTP_CODE=246810
```

live 模式还需要从受控密钥环境提供 AccessKey、Region、短信签名和验证码模板编号。凭据、完整手机号和验证码不得写入日志、审计或错误响应。

## 发送与回执

1. `POST /api/v1/auth/sms/request` 先原子消费四维配额，再创建哈希 challenge，然后调用 Alibaba Cloud TypeScript SDK `SendSms`。
2. 接受成功后仅保存 RequestId、BizId、发送时间和投递状态，不保存明文验证码。
3. `smsReceiptReconciliation` 每分钟通过 SDK `QuerySendDetails` 查询 accepted/pending/unknown 记录，状态收敛为 delivered、failed、pending 或 unknown。
4. 失败稳定分类为：`balance_insufficient`、`template_unapproved`、`invalid_number`、`rate_limited`、`unknown`。未知回执不得标记为成功。

## 用户处置

- `POST /api/v1/auth/logout` 的 `scope=all` 撤销该 customer 的全部有效 Session。
- `POST /api/v1/auth/deletion-request` 必须携带有效 customer Cookie 和固定确认值 `DELETE_MY_ACCOUNT`；成功后同一事务写入 `deletion_requested`、记录时间、撤销全部 Session 并写 customer security event。
- `deletion_requested` 账号不能再次通过 OTP 建立 Session。实际数据清理和 30 天删除任务属于 D4-02 及之后，不在本切片执行。

## 故障处理

- 余额不足或模板未审：暂停真实发送，修复账号/模板配置后再恢复；不得改用 mock 伪装生产成功。
- 阿里云或回执查询不可用：保持 `unknown`/`pending`，待后续 workflow 重查，不写 delivered。
- provider 限流：接口返回稳定 429；Wanmi 四维配额仍保留本次尝试计数以防轰炸。
- 排障只使用 traceId、RequestId、BizId 和稳定分类；不得复制完整手机号、Cookie 或验证码到工单。
