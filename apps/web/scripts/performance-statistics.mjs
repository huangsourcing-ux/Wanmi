export function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

export function median(values) {
  return percentile(values, 0.5)
}

export function round(value, digits = 1) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export async function runScenariosSequentially(scenarios) {
  const results = []
  for (const scenario of scenarios) results.push(await scenario())
  return results
}

export function summarizeScenarioRounds(roundResults) {
  if (!Array.isArray(roundResults) || roundResults.length === 0) {
    throw new Error('Performance scenario requires at least one measurement round')
  }
  if (roundResults.some((results) => !Array.isArray(results) || results.length === 0)) {
    throw new Error('Performance scenario measurement rounds must not be empty')
  }

  const results = roundResults.flat()
  const durations = results.map((result) => result.durationMs)
  const failures = results.filter((result) => !result.ok)
  const roundP50Ms = roundResults.map((round) =>
    percentile(
      round.map((result) => result.durationMs),
      0.5,
    ),
  )
  const roundP95Ms = roundResults.map((round) =>
    percentile(
      round.map((result) => result.durationMs),
      0.95,
    ),
  )

  return {
    errorRate: round(failures.length / results.length, 4),
    failures: failures.length,
    maximumMs: round(Math.max(...durations)),
    p50Ms: round(median(roundP50Ms)),
    p95Ms: round(median(roundP95Ms)),
    requests: results.length,
    roundP95Ms: roundP95Ms.map((value) => round(value)),
    rounds: roundResults.length,
  }
}
