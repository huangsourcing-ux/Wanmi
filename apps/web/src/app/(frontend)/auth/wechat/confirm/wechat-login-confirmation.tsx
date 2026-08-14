'use client'

import { useEffect, useState } from 'react'

type Preview = { deviceSummary: string; message: string; status: 'scanned' }
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: Preview; token: string }
  | { kind: 'submitting'; preview: Preview; token: string }
  | { kind: 'confirmed' }
  | { kind: 'error'; message: string }

async function problemMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined
  return body?.message ?? '确认请求已失效，请返回电脑重新扫码'
}

export function WechatLoginConfirmation() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
    window.history.replaceState(null, '', window.location.pathname)
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      queueMicrotask(() => setState({ kind: 'error', message: '确认请求无效，请返回电脑重新扫码' }))
      return
    }
    void fetch('/api/v1/auth/wechat/qrcode/confirm/preview', {
      body: JSON.stringify({ confirmationToken: token }),
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }).then(async (response) => {
      if (!response.ok) {
        setState({ kind: 'error', message: await problemMessage(response) })
        return
      }
      setState({ kind: 'ready', preview: (await response.json()) as Preview, token })
    })
  }, [])

  async function confirm() {
    if (state.kind !== 'ready') return
    setState({ ...state, kind: 'submitting' })
    const response = await fetch('/api/v1/auth/wechat/qrcode/confirm', {
      body: JSON.stringify({ confirmationToken: state.token }),
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (!response.ok) {
      setState({ kind: 'error', message: await problemMessage(response) })
      return
    }
    setState({ kind: 'confirmed' })
  }

  return (
    <section className="w-full rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-sm font-medium text-sky-700">Wanmi.AI 安全确认</p>
      <h1 className="mt-3 text-2xl font-semibold text-slate-950">正在登录 Wanmi.AI</h1>
      {state.kind === 'loading' ? (
        <p className="mt-5 text-slate-600">正在核对本次扫码请求…</p>
      ) : null}
      {state.kind === 'ready' || state.kind === 'submitting' ? (
        <>
          <p className="mt-5 text-slate-600">电脑/浏览器摘要：{state.preview.deviceSummary}</p>
          <p className="mt-2 text-sm text-slate-500">仅在这是你本人发起的登录时确认。</p>
          <button
            className="mt-7 w-full rounded-xl bg-sky-700 px-5 py-3 font-medium text-white disabled:opacity-60"
            disabled={state.kind === 'submitting'}
            onClick={() => void confirm()}
            type="button"
          >
            {state.kind === 'submitting' ? '正在确认…' : '确认登录'}
          </button>
        </>
      ) : null}
      {state.kind === 'confirmed' ? (
        <p className="mt-5 text-emerald-700">已确认。请返回电脑继续登录。</p>
      ) : null}
      {state.kind === 'error' ? (
        <p className="mt-5 text-rose-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </section>
  )
}
