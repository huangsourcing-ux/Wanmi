export const REALNAME_RETENTION_DAYS = 30
const REALNAME_RETENTION_MS = REALNAME_RETENTION_DAYS * 24 * 60 * 60 * 1000

export function realnameCleanupDeadline(startedAt: string): string {
  const timestamp = Date.parse(startedAt)
  if (!Number.isFinite(timestamp)) throw new Error('Invalid real-name cleanup start time')
  return new Date(timestamp + REALNAME_RETENTION_MS).toISOString()
}
