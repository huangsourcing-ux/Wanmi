import type { WechatPayFixture } from '@/providers/wechatpay'

// Adapted from WeChat Pay's official API v3 payment notification examples:
// https://pay.wechatpay.cn/doc/v3/merchant/4012791861
// https://pay.wechatpay.cn/doc/v3/merchant/4012365342
// The official examples intentionally omit usable ciphertext/signatures. This fixture retains the
// documented envelope/resource values and uses the local adapter's ephemeral RSA key and API v3
// key so tests exercise real SHA256-RSA verification followed by AES-256-GCM decryption.
export const officialWechatPaymentExample = {
  amountMinor: 100,
  merchantOrderNumber: '1217752501201407033233368018',
  notificationId: 'EV-2018022511223320873',
  paidAt: '2018-06-08T10:34:56+08:00',
  transactionId: '42000000000000000000000000000001',
} as const

export function officialWechatPaymentNotification(fixture: WechatPayFixture) {
  return fixture.notification(officialWechatPaymentExample)
}
