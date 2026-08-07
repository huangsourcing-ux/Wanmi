import { describe, expect, it } from 'vitest'

import { realnameCleanupDeadline } from '@/services/realname/lifecycle'

describe('real-name cleanup retention', () => {
  it('uses an auditable exact 30-day UTC deadline', () => {
    expect(realnameCleanupDeadline('2026-08-07T12:34:56.000Z')).toBe('2026-09-06T12:34:56.000Z')
  })
})
