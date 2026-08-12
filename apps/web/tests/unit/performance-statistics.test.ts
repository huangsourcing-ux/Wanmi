import { describe, expect, it } from 'vitest'

import {
  runScenariosSequentially,
  summarizeScenarioRounds,
} from '../../scripts/performance-statistics.mjs'

function successfulRound(p95Ms: number) {
  return Array.from({ length: 20 }, () => ({ durationMs: p95Ms, ok: true }))
}

describe('performance scenario statistics', () => {
  it('isolates scenarios while preserving their declared order', async () => {
    let active = 0
    let maximumActive = 0
    const events: string[] = []
    const scenario = (name: string) => async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      events.push(`${name}:start`)
      await Promise.resolve()
      events.push(`${name}:end`)
      active -= 1
      return name
    }

    await expect(
      runScenariosSequentially([scenario('public'), scenario('domain'), scenario('idn')]),
    ).resolves.toEqual(['public', 'domain', 'idn'])
    expect(maximumActive).toBe(1)
    expect(events).toEqual([
      'public:start',
      'public:end',
      'domain:start',
      'domain:end',
      'idn:start',
      'idn:end',
    ])
  })

  it('uses the median round p95 so two noisy rounds cannot dominate the gate', () => {
    const result = summarizeScenarioRounds([
      successfulRound(100),
      successfulRound(101),
      successfulRound(900),
      successfulRound(99),
      successfulRound(800),
    ])

    expect(result).toMatchObject({
      errorRate: 0,
      failures: 0,
      maximumMs: 900,
      p95Ms: 101,
      requests: 100,
      roundP95Ms: [100, 101, 900, 99, 800],
      rounds: 5,
    })
  })

  it('aggregates failures across every measurement round', () => {
    const rounds = [successfulRound(100), successfulRound(110)]
    rounds[1][0] = { durationMs: 120, ok: false }

    expect(summarizeScenarioRounds(rounds)).toMatchObject({
      errorRate: 0.025,
      failures: 1,
      requests: 40,
      rounds: 2,
    })
  })

  it('rejects missing or empty measurement rounds', () => {
    expect(() => summarizeScenarioRounds([])).toThrow(/at least one measurement round/u)
    expect(() => summarizeScenarioRounds([[]])).toThrow(/must not be empty/u)
  })
})
