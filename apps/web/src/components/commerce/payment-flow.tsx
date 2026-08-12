'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { RegistrarDisclosure } from '@/components/compliance/registrar-disclosure'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { paymentSessionResultSchema, paymentStatusResultSchema } from '@/schemas/payments'
import type { PaymentChannel } from '@/providers/types'
import type { PaymentSessionResult, PaymentStatusResult } from '@/schemas/payments'

const POLL_INTERVAL_MS = 4_000

const statusCopy: Record<
  Extract<PaymentStatusResult, { state: 'ready' }>['data']['status'],
  { description: string; title: string }
> = {
  cancelled: { description: '支付单已关闭，请重新报价并创建订单。', title: '订单已取消' },
  fulfilling: { description: '服务端已确认到账，正在处理域名注册。', title: '正在履约' },
  manual_review: { description: '订单需要人工核对，请勿重复支付。', title: '人工复核中' },
  paid: { description: '服务端已确认微信到账。', title: '支付已确认' },
  pending_payment: {
    description: '尚未收到服务端到账确认，请保留当前页面。',
    title: '等待支付确认',
  },
  refund_pending: { description: '退款请求已建立，正在等待处理。', title: '等待退款' },
  refunded: { description: '服务端已确认退款完成。', title: '已退款' },
  refunding: { description: '退款已提交微信，正在确认结果。', title: '退款处理中' },
  succeeded: { description: '订单已履约成功。', title: '订单已完成' },
}

function detectPaymentChannel(): PaymentChannel {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'native'
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/iu.test(navigator.userAgent)
  const compactTouch =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px) and (pointer: coarse)').matches
  return mobileUserAgent || compactTouch ? 'h5' : 'native'
}

function h5RedirectUrl(h5Url: string, orderNumber: string): string {
  const target = new URL(h5Url)
  const returnUrl = new URL(
    `/account/orders/${encodeURIComponent(orderNumber)}/payment/return`,
    window.location.origin,
  )
  target.searchParams.set('redirect_url', returnUrl.toString())
  return target.toString()
}

function isSettled(status: Extract<PaymentStatusResult, { state: 'ready' }>['data']['status']) {
  return status !== 'pending_payment'
}

