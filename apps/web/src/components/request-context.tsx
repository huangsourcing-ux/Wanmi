'use client'

import { createContext, type ReactNode, useContext } from 'react'

const RequestIdContext = createContext<string | undefined>(undefined)

export function RequestIdProvider({
  children,
  requestId,
}: {
  children: ReactNode
  requestId: string
}) {
  return <RequestIdContext value={requestId}>{children}</RequestIdContext>
}

export function useRequestId(): string | undefined {
  return useContext(RequestIdContext)
}
