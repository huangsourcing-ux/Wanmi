// @vitest-environment jsdom

import { randomBytes } from 'node:crypto'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WechatLoginConfirmation } from '@/app/(frontend)/auth/wechat/confirm/wechat-login-confirmation'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Wechat QR login confirmation page', () => {
  it('reads the one-time token from the fragment, removes it from the URL, and confirms explicitly', async () => {
    const token = randomBytes(32).toString('base64url')
    window.history.replaceState({}, '', `/auth/wechat/confirm#token=${token}`)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init
      if (String(input).endsWith('/preview')) {
        return Response.json({
          deviceSummary: 'Chrome/desktop',
          message: '正在登录 Wanmi.AI',
          status: 'scanned',
        })
      }
      return Response.json({ status: 'confirmed' })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WechatLoginConfirmation />)
    expect(await screen.findByText(/Chrome\/desktop/u)).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(document.body.textContent).not.toContain(token)

    fireEvent.click(screen.getByRole('button', { name: '确认登录' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/已确认/u)).toBeTruthy()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
  })
})
