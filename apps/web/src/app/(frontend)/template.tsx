import { headers } from 'next/headers'
import type { ReactNode } from 'react'

import { RequestIdProvider } from '@/components/request-context'
import { getTraceId } from '@/lib/request-id'

export default async function FrontendTemplate({ children }: { children: ReactNode }) {
  const requestId = getTraceId(await headers())
  return <RequestIdProvider requestId={requestId}>{children}</RequestIdProvider>
}
