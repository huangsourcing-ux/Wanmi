'use client'

import Link from 'next/link'
import { type FormEvent, useState } from 'react'

import { readProblemResponse } from '@/lib/errors'

type AdminSummary = {
  email: string
  id: number | string
  roles: string[]
  status: 'active' | 'disabled'
}

type InvitationSummary = {
  consumedAt: string | null
  createdAt: string
  email: string
  expiresAt: string
  id: number | string
  pending: boolean
  purpose: 'mfa_reset' | 'new_admin'
  revokedAt: string | null
  roles: string[]
  targetAdminId: number | string | null
}

type SafeSession = {
  createdAt: string | null
  current: boolean
  expiresAt: string
  id: string
}

const roleOptions = [
  ['content_editor', '内容编辑'],
  ['ad_operator', '广告运营'],
  ['analyst', '数据分析'],
  ['system_admin', '系统管理员'],
] as const

function formatTimestamp(value: string): string {
  return `${value.replace('T', ' ').slice(0, 16)} UTC`
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error((await readProblemResponse(response)).message)
  return (await response.json()) as T
}

export function SecuritySettings({
  admins,
  currentAdminId,
  initialInvitations,
  systemAdmin,
}: {
  admins: AdminSummary[]
  currentAdminId: number | string
  initialInvitations: InvitationSummary[]
  systemAdmin: boolean
}) {
  const [invitations, setInvitations] = useState<InvitationSummary[]>(initialInvitations)
  const [oneTimeUrl, setOneTimeUrl] = useState('')
  const [selectedAdminId, setSelectedAdminId] = useState(String(currentAdminId))
  const [sessions, setSessions] = useState<SafeSession[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadInvitations() {
    if (!systemAdmin) return
    const result = await api<{ invitations: InvitationSummary[] }>('/api/v1/admin/auth/invitations')
    setInvitations(result.invitations)
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    setOneTimeUrl('')
    const form = new FormData(event.currentTarget)
    const roles = form.getAll('roles').map(String)
    try {
      const result = await api<{ invitationUrl: string }>('/api/v1/admin/auth/invitations', {
        body: JSON.stringify({ email: form.get('email'), purpose: 'new_admin', roles }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      setOneTimeUrl(result.invitationUrl)
      setNotice('邀请已创建。链接只在这里显示一次。')
      event.currentTarget.reset()
      await loadInvitations()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '邀请创建失败')
    }
  }

  async function createMfaReset(adminId: number | string) {
    setError('')
    setNotice('')
    setOneTimeUrl('')
    try {
      const result = await api<{ invitationUrl: string }>('/api/v1/admin/auth/invitations', {
        body: JSON.stringify({ purpose: 'mfa_reset', targetAdminId: adminId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      setOneTimeUrl(result.invitationUrl)
      setNotice('MFA 重置邀请已创建；接受前现有 MFA 和 Session 不受影响。')
      await loadInvitations()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'MFA 重置邀请创建失败')
    }
  }

  async function revokeInvitation(id: number | string) {
    try {
      await api(`/api/v1/admin/auth/invitations/${id}`, { method: 'DELETE' })
      await loadInvitations()
      setNotice('邀请已撤销。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '邀请撤销失败')
    }
  }

  async function loadSessions(adminId = selectedAdminId) {
    try {
      const result = await api<{ sessions: SafeSession[] }>(
        `/api/v1/admin/auth/sessions/${adminId}`,
      )
      setSessions(result.sessions)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session 列表加载失败')
    }
  }

  async function revokeSession(sessionId?: string) {
    try {
      const suffix = sessionId ? `/${sessionId}` : ''
      const result = await api<{ sessions: SafeSession[] }>(
        `/api/v1/admin/auth/sessions/${selectedAdminId}${suffix}`,
        { method: 'DELETE' },
      )
      setSessions(result.sessions)
      setNotice(sessionId ? 'Session 已撤销。' : '该账号的全部 Session 已撤销。')
      if (
        String(selectedAdminId) === String(currentAdminId) &&
        (!sessionId || sessions.find((session) => session.id === sessionId)?.current)
      ) {
        window.location.assign('/admin/login')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session 撤销失败')
    }
  }

  async function logout(scope: 'all' | 'current') {
    await api('/api/v1/admin/auth/logout', {
      body: JSON.stringify({ scope }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    window.location.assign('/admin/login')
  }

  return (
    <main className="wanmi-security">
      <header className="wanmi-security__header">
        <div>
          <p className="wanmi-mfa-login__eyebrow">Wanmi.AI 管理后台</p>
          <h1>账号安全</h1>
          <p>
            管理员 Session 固定 12 小时，不自动刷新。密码、角色、状态或 MFA 变更会立即撤销账号全部
            Session。
          </p>
        </div>
        <Link href="/admin">返回后台</Link>
      </header>

      {error ? (
        <p className="wanmi-mfa-login__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="wanmi-security__notice" role="status">
          {notice}
        </p>
      ) : null}

      <section className="wanmi-security__panel">
        <h2>我的 Session</h2>
        <div className="wanmi-security__actions">
          <button onClick={() => void logout('current')} type="button">
            退出当前 Session
          </button>
          <button onClick={() => void logout('all')} type="button">
            退出全部 Session
          </button>
        </div>
      </section>

      {systemAdmin ? (
        <>
          <section className="wanmi-security__panel">
            <h2>创建管理员邀请</h2>
            <form className="wanmi-security__form" onSubmit={createInvitation}>
              <label>
                邮箱
                <input autoComplete="off" name="email" required type="email" />
              </label>
              <fieldset>
                <legend>角色</legend>
                {roleOptions.map(([value, label]) => (
                  <label key={value}>
                    <input name="roles" type="checkbox" value={value} /> {label}
                  </label>
                ))}
              </fieldset>
              <button type="submit">创建 24 小时邀请</button>
            </form>
            {oneTimeUrl ? (
              <div className="wanmi-security__one-time">
                <strong>一次性邀请链接</strong>
                <code>{oneTimeUrl}</code>
                <button
                  onClick={() => void navigator.clipboard.writeText(oneTimeUrl)}
                  type="button"
                >
                  复制链接
                </button>
              </div>
            ) : null}
          </section>

          <section className="wanmi-security__panel">
            <h2>管理员账号与 MFA</h2>
            <div className="wanmi-security__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>状态</th>
                    <th>角色</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.map((admin) => (
                    <tr key={admin.id}>
                      <td>{admin.email}</td>
                      <td>{admin.status}</td>
                      <td>{admin.roles.join(', ')}</td>
                      <td>
                        <button onClick={() => void createMfaReset(admin.id)} type="button">
                          发起 MFA 重置
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="wanmi-security__panel">
            <h2>邀请管理</h2>
            <div className="wanmi-security__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>用途</th>
                    <th>到期</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => {
                    return (
                      <tr key={invitation.id}>
                        <td>{invitation.email}</td>
                        <td>{invitation.purpose}</td>
                        <td>{formatTimestamp(invitation.expiresAt)}</td>
                        <td>
                          {invitation.consumedAt
                            ? '已接受'
                            : invitation.revokedAt
                              ? '已撤销'
                              : invitation.pending
                                ? '待接受'
                                : '已过期'}
                        </td>
                        <td>
                          {invitation.pending ? (
                            <button
                              onClick={() => void revokeInvitation(invitation.id)}
                              type="button"
                            >
                              撤销
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="wanmi-security__panel">
            <h2>Session 管理</h2>
            <div className="wanmi-security__actions">
              <select
                onChange={(event) => setSelectedAdminId(event.target.value)}
                value={selectedAdminId}
              >
                {admins.map((admin) => (
                  <option key={admin.id} value={admin.id}>
                    {admin.email}
                  </option>
                ))}
              </select>
              <button onClick={() => void loadSessions()} type="button">
                加载 Session
              </button>
              <button onClick={() => void revokeSession()} type="button">
                撤销全部
              </button>
            </div>
            <ul className="wanmi-security__sessions">
              {sessions.map((session) => (
                <li key={session.id}>
                  <span>
                    {session.current ? '当前 · ' : ''}到期 {formatTimestamp(session.expiresAt)}
                  </span>
                  <button onClick={() => void revokeSession(session.id)} type="button">
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </main>
  )
}
