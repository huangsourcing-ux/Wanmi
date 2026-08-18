import { describe, expect, it } from 'vitest'

import { automaticRenewalScheduling } from '@/jobs/config'
import {
  automaticRenewalAttemptSlot,
  type AutomaticRenewalRules,
} from '@/services/domains/automatic-renewal-rules'

const rules: AutomaticRenewalRules = {
  balanceReminderLimit: 2,
  firstAttemptDays: 7,
  mandateMaxFen: 100_000_000n,
  retryDays: [3, 1],
  version: '2026-08-18.1',
}

describe('D9-C-2 automatic renewal schedule rules', () => {
  it('defines the first attempt and each retry as explicit date slots', () => {
    const expiresAt = '2027-08-08T12:00:00.000Z'
    expect(
      automaticRenewalAttemptSlot(expiresAt, new Date('2027-07-31T12:00:00.000Z'), rules),
    ).toBeUndefined()
    expect(
      automaticRenewalAttemptSlot(expiresAt, new Date('2027-08-01T11:59:59.999Z'), rules),
    ).toBeUndefined()
    expect(
      automaticRenewalAttemptSlot(expiresAt, new Date('2027-08-01T12:00:00.000Z'), rules),
    ).toBe(7)
    expect(
      automaticRenewalAttemptSlot(expiresAt, new Date('2027-08-05T12:00:00.000Z'), rules),
    ).toBe(3)
    expect(
      automaticRenewalAttemptSlot(expiresAt, new Date('2027-08-07T12:00:00.000Z'), rules),
    ).toBe(1)
    expect(
      automaticRenewalAttemptSlot(expiresAt, new Date('2027-08-09T12:00:00.000Z'), rules),
    ).toBeUndefined()
  })

  it('uses one exclusive commerce scheduler with no automatic retry and leaves renewal writes to commerceFulfillment', () => {
    expect(automaticRenewalScheduling).toMatchObject({
      concurrency: {
        exclusive: true,
        supersedes: true,
      },
      queue: 'commerce',
      retries: 0,
      schedule: [{ cron: '0 10 * * * *', queue: 'commerce' }],
      slug: 'automaticRenewalScheduling',
    })
    const concurrency = automaticRenewalScheduling.concurrency
    if (!concurrency || typeof concurrency === 'function') {
      throw new Error('Expected object concurrency configuration')
    }
    expect(concurrency.key({ input: {}, queue: 'commerce' })).toBe(
      'commerce:automatic-renewal-scheduling',
    )
  })
})
