// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyAction } from '@/components/tool-actions/copy-action'
import { ToolActions } from '@/components/tool-actions/tool-actions'

function setClipboard(writeText?: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  })
}

afterEach(() => {
  cleanup()
  setClipboard()
  window.history.replaceState({}, '', '/')
})

describe('D2-10 copy and share interactions', () => {
  it('reports clipboard success and failure without hiding the action context', async () => {
    const writeText = vi.fn(async () => undefined)
    setClipboard(writeText)
    const { rerender } = render(
      <CopyAction label="复制记录" successLabel="已复制记录" text="safe record" />,
    )

    fireEvent.click(screen.getByRole('button', { name: '复制记录' }))
    expect(await screen.findByText('已复制记录')).not.toBeNull()
    expect(writeText).toHaveBeenCalledWith('safe record')

    setClipboard(async () => Promise.reject(new Error('denied')))
    rerender(<CopyAction key="failure" label="复制域名" text="xn--fsqu00a.xn--fiqs8s" />)
    fireEvent.click(screen.getByRole('button', { name: '复制域名' }))
    expect(await screen.findByText('复制失败')).not.toBeNull()
  })

  it('links to the other five tools and requires confirmation before including a domain', async () => {
    window.history.replaceState(
      {},
      '',
      '/tools/whois?q=private.example&traceId=trace-secret&requestId=req-secret&cacheKey=cache-secret',
    )
    render(<ToolActions currentTool="whois" domainAscii="例子.中国" />)

    expect(screen.getAllByRole('link')).toHaveLength(5)
    expect(screen.getByRole('link', { name: 'DNS / NS 查询' }).getAttribute('href')).toBe(
      '/tools/dns?q=xn--fsqu00a.xn--fiqs8s',
    )
    expect(screen.getByRole('link', { name: 'TLD 价格与成本' }).getAttribute('href')).toBe(
      '/pricing',
    )

    fireEvent.click(screen.getByRole('button', { name: '生成分享链接' }))
    const toolOnly = screen.getByRole('radio', { name: /仅分享工具入口/u }) as HTMLInputElement
    const withDomain = screen.getByRole('radio', { name: /包含当前域名/u }) as HTMLInputElement
    expect(toolOnly.checked).toBe(true)
    expect(withDomain.checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '确认并生成链接' }))
    const cleanInput = screen.getByLabelText('可分享链接') as HTMLInputElement
    expect(cleanInput.value).toBe(`${window.location.origin}/tools/whois`)
    expect(cleanInput.value).not.toMatch(/private|trace|request|cache|xn--/u)

    fireEvent.click(withDomain)
    expect(screen.queryByLabelText('可分享链接')).toBeNull()
    expect(screen.getByText('确认公开域名')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认并生成链接' }))
    const domainInput = screen.getByLabelText('可分享链接') as HTMLInputElement
    expect(domainInput.value).toBe(`${window.location.origin}/tools/whois?q=xn--fsqu00a.xn--fiqs8s`)
    expect(domainInput.value).not.toMatch(/trace-secret|req-secret|cache-secret/u)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '生成分享链接' }))
    expect(
      (screen.getByRole('radio', { name: /仅分享工具入口/u }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(screen.queryByLabelText('可分享链接')).toBeNull()
  })
})
