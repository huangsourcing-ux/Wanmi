import Link from 'next/link'
import type { ServerProps } from 'payload'

import { OPERATIONS_VIEWS, canViewOperationsView } from '@/lib/operations-views'

export function OperationsNavigation({ user }: ServerProps) {
  const visible = OPERATIONS_VIEWS.filter((view) => canViewOperationsView(user, view.key))

  if (!visible.length) return null

  return (
    <div className="wanmi-operations-nav" data-testid="operations-navigation">
      <div className="wanmi-operations-nav__label">运营视图</div>
      {visible.map((view) => (
        <Link
          className="wanmi-operations-nav__link"
          href={view.path}
          key={view.key}
        >
          {view.label}
        </Link>
      ))}
    </div>
  )
}
