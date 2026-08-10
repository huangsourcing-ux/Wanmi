import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getEnv, resetEnvForTests } from '@/lib/env'

const verifier = fileURLToPath(
  new URL('../../../../scripts/verify-provider-write-policy.mjs', import.meta.url),
)

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
})

describe('real provider write CI policy', () => {
  it('fails the permanent CI gate when the total real-write switch is true', () => {
    const result = spawnSync(process.execPath, [verifier], {
      encoding: 'utf8',
      env: { ...process.env, ALLOW_REAL_PROVIDER_WRITES: 'true', CI: 'true' },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ALLOW_REAL_PROVIDER_WRITES must remain false/u)
  })

  it('fails closed for alternate truthy spellings before env parsing', () => {
    const result = spawnSync(process.execPath, [verifier], {
      encoding: 'utf8',
      env: { ...process.env, ALLOW_REAL_PROVIDER_WRITES: 'TRUE', CI: '1' },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ALLOW_REAL_PROVIDER_WRITES must remain false/u)
  })

  it('accepts the explicit false value in CI and enforces the same rule during env parsing', () => {
    const result = spawnSync(process.execPath, [verifier], {
      encoding: 'utf8',
      env: { ...process.env, ALLOW_REAL_PROVIDER_WRITES: 'false', CI: 'true' },
    })
    expect(result.status).toBe(0)

    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('CI', 'true')
    resetEnvForTests()
    expect(() => getEnv()).toThrow(/real provider writes are forbidden in CI/u)
  })
})
