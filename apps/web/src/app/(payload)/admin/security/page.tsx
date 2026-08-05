import config from '@payload-config'
import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'

import { SecuritySettings } from '@/components/admin/security-settings'
import { hasRole } from '@/access/roles'
import { listAdminInvitations } from '@/services/auth/admin-invitations'
import { authenticatedAdminRequest } from '@/services/auth/admin-session'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '账号安全 — Wanmi.AI',
}

export default async function AdminSecurityPage() {
  const payload = await getPayload({ config })
  const requestHeaders = await headers()
  let authenticated
  try {
    authenticated = await authenticatedAdminRequest(
      payload,
      new Request('http://wanmi.local/admin/security', { headers: requestHeaders }),
    )
  } catch {
    redirect('/admin/login')
  }

  const { req, user } = authenticated
  const systemAdmin = hasRole(user, ['system_admin'])
  const result = await payload.find({
    collection: 'admins',
    limit: systemAdmin ? 100 : 1,
    overrideAccess: false,
    req,
    sort: 'email',
    user,
  })
  const admins = result.docs.map((admin) => ({
    email: admin.email,
    id: admin.id,
    roles: admin.roles,
    status: admin.status,
  }))
  const invitations = systemAdmin ? await listAdminInvitations(req) : []

  return (
    <SecuritySettings
      admins={admins}
      currentAdminId={user.id}
      initialInvitations={invitations}
      systemAdmin={systemAdmin}
    />
  )
}
