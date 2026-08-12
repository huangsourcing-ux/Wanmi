import { describe, expect, it } from 'vitest'

import { summarizeScenarioRounds } from '../../scripts/performance-statistics.mjs'

function successfulRound(p95Ms: number) {
  return Array.from({ length: 20 }, () => ({ durationMs: p95Ms, ok: true }))
}

describe('performance scenario statistics', () => {
  it('uses the median round p95 so one noisy round cannot dominate the gate', () => {
    const result = summarizeScenarioRounds([
      successfulRound(100),
      successfulRound(102),
      successfulRound(101),
      successfulRound(900),
      successfulRound(99),
    ])

    expect(result).toMatchObject({
      errorRate: 0,
      failures: 0,
      maximumMs: 900,
      p95Ms: 101,
      requests: 100,
      roundP95Ms: [100, 102, 101, 900, 99],
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
