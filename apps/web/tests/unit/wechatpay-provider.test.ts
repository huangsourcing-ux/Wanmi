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

  it('closes an unpaid order and requires the next signed query to report closed', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    await fixture.provider.createPayment({
      amountMinor: 100,
      channel: 'native',
      description: 'test',
      expiresAt: '2026-08-08T01:04:00.000Z',
      merchantOrderNumber: 'WMCLOSE0001',
      traceId: 'trace-close-create',
    })
    await expect(
      fixture.provider.closeOrder({
        merchantOrderNumber: 'WMCLOSE0001',
        traceId: 'trace-close',
      }),
    ).resolves.toMatchObject({ data: { closed: true }, ok: true })
    await expect(
      fixture.provider.queryOrder({
        merchantOrderNumber: 'WMCLOSE0001',
        traceId: 'trace-close-query',
      }),
    ).resolves.toMatchObject({ data: { state: 'closed' }, ok: true })
  })

  it('submits, queries and verifies full-refund fixtures with signed responses', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const created = await fixture.provider.createRefund({
      amountMinor: 12_300,
      merchantOrderNumber: 'WMREFUND0001',
      reason: '注册明确失败',
      refundNumber: 'WRREFUND0001',
      traceId: 'trace-refund-create',
    })
    expect(created).toMatchObject({
      data: {
        amountMinor: 12_300,
        merchantOrderNumber: 'WMREFUND0001',
        refundNumber: 'WRREFUND0001',
        state: 'processing',
      },
      ok: true,
    })

    const refundedAt = now.toISOString()
    fixture.setRefund({
      amountMinor: 12_300,
      merchantOrderNumber: 'WMREFUND0001',
      providerRefundId: '503000000000000000000000000001',
      refundNumber: 'WRREFUND0001',
      refundedAt,
      state: 'succeeded',
    })
    await expect(
      fixture.provider.queryRefund({
        refundNumber: 'WRREFUND0001',
        traceId: 'trace-refund-query',
      }),
    ).resolves.toMatchObject({
      data: {
        amountMinor: 12_300,
        providerRefundId: '503000000000000000000000000001',
        state: 'succeeded',
      },
      ok: true,
    })

    const notification = fixture.refundNotification({
      amountMinor: 12_300,
      merchantOrderNumber: 'WMREFUND0001',
      notificationId: 'REFUND-NOTIFICATION-0001',
      providerRefundId: '503000000000000000000000000001',
      refundNumber: 'WRREFUND0001',
      refundedAt,
    })
    await expect(
      fixture.provider.verifyRefundNotification({
        ...notification,
        traceId: 'trace-refund-notification',
      }),
    ).resolves.toEqual({
      amountMinor: 12_300,
      currency: 'CNY',
      merchantOrderNumber: 'WMREFUND0001',
      notificationId: 'REFUND-NOTIFICATION-0001',
      providerRefundId: '503000000000000000000000000001',
      refundNumber: 'WRREFUND0001',
      refundedAt,
      verified: true,
    })
    notification.headers.set('wechatpay-signature', 'invalid')
    await expect(
      fixture.provider.verifyRefundNotification({
        ...notification,
        traceId: 'trace-refund-forged',
      }),
    ).resolves.toMatchObject({ signatureVerified: false, verified: false })
  })
})
