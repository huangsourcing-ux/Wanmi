// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IdnConverter } from '@/components/results/idn-converter'

function analyticsFetch() {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void url
    void init
    return new Response(null, { status: 202 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function submit(value: string) {
  fireEvent.change(screen.getByLabelText('输入要转换的域名'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: '转换 IDN' }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('D2-08 browser-local IDN converter', () => {
  it('converts locally, keeps Punycode public and links other tools with ASCII only', async () => {
    const fetch = analyticsFetch()
    render(<IdnConverter />)

    submit('例子.中国')

    expect(screen.getByRole('heading', { name: 'Punycode（公开展示）' })).not.toBeNull()
    expect(screen.getByText('xn--fsqu00a.xn--fiqs8s')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Unicode（转换预览）' })).not.toBeNull()
    expect(screen.getByText('例子.中国')).not.toBeNull()
    expect(screen.getByRole('link', { name: '查询 WHOIS / RDAP' }).getAttribute('href')).toBe(
      '/tools/whois?q=xn--fsqu00a.xn--fiqs8s',
    )
    expect(screen.getByRole('link', { name: '查询 DNS / NS' }).getAttribute('href')).toBe(
      '/tools/dns?q=xn--fsqu00a.xn--fiqs8s',
    )
    expect(screen.getByText(/本工具不查询注册、WHOIS、DNS 或价格/u)).not.toBeNull()

    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2))
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toBe('/api/v1/events')
      expect(String(init?.body)).not.toMatch(/例子|中国|xn--fsqu00a|xn--fiqs8s/u)
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('tld')
      expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'origin' })
    }
  })

  it('copies both explicit outputs with accessible feedback', async () => {
    analyticsFetch()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<IdnConverter defaultValue="xn--fsqu00a.xn--fiqs8s" />)

    fireEvent.click(screen.getByRole('button', { name: '复制 Punycode' }))
    await screen.findByText('已复制 Punycode')
    expect(writeText).toHaveBeenCalledWith('xn--fsqu00a.xn--fiqs8s')

    fireEvent.click(screen.getByRole('button', { name: '复制 Unicode' }))
    await screen.findByText('已复制 Unicode')
    expect(writeText).toHaveBeenCalledWith('例子.中国')
  })

  it('names mixed writing systems and repeats the registration and trademark boundary', () => {
    analyticsFetch()
    render(<IdnConverter />)
    submit('раypal.com')

    const risk = document.querySelector('[data-idn-risk]')
    expect(risk?.textContent).toContain('西里尔文（Cyrillic）')
    expect(risk?.textContent).toContain('拉丁文（Latin）')
    expect(screen.getAllByText(/转换成功不代表可注册或商标安全/u).length).toBeGreaterThanOrEqual(2)
  })

  it('shows the exact failing label and reason without calling the IDN API', async () => {
    const fetch = analyticsFetch()
    render(<IdnConverter />)
    submit('wanmi..com')

    expect(screen.getAllByText('第 2 个标签为空').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/请根据标签位置和原因修正/u)).not.toBeNull()

    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/tools/idn')).toBe(false)
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('tld')
    }
  })
})
