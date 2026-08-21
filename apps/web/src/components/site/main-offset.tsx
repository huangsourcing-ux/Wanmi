'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function MainOffset({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <main
      className={cn('flex-1', pathname === '/' ? undefined : 'pt-[111px]')}
      id="main-content"
      tabIndex={-1}
    >
      {children}
    </main>
  )
}
