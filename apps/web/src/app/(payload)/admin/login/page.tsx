'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'

type LoginProblem = { message?: string }

export default function AdminMfaLoginPage() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    const form = new FormData(event.currentTarget)
    const totp = String(form.get('totp') ?? '')
    const recoveryCode = String(form.get('recoveryCode') ?? '')
    if (!totp && !recoveryCode) {
      setError('请输入 TOTP 验证码或恢复码')
      setSubmitting(false)
      return
    }
    try {
      const response = await fetch('/api/v1/admin/auth/login', {
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
          ...(recoveryCode ? { recoveryCode } : { totp }),
        }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as LoginProblem
        throw new Error(problem.message || '邮箱、密码或验证码无效')
      }
      router.replace('/admin')
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="wanmi-mfa-login">
      <form className="wanmi-mfa-login__card" onSubmit={login}>
        <p className="wanmi-mfa-login__eyebrow">Wanmi.AI 管理后台</p>
        <h1>安全登录</h1>
        <p>密码验证与 TOTP 在服务端同一次登录事务中完成，验证通过前不会创建 Session。</p>
        <label>
          邮箱
          <input autoComplete="username" name="email" required type="email" />
        </label>
        <label>
          密码
          <input
            autoComplete="current-password"
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
          />
        </label>
        <label>
          恢复码（仅在无法使用 TOTP 时填写）
          <input autoComplete="off" name="recoveryCode" type="password" />
        </label>
        {error ? (
          <p className="wanmi-mfa-login__error" role="alert">
            邮箱、密码或第二因素无效
          </p>
        ) : null}
        <button disabled={submitting} type="submit">
          {submitting ? '正在验证…' : '登录'}
        </button>
      </form>
    </main>
  )
}
