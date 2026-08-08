import { describe, expect, it } from 'vitest'

import { createWechatPayFixture } from '@/providers/wechatpay'

const now = new Date('2026-08-08T01:00:00.000Z')

describe('Wechat Pay API v3 fixture adapter', () => {
  it('creates signed Native and H5 orders with the server expiry and queries a verified response', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const expiresAt = '2026-08-08T01:04:00.000Z'
    const native = await fixture.provider.createPayment({
      amountMinor: 12_300,
      channel: 'native',
      description: 'Wanmi 域名注册服务',
      expiresAt,
      merchantOrderNumber: 'WMNATIVE0001',
      traceId: 'trace-wechat-native',
    })
    expect(native).toMatchObject({
      data: { channel: 'native', expiresAt },
      ok: true,
    })
    if (native.ok && native.data.channel === 'native') {
      expect(native.data.codeUrl).toMatch(/^weixin:\/\//u)
    }

    const h5 = await fixture.provider.createPayment({
      amountMinor: 45_600,
      channel: 'h5',
      clientIp: '192.0.2.20',
      description: 'Wanmi 域名注册服务',
      expiresAt,
      merchantOrderNumber: 'WMH50001',
      traceId: 'trace-wechat-h5',
    })
    expect(h5).toMatchObject({ data: { channel: 'h5', expiresAt }, ok: true })
    if (h5.ok && h5.data.channel === 'h5') expect(h5.data.h5Url).toMatch(/^https:\/\//u)

    fixture.setOrder({
      amountMinor: 12_300,
      merchantOrderNumber: 'WMNATIVE0001',
      paidAt: now.toISOString(),
      state: 'paid',
      transactionId: '42000000000000000000000000000001',
    })
    await expect(
      fixture.provider.queryOrder({
        merchantOrderNumber: 'WMNATIVE0001',
        traceId: 'trace-wechat-query',
      }),
    ).resolves.toMatchObject({
      data: {
        amountMinor: 12_300,
        currency: 'CNY',
        merchantOrderNumber: 'WMNATIVE0001',
        state: 'paid',
        transactionId: '42000000000000000000000000000001',
      },
      ok: true,
    })
  })

  it('verifies RSA notification signatures, decrypts AES-GCM only afterwards and rejects tampering', async () => {
    let currentTime = now
    const fixture = createWechatPayFixture({ now: () => currentTime })
    const notification = fixture.notification({
      amountMinor: 12_300,
      merchantOrderNumber: 'WMNOTIFY0001',
      notificationId: 'EV-WANMI-FIXTURE-0001',
      paidAt: now.toISOString(),
      transactionId: '42000000000000000000000000000002',
    })
    await expect(
      fixture.provider.verifyNotification({
        ...notification,
        traceId: 'trace-wechat-notify',
      }),
    ).resolves.toEqual({
      amountMinor: 12_300,
      currency: 'CNY',
      merchantOrderNumber: 'WMNOTIFY0001',
      notificationId: 'EV-WANMI-FIXTURE-0001',
      paidAt: now.toISOString(),
      transactionId: '42000000000000000000000000000002',
      verified: true,
    })

    const tamperedBody = notification.body.replace('支付成功', '伪造支付')
    await expect(
      fixture.provider.verifyNotification({
        body: tamperedBody,
        headers: notification.headers,
        traceId: 'trace-wechat-tamper',
      }),
    ).resolves.toEqual({
      reason: 'invalid_signature',
      signatureVerified: false,
      verified: false,
    })

    currentTime = new Date(now.getTime() + 5 * 60 * 1_000 + 1_000)
    await expect(
      fixture.provider.verifyNotification({
        body: notification.body,
        headers: notification.headers,
        traceId: 'trace-wechat-stale',
      }),
    ).resolves.toEqual({
      reason: 'invalid_signature',
      signatureVerified: false,
      verified: false,
    })
  })

  it('fails closed on expired payment sessions and missing H5 client IP', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    await expect(
      fixture.provider.createPayment({
        amountMinor: 100,
        channel: 'native',
        description: 'test',
        expiresAt: now.toISOString(),
        merchantOrderNumber: 'WMEXPIRED',
        traceId: 'trace-expired',
      }),
    ).resolves.toMatchObject({ error: { code: 'WECHATPAY_EXPIRES_AT_INVALID' }, ok: false })
    await expect(
      fixture.provider.createPayment({
        amountMinor: 100,
        channel: 'h5',
        description: 'test',
        expiresAt: '2026-08-08T01:04:00.000Z',
        merchantOrderNumber: 'WMH5NOIP',
        traceId: 'trace-no-ip',
      }),
    ).resolves.toMatchObject({ error: { code: 'WECHATPAY_CLIENT_IP_REQUIRED' }, ok: false })
  })
})
