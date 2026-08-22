import { emitFirstPartyEvent, inferToolInput } from '@/lib/analytics'
import type { QueryToolSlug } from '@/lib/site-config'

type RecordHistory = (input: { query: string; tool: QueryToolSlug }) => unknown

/**
 * Shared side effects of submitting a tool query form: the browser-only history entry
 * and the privacy-safe `tool_submitted` event. Used by DomainQueryForm and by the
 * homepage hero form (see HeroSearchTracking), so both submissions behave the same.
 */
export function reportToolSubmission(
  form: HTMLFormElement,
  tool: QueryToolSlug,
  recordHistory: RecordHistory,
): void {
  const query = new FormData(form).get('q')
  const value = typeof query === 'string' ? query : ''
  recordHistory({ query: value, tool })
  emitFirstPartyEvent({
    event: 'tool_submitted',
    fromLocalHistory: false,
    ...inferToolInput(value),
    schemaVersion: 1,
    tool,
  })
}
