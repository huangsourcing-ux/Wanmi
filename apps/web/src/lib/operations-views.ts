import type { AdminRole } from '@/lib/domain'

export const OPERATIONS_VIEWS = [
  {
    key: 'dashboard',
    label: '运营仪表盘',
    path: '/admin/operations',
    roles: ['analyst', 'system_admin'],
  },
  {
    key: 'tools',
    label: '工具状态',
    path: '/admin/operations/tools',
    roles: ['analyst', 'system_admin'],
  },
  {
    key: 'content',
    label: '内容',
    path: '/admin/operations/content',
    roles: ['content_editor', 'system_admin'],
  },
  {
    key: 'advertising',
    label: '广告',
    path: '/admin/operations/advertising',
    roles: ['ad_operator', 'analyst', 'system_admin'],
  },
  {
    key: 'tldPricing',
    label: 'TLD / 价格',
    path: '/admin/operations/tld-pricing',
    roles: ['content_editor', 'system_admin'],
  },
  {
    key: 'feedback',
    label: '反馈',
    path: '/admin/operations/feedback',
    roles: ['ad_operator', 'analyst', 'system_admin'],
  },
  {
    key: 'audit',
    label: '审计',
    path: '/admin/operations/audit',
    roles: ['ad_operator', 'system_admin'],
  },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  path: `/admin/${string}`
  roles: readonly AdminRole[]
}>

export type OperationsViewKey = (typeof OPERATIONS_VIEWS)[number]['key']

export function canViewOperationsView(
  user:
    | { collection?: string; roles?: AdminRole[] | null; status?: string | null }
    | null
    | undefined,
  key: OperationsViewKey,
): boolean {
  if (user?.collection !== 'admins' || user.status !== 'active') return false
  const view = OPERATIONS_VIEWS.find((candidate) => candidate.key === key)
  const allowedRoles: readonly AdminRole[] = view?.roles ?? []
  return Boolean(user.roles?.some((role) => allowedRoles.includes(role)))
}
