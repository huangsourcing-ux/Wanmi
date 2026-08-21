import type { ReactNode } from 'react'

export function MainOffset({ children }: { children: ReactNode }) {
  return (
    <main className="dyna-main-offset flex-1" id="main-content" tabIndex={-1}>
      {children}
    </main>
  )
}
