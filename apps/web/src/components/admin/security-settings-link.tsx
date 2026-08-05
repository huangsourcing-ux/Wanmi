'use client'

import Link from 'next/link'

export function SecuritySettingsLink() {
  return (
    <Link className="wanmi-security-settings-link" href="/admin/security">
      账号安全
    </Link>
  )
}
