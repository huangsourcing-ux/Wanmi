// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AdminMfaLoginPage from '@/app/(payload)/admin/login/page'

const replace = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace }) }))

describe('admin MFA login', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 1 } }))),
    )
  })

  it('requires a second factor and forwards TOTP in the login request', async () => {
    render(<AdminMfaLoginPage />)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.invalid' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'not-a-real-password' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/第二因素/)

    fireEvent.change(screen.getByLabelText('TOTP 验证码'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/admin/auth/login',
      expect.objectContaining({
        body: expect.stringContaining('"totp":"123456"'),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(replace).toHaveBeenCalledWith('/admin')
  })
})
