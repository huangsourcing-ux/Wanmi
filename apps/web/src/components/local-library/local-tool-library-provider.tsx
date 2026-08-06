'use client'

import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from 'react'

import {
  clearLocalFavorites,
  clearLocalHistory,
  clearLocalToolLibrary,
  deleteLocalFavorite,
  deleteLocalHistory,
  LOCAL_FAVORITES_STORAGE_KEY,
  LOCAL_HISTORY_STORAGE_KEY,
  LOCAL_LIBRARY_CHANGED_EVENT,
  type FavoriteToolSlug,
  type LocalFavoriteItem,
  type LocalHistoryItem,
  type LocalLibraryMutationResult,
  type LocalToolLibrarySnapshot,
  type QueryToolSlug,
  readLocalToolLibrary,
  recordLocalHistory,
  toggleDomainFavorite,
  toggleToolFavorite,
} from '@/lib/local-tool-library'

const initialSnapshot: LocalToolLibrarySnapshot = {
  available: true,
  favorites: [],
  history: [],
  historyRecordingEnabled: true,
  recovered: false,
}

let clientSnapshot: LocalToolLibrarySnapshot | undefined

function getClientSnapshot(): LocalToolLibrarySnapshot {
  clientSnapshot ??= readLocalToolLibrary()
  return clientSnapshot
}

function getServerSnapshot(): LocalToolLibrarySnapshot {
  return initialSnapshot
}

function subscribeToLocalLibrary(onStoreChange: () => void): () => void {
  const refresh = () => {
    clientSnapshot = readLocalToolLibrary()
    onStoreChange()
  }
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === LOCAL_HISTORY_STORAGE_KEY ||
      event.key === LOCAL_FAVORITES_STORAGE_KEY
    ) {
      refresh()
    }
  }
  window.addEventListener(LOCAL_LIBRARY_CHANGED_EVENT, refresh)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(LOCAL_LIBRARY_CHANGED_EVENT, refresh)
    window.removeEventListener('storage', handleStorage)
  }
}

type LocalToolLibraryContextValue = {
  clearAll: () => LocalLibraryMutationResult
  clearFavorites: () => LocalLibraryMutationResult
  clearHistory: () => LocalLibraryMutationResult
  deleteFavorite: (item: LocalFavoriteItem) => LocalLibraryMutationResult
  deleteHistory: (item: Pick<LocalHistoryItem, 'query' | 'tool'>) => LocalLibraryMutationResult
  loaded: boolean
  recordHistory: (input: { query: string; tool: QueryToolSlug }) => LocalLibraryMutationResult
  snapshot: LocalToolLibrarySnapshot
  toggleDomain: (domain: string) => LocalLibraryMutationResult
  toggleTool: (tool: FavoriteToolSlug) => LocalLibraryMutationResult
}

const LocalToolLibraryContext = createContext<LocalToolLibraryContextValue>({
  clearAll: () => clearLocalToolLibrary(),
  clearFavorites: () => clearLocalFavorites(),
  clearHistory: () => clearLocalHistory(),
  deleteFavorite: (item) => deleteLocalFavorite(item),
  deleteHistory: (item) => deleteLocalHistory(item),
  loaded: false,
  recordHistory: (input) => recordLocalHistory(input),
  snapshot: initialSnapshot,
  toggleDomain: (domain) => toggleDomainFavorite(domain),
  toggleTool: (tool) => toggleToolFavorite(tool),
})

export function LocalToolLibraryProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribeToLocalLibrary,
    getClientSnapshot,
    getServerSnapshot,
  )
  const loaded = snapshot !== initialSnapshot

  const value = useMemo<LocalToolLibraryContextValue>(
    () => ({
      clearAll: () => clearLocalToolLibrary(),
      clearFavorites: () => clearLocalFavorites(),
      clearHistory: () => clearLocalHistory(),
      deleteFavorite: (item) => deleteLocalFavorite(item),
      deleteHistory: (item) => deleteLocalHistory(item),
      loaded,
      recordHistory: (input) => recordLocalHistory(input),
      snapshot,
      toggleDomain: (domain) => toggleDomainFavorite(domain),
      toggleTool: (tool) => toggleToolFavorite(tool),
    }),
    [loaded, snapshot],
  )

  return <LocalToolLibraryContext value={value}>{children}</LocalToolLibraryContext>
}

export function useLocalToolLibrary(): LocalToolLibraryContextValue {
  return useContext(LocalToolLibraryContext)
}
