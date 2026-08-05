import type { Metadata } from 'next'

import { AdminEnrollment } from '@/components/admin/admin-enrollment'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '管理员安全绑定 — Wanmi.AI',
}

export default function AdminEnrollmentPage() {
  return <AdminEnrollment />
}