export function PaymentFlow({
  orderNumber,
  preferredChannel,
  registrarName,
  returned = false,
}: {
  orderNumber: string
  preferredChannel?: PaymentChannel
  registrarName?: string
  returned?: boolean
}) {
  const [channel, setChannel] = useState<PaymentChannel | undefined>(preferredChannel)
  const [creating, setCreating] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [qrDataUrl, setQrDataUrl] = useState<string>()
  const [session, setSession] = useState<PaymentSessionResult>()
  const [statusResult, setStatusResult] = useState<PaymentStatusResult>()

  const createSession = useCallback(async () => {
    if (!channel) return
    setCreating(true)
    setQrDataUrl(undefined)
    try {
      const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderNumber)}/payments`, {
        body: JSON.stringify({ channel }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const parsed = paymentSessionResultSchema.safeParse(await response.json())
      if (!parsed.success) throw new Error('PAYMENT_SESSION_RESPONSE_INVALID')
      setSession(parsed.data)
      if (parsed.data.state === 'ready' && parsed.data.data.channel === 'native') {
        const QRCode = (await import('qrcode')).default
        setQrDataUrl(
          await QRCode.toDataURL(parsed.data.data.codeUrl, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 240,
          }),
        )
      }
    } catch {
      setSession(undefined)
    } finally {
      setCreating(false)
    }
  }, [channel, orderNumber])

  useEffect(() => {
    if (channel) return
    const timer = window.setTimeout(() => setChannel(detectPaymentChannel()), 0)
    return () => window.clearTimeout(timer)
  }, [channel])

  useEffect(() => {
    if (returned || !channel) return
    const timer = window.setTimeout(() => void createSession(), 0)
    return () => window.clearTimeout(timer)
  }, [channel, createSession, returned])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      let nextDelay = POLL_INTERVAL_MS
      try {
        const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderNumber)}/payments`, {
          cache: 'no-store',
          credentials: 'same-origin',
        })
        const parsed = paymentStatusResultSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('PAYMENT_STATUS_RESPONSE_INVALID')
        if (cancelled) return
        setStatusResult(parsed.data)
        if (parsed.data.state === 'ready' && isSettled(parsed.data.data.status)) return
        if (
          parsed.data.state === 'error' &&
          !parsed.data.problem.retryable &&
          parsed.data.problem.code !== 'PAYMENT_NOT_CREATED'
        ) {
          return
        }
        if (parsed.data.state === 'rate_limited') {
          nextDelay = Math.max(
            POLL_INTERVAL_MS,
            (parsed.data.problem.retryAfterSeconds ?? 1) * 1_000,
          )
        }
      } catch {
        if (!cancelled) setStatusResult(undefined)
      }
      if (!cancelled) timer = window.setTimeout(poll, nextDelay)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [orderNumber])

  const readySession = session?.state === 'ready' ? session.data : undefined
  const expired = readySession ? Date.parse(readySession.expiresAt) <= now : false
  const paymentStatus = statusResult?.state === 'ready' ? statusResult.data : undefined
  const h5Url = useMemo(
    () =>
      readySession?.channel === 'h5' && typeof window !== 'undefined'
        ? h5RedirectUrl(readySession.h5Url, orderNumber)
        : undefined,
    [orderNumber, readySession],
  )

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-5 px-4 py-10 sm:px-6">
      <div>
        <p className="text-sm font-medium text-primary">订单 {orderNumber}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">微信支付</h1>
      </div>

      <RegistrarDisclosure registrarName={registrarName} />

      {returned ? (
        <Alert>
          <AlertTitle>已返回 Wanmi，正在核对订单</AlertTitle>
          <AlertDescription>
            返回页面不代表支付成功。页面只展示服务端确认的订单状态，请勿重复支付。
          </AlertDescription>
        </Alert>
      ) : null}

      {!returned ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {channel === undefined
                ? '正在选择支付方式'
                : channel === 'native'
                  ? '扫码支付'
                  : '移动微信支付'}
            </CardTitle>
            <CardDescription>
              {channel === undefined
                ? '请稍候…'
                : channel === 'native'
                  ? '请使用微信扫描二维码。扫码动作本身不会被视为支付成功。'
                  : '跳转微信后请返回此页。跳转或返回动作本身不会被视为支付成功。'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {creating ? <p role="status">正在获取微信支付信息…</p> : null}
            {!creating && readySession?.channel === 'native' && qrDataUrl && !expired ? (
              <Image
                alt="微信支付二维码"
                className="rounded-lg border bg-white p-3"
                height={240}
                src={qrDataUrl}
                unoptimized
                width={240}
              />
            ) : null}
            {!creating && readySession?.channel === 'h5' && h5Url && !expired ? (
              <Button asChild size="lg">
                <a href={h5Url}>前往微信支付</a>
              </Button>
            ) : null}
            {expired ? (
              <Alert variant="destructive">
                <AlertTitle>支付信息已过期</AlertTitle>
                <AlertDescription>
                  请重新获取；若报价同时过期，需要重新报价并创建订单。
                </AlertDescription>
              </Alert>
            ) : null}
            {session?.state === 'error' || session?.state === 'rate_limited' ? (
              <Alert variant="destructive">
                <AlertTitle>暂时无法获取支付信息</AlertTitle>
                <AlertDescription>{session.problem.message}</AlertDescription>
              </Alert>
            ) : null}
            {(!readySession || expired) && !creating && channel ? (
              <Button onClick={() => void createSession()} type="button" variant="outline">
                重新获取支付信息
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card aria-live="polite">
        <CardHeader>
          <CardTitle>
            {paymentStatus ? statusCopy[paymentStatus.status].title : '正在查询订单状态'}
          </CardTitle>
          <CardDescription>
            {paymentStatus
              ? statusCopy[paymentStatus.status].description
              : statusResult?.state === 'rate_limited'
                ? '状态查询过于频繁，页面会稍后自动重试。'
                : statusResult?.state === 'error'
                  ? statusResult.problem.message
                  : '页面正在轮询服务端，不读取跳转结果或扫码结果。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {paymentStatus ? (
            <p className="text-sm text-muted-foreground">
              应付金额：¥{(paymentStatus.amountMinor / 100).toFixed(2)} · 服务端状态：
              {paymentStatus.status}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Button asChild variant="link">
        <Link href="/">返回首页</Link>
      </Button>
    </div>
  )
}
