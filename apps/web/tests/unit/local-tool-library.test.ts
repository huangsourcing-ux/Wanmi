// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import {
  clearLocalToolLibrary,
  deleteLocalFavorite,
  deleteLocalHistory,
  getFavoriteHref,
  getHistoryHref,
  LOCAL_FAVORITES_STORAGE_KEY,
  LOCAL_HISTORY_STORAGE_KEY,
  LOCAL_LIBRARY_MAX_ITEMS,
  LOCAL_LIBRARY_RETENTION_MS,
  readLocalToolLibrary,
  recordLocalHistory,
  toggleDomainFavorite,
  toggleToolFavorite,
} from '@/lib/local-tool-library'

class MemoryStorage implements Storage {
  protected values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new DOMException('blocked', 'SecurityError')
  }

  override removeItem(): void {
    throw new DOMException('blocked', 'SecurityError')
  }

  override setItem(): void {
    throw new DOMException('quota', 'QuotaExceededError')
  }
}

function options(storage: Storage, now: number) {
  return { notify: false, now, privacyOptedOut: false, storage }
}

function setPrivacyPreference(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value })
}

afterEach(() => {
  setPrivacyPreference('doNotTrack', undefined)
  setPrivacyPreference('globalPrivacyControl', undefined)
})

describe('D2-09 browser-local history and favorites', () => {
  it('deduplicates equivalent Unicode/Punycode per tool and keeps tools independent', () => {
    const storage = new MemoryStorage()
    const now = 2_000_000_000_000

    recordLocalHistory({ query: '例子.中国', tool: 'domain-search' }, options(storage, now))
    recordLocalHistory(
      { query: 'xn--fsqu00a.xn--fiqs8s', tool: 'domain-search' },
      options(storage, now + 1),
    )
    recordLocalHistory({ query: '例子.中国', tool: 'whois' }, options(storage, now + 2))

    const snapshot = readLocalToolLibrary(options(storage, now + 2))
    expect(snapshot.history).toEqual([
      { query: '例子.中国', tool: 'whois', updatedAt: now + 2 },
      {
        query: 'xn--fsqu00a.xn--fiqs8s',
        tool: 'domain-search',
        updatedAt: now + 1,
      },
    ])
  })

  it('enforces a hard 30-item cap and evicts the oldest history and favorites', () => {
    const storage = new MemoryStorage()
    const now = 2_000_000_000_000

    for (let index = 0; index <= LOCAL_LIBRARY_MAX_ITEMS; index += 1) {
      recordLocalHistory(
        { query: `keyword-${index}`, tool: 'domain-search' },
        options(storage, now + index),
      )
      toggleDomainFavorite(`domain-${index}.com`, options(storage, now + index))
    }

    const snapshot = readLocalToolLibrary(options(storage, now + LOCAL_LIBRARY_MAX_ITEMS))
    expect(snapshot.history).toHaveLength(LOCAL_LIBRARY_MAX_ITEMS)
    expect(snapshot.favorites).toHaveLength(LOCAL_LIBRARY_MAX_ITEMS)
    expect(snapshot.history.at(-1)?.query).toBe('keyword-1')
    expect(snapshot.favorites.at(-1)).toMatchObject({ domainAscii: 'domain-1.com' })
  })

  it('expires at 90 days, salvages valid items, and removes corrupt or unknown envelopes', () => {
    const storage = new MemoryStorage()
    const now = 2_000_000_000_000
    storage.setItem(
      LOCAL_HISTORY_STORAGE_KEY,
      JSON.stringify({
        items: [
          { query: 'expired.com', tool: 'whois', updatedAt: now - LOCAL_LIBRARY_RETENTION_MS },
          { query: 'future.com', tool: 'whois', updatedAt: now + 10 * 60 * 1_000 },
          { query: 'valid.com', tool: 'whois', updatedAt: now - 1 },
          { query: 'valid.com', tool: 'whois', updatedAt: now - 2 },
          { query: 42, tool: 'dns', updatedAt: now },
        ],
        version: 1,
      }),
    )
    storage.setItem(LOCAL_FAVORITES_STORAGE_KEY, JSON.stringify({ items: [], version: 2 }))

    const snapshot = readLocalToolLibrary(options(storage, now))
    expect(snapshot.recovered).toBe(true)
    expect(snapshot.history).toEqual([{ query: 'valid.com', tool: 'whois', updatedAt: now - 1 }])
    expect(storage.getItem(LOCAL_FAVORITES_STORAGE_KEY)).toBeNull()

    storage.setItem(LOCAL_HISTORY_STORAGE_KEY, '{not-json')
    expect(readLocalToolLibrary(options(storage, now)).history).toEqual([])
    expect(storage.getItem(LOCAL_HISTORY_STORAGE_KEY)).toBeNull()
  })

  it('honors DNT and GPC for automatic history while keeping explicit favorites available', () => {
    const storage = new MemoryStorage()
    const now = 2_000_000_000_000

    setPrivacyPreference('doNotTrack', '1')
    const dntResult = recordLocalHistory(
      { query: 'private.example', tool: 'dns' },
      { notify: false, now, storage },
    )
    expect(dntResult).toMatchObject({ ok: false, reason: 'privacy_signal' })
    expect(storage.getItem(LOCAL_HISTORY_STORAGE_KEY)).toBeNull()
    expect(toggleToolFavorite('dns', { notify: false, now, storage }).ok).toBe(true)

    setPrivacyPreference('doNotTrack', undefined)
    setPrivacyPreference('globalPrivacyControl', true)
    expect(
      recordLocalHistory(
        { query: 'also-private.example', tool: 'ssl-check' },
        { notify: false, now, storage },
      ),
    ).toMatchObject({ ok: false, reason: 'privacy_signal' })
    expect(readLocalToolLibrary({ notify: false, now, storage }).historyRecordingEnabled).toBe(
      false,
    )
  })

  it('normalizes domain favorites, uses fixed routes, and removes keys on delete and clear', () => {
    const storage = new MemoryStorage()
    const now = 2_000_000_000_000
    recordLocalHistory({ query: '例子.中国', tool: 'dns' }, options(storage, now))
    toggleDomainFavorite('例子.中国', options(storage, now))
    toggleDomainFavorite('xn--fsqu00a.xn--fiqs8s', options(storage, now + 1))
    toggleDomainFavorite('xn--fsqu00a.xn--fiqs8s', options(storage, now + 2))
    toggleToolFavorite('pricing', options(storage, now + 3))

    const snapshot = readLocalToolLibrary(options(storage, now + 3))
    const domainFavorite = snapshot.favorites.find((item) => item.kind === 'domain')!
    const toolFavorite = snapshot.favorites.find((item) => item.kind === 'tool')!
    expect(snapshot.favorites).toHaveLength(2)
    expect(domainFavorite).toMatchObject({
      domainAscii: 'xn--fsqu00a.xn--fiqs8s',
      domainUnicode: '例子.中国',
    })
    expect(getHistoryHref(snapshot.history[0])).toBe(
      '/tools/dns?q=%E4%BE%8B%E5%AD%90.%E4%B8%AD%E5%9B%BD',
    )
    expect(getFavoriteHref(domainFavorite)).toBe('/tools/domain-search?q=xn--fsqu00a.xn--fiqs8s')
    expect(getFavoriteHref(toolFavorite)).toBe('/pricing')

    expect(deleteLocalHistory(snapshot.history[0], options(storage, now + 3)).ok).toBe(true)
    expect(storage.getItem(LOCAL_HISTORY_STORAGE_KEY)).toBeNull()
    expect(deleteLocalFavorite(domainFavorite, options(storage, now + 3)).ok).toBe(true)
    expect(clearLocalToolLibrary(options(storage, now + 4)).ok).toBe(true)
    expect(storage.getItem(LOCAL_HISTORY_STORAGE_KEY)).toBeNull()
    expect(storage.getItem(LOCAL_FAVORITES_STORAGE_KEY)).toBeNull()
  })

  it('degrades safely when browser storage throws on reads, writes, or removals', () => {
    const storage = new ThrowingStorage()
    const now = 2_000_000_000_000

    expect(readLocalToolLibrary(options(storage, now))).toMatchObject({
      available: false,
      favorites: [],
      history: [],
    })
    expect(
      recordLocalHistory({ query: 'wanmi.net', tool: 'whois' }, options(storage, now)),
    ).toMatchObject({ ok: false, reason: 'storage_unavailable' })
    expect(toggleDomainFavorite('wanmi.net', options(storage, now))).toMatchObject({
      ok: false,
      reason: 'storage_unavailable',
    })
    expect(clearLocalToolLibrary(options(storage, now))).toMatchObject({
      ok: false,
      reason: 'storage_unavailable',
    })
  })
})
