import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetEnvForTests } from '@/lib/env'
import { ProviderWriteGuardError } from '@/lib/provider-write-guardrails'
import {
  createConfiguredWechatPayProvider,
  createWechatPayFixture,
  SafetyFencedWechatPayProvider,
  resetWechatPayRuntimeForTests,
} from '@/providers/wechatpay'

import {
  officialWechatPaymentExample,
  officialWechatPaymentNotification,
} from '../fixtures/wechatpay-official'

const now = new Date('2026-08-08T01:00:00.000Z')

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
  resetWechatPayRuntimeForTests()
})

describe('Wechat Pay API v3 fixture adapter', () => {
  it('verifies and decrypts the official API v3 payment-notification example shape', async () => {
    const officialNow = new Date('2018-06-08T02:34:56.000Z')
    const fixture = createWechatPayFixture({ now: () => officialNow })
    const notification = officialWechatPaymentNotification(fixture)
    const envelope = JSON.parse(notification.body) as Record<string, unknown>
    expect(envelope).toMatchObject({
      event_type: 'TRANSACTION.SUCCESS',
      id: officialWechatPaymentExample.notificationId,
      resource_type: 'encrypt-resource',
      summary: '支付成功',
    })
    await expect(
      fixture.provider.verifyNotification({
        ...notification,
        traceId: 'trace-wechat-official-fixture',
      }),
    ).resolves.toEqual({
      amountMinor: officialWechatPaymentExample.amountMinor,
      currency: 'CNY',
      merchantOrderNumber: officialWechatPaymentExample.merchantOrderNumber,
      notificationId: officialWechatPaymentExample.notificationId,
      paidAt: officialWechatPaymentExample.paidAt,
      transactionId: officialWechatPaymentExample.transactionId,
      verified: true,
    })
    notification.headers.set('wechatpay-signature', 'tampered-official-example')
    await expect(
      fixture.provider.verifyNotification({
        ...notification,
        traceId: 'trace-wechat-official-fixture-tampered',
      }),
    ).resolves.toMatchObject({ signatureVerified: false, verified: false })
  })

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

  it('maps the signed ORDER_NOT_EXIST query response observed from Wechat Pay', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    fixture.setOrderQueryError({
      code: 'ORDER_NOT_EXIST',
      merchantOrderNumber: 'WMMISSING0001',
      status: 404,
    })

    await expect(
      fixture.provider.queryOrder({
        merchantOrderNumber: 'WMMISSING0001',
        traceId: 'trace-wechat-order-not-exist',
      }),
    ).resolves.toMatchObject({
      error: {
        code: 'WECHATPAY_ORDER_NOT_FOUND',
        retryable: false,
        statusKnown: true,
      },
      ok: false,
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

  it('rejects single and persistent cumulative live payment amounts before the adapter transport', async () => {
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY_PAYMENTS', 'true')
    vi.stubEnv('CI', 'false')
    vi.stubEnv('WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN', '500')
    vi.stubEnv('WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN', '500')
    resetEnvForTests()
    const fixture = createWechatPayFixture({ now: () => now })
    const createPayment = vi.spyOn(fixture.provider, 'createPayment')
    const consumeBudget = vi
      .fn()
      .mockResolvedValueOnce({ debited: true })
      .mockRejectedValueOnce(
        new ProviderWriteGuardError('WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED'),
      )
    const provider = new SafetyFencedWechatPayProvider(fixture.provider, consumeBudget)
    const payment = (amountMinor: number, merchantOrderNumber: string) =>
      provider.createPayment({
        amountMinor,
        channel: 'native',
        description: 'guardrail fixture',
        expiresAt: '2026-08-08T01:04:00.000Z',
        merchantOrderNumber,
        traceId: `trace-${merchantOrderNumber}`,
      })

    await expect(payment(501, 'WMGUARDSINGLE')).resolves.toMatchObject({
      error: { code: 'WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_EXCEEDED' },
      ok: false,
    })
    expect(createPayment).not.toHaveBeenCalled()
    expect(consumeBudget).not.toHaveBeenCalled()

    await expect(payment(300, 'WMGUARDCUM001')).resolves.toMatchObject({ ok: true })
    await expect(payment(300, 'WMGUARDCUM002')).resolves.toMatchObject({
      error: { code: 'WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_EXCEEDED' },
      ok: false,
    })
    expect(createPayment).toHaveBeenCalledTimes(1)
    expect(consumeBudget).toHaveBeenCalledTimes(2)
  })

  it('keeps payment and refund write capabilities independently gated', async () => {
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY_PAYMENTS', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY_REFUNDS', 'false')
    vi.stubEnv('CI', 'false')
    vi.stubEnv('WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN', '500')
    vi.stubEnv('WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN', '1000')
    resetEnvForTests()
    const fixture = createWechatPayFixture({ now: () => now })
    const createRefund = vi.spyOn(fixture.provider, 'createRefund')
    const provider = new SafetyFencedWechatPayProvider(fixture.provider)

    await expect(
      provider.createRefund({
        amountMinor: 300,
        merchantOrderNumber: 'WMGUARDREFUND',
        reason: 'fixture guardrail',
        refundNumber: 'WRGUARDREFUND',
        traceId: 'trace-guard-refund',
      }),
    ).resolves.toMatchObject({
      error: { code: 'WECHATPAY_REFUND_WRITE_DISABLED' },
      ok: false,
    })
    expect(createRefund).not.toHaveBeenCalled()
  })

  it('never constructs a live Wechat Pay runtime transport in tests', () => {
    const liveTransportFactory = vi.fn()
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_WECHATPAY', 'true')
    vi.stubEnv('CI', 'false')
    vi.stubEnv('WECHATPAY_MODE', 'live')
    resetEnvForTests()

    expect(() => createConfiguredWechatPayProvider({ liveTransportFactory })).toThrow(
      /tests must never construct a live wechatpay runtime transport/iu,
    )
    expect(liveTransportFactory).not.toHaveBeenCalled()
  })
})
