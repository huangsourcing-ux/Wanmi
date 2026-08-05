'use client'

import Image from 'next/image'
import { type FormEvent, useEffect, useState } from 'react'
import QRCode from 'qrcode'

import { readProblemResponse } from '@/lib/errors'

type InvitationResolution = {
  invitation: {
    email: string
    expiresAt: string
    purpose: 'mfa_reset' | 'new_admin'
    roles: string[]
  }
  provisioningUri: string
}

export function AdminEnrollment() {
  const [token, setToken] = useState('')
  const [resolution, setResolution] = useState<InvitationResolution | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const bearer = fragment.get('token') ?? ''
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    void (async () => {
      if (!bearer) throw new Error('邀请链接无效或已过期')
      const response = await fetch('/api/v1/admin/auth/invitations/resolve', {
        headers: { authorization: `Bearer ${bearer}` },
        method: 'POST',
      })
      if (!response.ok) throw new Error((await readProblemResponse(response)).message)
      const body = (await response.json()) as InvitationResolution
      setToken(bearer)
      setResolution(body)
      setQrDataUrl(await QRCode.toDataURL(body.provisioningUri, { margin: 1, width: 240 }))
    })().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : '邀请链接无效或已过期')
    })
  }, [])

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch('/api/v1/admin/auth/invitations/accept', {
        body: JSON.stringify({ password: form.get('password'), totp: form.get('totp') }),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) throw new Error((await readProblemResponse(response)).message)
      const body = (await response.json()) as { recoveryCodes: string[] }
      setRecoveryCodes(body.recoveryCodes)
      setToken('')
      setResolution(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安全绑定失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  async function copyRecoveryCodes() {
    await navigator.clipboard.writeText(recoveryCodes.join('\n'))
  }

  if (recoveryCodes.length) {
    return (
      <main className="wanmi-mfa-login">
        <section className="wanmi-mfa-login__card wanmi-enrollment__card">
          <p className="wanmi-mfa-login__eyebrow">Wanmi.AI 管理后台</p>
          <h1>保存恢复码</h1>
          <p>这些恢复码只显示一次。请离线保存，每个恢复码只能使用一次。</p>
          <pre className="wanmi-enrollment__codes">{recoveryCodes.join('\n')}</pre>
          <button onClick={copyRecoveryCodes} type="button">
            复制恢复码
          </button>
          <label className="wanmi-enrollment__acknowledgement">
            <input
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              type="checkbox"
            />
            我已安全保存恢复码
          </label>
          <a
            aria-disabled={!acknowledged}
            className={
              acknowledged ? 'wanmi-enrollment__continue' : 'wanmi-enrollment__continue is-disabled'
            }
            href={acknowledged ? '/admin/login' : undefined}
          >
            前往登录
          </a>
        </section>
      </main>
    )
  }

  return (
    <main className="wanmi-mfa-login">
      <form className="wanmi-mfa-login__card wanmi-enrollment__card" onSubmit={accept}>
        <p className="wanmi-mfa-login__eyebrow">Wanmi.AI 管理后台</p>
        <h1>{resolution?.invitation.purpose === 'mfa_reset' ? '重置 MFA' : '开通管理员账号'}</h1>
        {resolution ? (
          <>
            <p>
              账号：{resolution.invitation.email}
              。请使用认证器扫描二维码，并输入当前验证码完成绑定。
            </p>
            {qrDataUrl ? (
              <Image
                alt="TOTP 绑定二维码"
                className="wanmi-enrollment__qr"
                height={240}
                src={qrDataUrl}
                unoptimized
                width={240}
              />
            ) : (
              <p aria-live="polite">正在生成二维码…</p>
            )}
            <details>
              <summary>无法扫描？显示配置 URI</summary>
              <code className="wanmi-enrollment__uri">{resolution.provisioningUri}</code>
            </details>
            <label>
              新密码（14～128 个字符）
              <input
                autoComplete="new-password"
                maxLength={128}
                minLength={14}
                name="password"
                required
                type="password"
              />
            </label>
            <label>
              TOTP 验证码
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                minLength={6}
                name="totp"
                pattern="[0-9]{6}"
                required
              />
            </label>
          </>
        ) : null}
        {error ? (
          <p className="wanmi-mfa-login__error" role="alert">
            {error}
          </p>
        ) : null}
        <button disabled={!resolution || submitting} type="submit">
          {submitting ? '正在绑定…' : '完成安全绑定'}
        </button>
      </form>
    </main>
  )
}
