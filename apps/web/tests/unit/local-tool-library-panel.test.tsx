// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DomainFavoriteButton,
  ToolFavoriteButton,
} from '@/components/local-library/favorite-buttons'
import { LocalToolLibraryPanel } from '@/components/local-library/local-tool-library-panel'
import { LocalToolLibraryProvider } from '@/components/local-library/local-tool-library-provider'
import {
  LOCAL_FAVORITES_STORAGE_KEY,
  LOCAL_HISTORY_STORAGE_KEY,
  recordLocalHistory,
} from '@/lib/local-tool-library'

function setPrivacyPreference(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value })
}

afterEach(() => {
  localStorage.clear()
  setPrivacyPreference('doNotTrack', undefined)
  setPrivacyPreference('globalPrivacyControl', undefined)
})

describe('D2-09 local library UI', () => {
  it('shows privacy state, synchronizes quick favorites, deletes one item, and clears every key', async () => {
    const now = Date.now()
    localStorage.clear()
    recordLocalHistory(
      { query: '例子.中国', tool: 'whois' },
      { notify: false, now, privacyOptedOut: false, storage: localStorage },
    )
    recordLocalHistory(
      { query: 'wanmi.net', tool: 'dns' },
      { notify: false, now: now + 1, privacyOptedOut: false, storage: localStorage },
    )
    setPrivacyPreference('doNotTrack', '1')

    render(
      <LocalToolLibraryProvider>
        <ToolFavoriteButton label="TLD 价格与成本" tool="pricing" />
        <DomainFavoriteButton domain="例子.中国" />
        <LocalToolLibraryPanel />
      </LocalToolLibraryProvider>,
    )

    expect(await screen.findByRole('heading', { name: '我的本地工具箱' })).not.toBeNull()
    expect(screen.getByText('已尊重 DNT / GPC 隐私信号')).not.toBeNull()
    expect(screen.getByText('wanmi.net')).not.toBeNull()
    expect(screen.getByText('xn--fsqu00a.xn--fiqs8s')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '收藏工具：TLD 价格与成本' }))
    expect(await screen.findByText('TLD 价格与成本')).not.toBeNull()
    expect(localStorage.getItem(LOCAL_FAVORITES_STORAGE_KEY)).toContain('pricing')

    fireEvent.click(screen.getAllByRole('button', { name: '收藏域名：例子.中国' })[0])
    expect(
      await screen.findAllByRole('button', { name: '取消收藏域名：例子.中国' }),
    ).not.toHaveLength(0)
    expect(localStorage.getItem(LOCAL_FAVORITES_STORAGE_KEY)).toContain('xn--fsqu00a.xn--fiqs8s')

    fireEvent.click(screen.getByRole('button', { name: '删除查询历史：wanmi.net' }))
    expect(await screen.findByText('已删除查询历史“wanmi.net”')).not.toBeNull()
    expect(screen.queryByText('wanmi.net')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '清空全部本地数据' }))
    expect(await screen.findByText('已清空全部本地历史与收藏')).not.toBeNull()
    expect(localStorage.getItem(LOCAL_HISTORY_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(LOCAL_FAVORITES_STORAGE_KEY)).toBeNull()
    expect(screen.getByText(/暂无本地查询历史/u)).not.toBeNull()
    expect(screen.getByText(/暂无收藏/u)).not.toBeNull()
  })
})
