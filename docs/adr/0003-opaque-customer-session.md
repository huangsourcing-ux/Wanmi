# ADR-0003：Customer opaque Session

- 状态：D0 已采用
- 日期：2026-08-03

## 决策

Customer 关闭 Payload 本地密码策略，通过 Custom Strategy 从 Cookie 恢复身份。短信 challenge 有效期 5 分钟、最多 5 次尝试、一次性消费，并按手机号、IP、设备和全局数据库计数限频。

登录生成随机 256-bit opaque token，数据库仅保存带 pepper 的 HMAC。Cookie 为 Secure、HttpOnly、SameSite=Lax；customer Session 为 30 天。相同设备再次登录先撤销旧 Session，支持撤销当前或全部 Session。

管理员保持独立 Payload Auth Collection，Session 为 12 小时。`beforeLogin` 在 Payload 创建 Session 前校验 TOTP；TOTP secret 使用 AES-256-GCM，恢复码只保存带 pepper 的哈希，同一时间步禁止重放。

## 后果

数据库泄漏不能直接恢复浏览器 token；pepper 和 TOTP 加密密钥必须位于受控密钥系统并支持轮换。所有 OTP 响应保持防枚举措辞。
