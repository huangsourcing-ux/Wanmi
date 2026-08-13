import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import {
  assertRuntimeEnvironment,
  BASE_RUNTIME_KEYS,
  PRODUCTION_PROVIDER_KEYS,
  REAL_PROVIDER_GATE_KEYS,
  RUNTIME_MODE_KEYS,
  TRANSIENT_OVERRIDE_KEYS,
  parseRuntimeEnvironmentFile,
} from '../../scripts/runtime-environment-contract.mjs'

function configuredProductionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ...Object.fromEntries(
      [...BASE_RUNTIME_KEYS, ...PRODUCTION_PROVIDER_KEYS, ...REAL_PROVIDER_GATE_KEYS].map((key) => [
        key,
        key.startsWith('ALLOW_REAL_') ? 'false' : 'configured',
      ]),
    ),
  }
}

describe('D7 production runtime environment contract', () => {
  it('names every missing production requirement and fails before startup', () => {
    const environment = configuredProductionEnvironment()
    for (const [key, value] of [
      ['ALIYUN_OSS_REALNAME_MODE', 'mock'],
      ['ALIYUN_SMS_MODE', 'mock'],
      ['PUBLIC_STORAGE_MODE', 'local'],
      ['WECHATPAY_MODE', 'fixture'],
      ['WESTDIGITAL_MODE', 'fixture'],
    ]) {
      environment[key] = value
    }
    delete environment.ALIBABA_CLOUD_ACCESS_KEY_ID
    delete environment.OSS_REALNAME_ENDPOINT
    expect(() => assertRuntimeEnvironment(environment, 'production')).toThrow(
      /ALIBABA_CLOUD_ACCESS_KEY_ID, OSS_REALNAME_ENDPOINT/u,
    )
  })

  it('exits before the child command and never echoes secret values', () => {
    const environment = configuredProductionEnvironment()
    Object.assign(environment, {
      ALIYUN_OSS_REALNAME_MODE: 'mock',
      ALIYUN_SMS_MODE: 'mock',
      NODE_ENV: 'production',
      PUBLIC_STORAGE_MODE: 'local',
      WANMI_RUNTIME_PROFILE: 'production',
      WECHATPAY_MODE: 'fixture',
      WESTDIGITAL_MODE: 'fixture',
    })
    const secret = 'runtime-secret-must-not-appear'
    environment.PAYLOAD_SECRET = secret
    delete environment.ALIBABA_CLOUD_ACCESS_KEY_ID
    const result = spawnSync(
      process.execPath,
      [
        resolve(process.cwd(), 'scripts/runtime-entry.mjs'),
        'commerce-worker',
        process.execPath,
        '-e',
        "process.stdout.write('child-started')",
      ],
      { encoding: 'utf8', env: environment },
    )
    expect(result.status).toBe(78)
    expect(result.stderr).toContain('ALIBABA_CLOUD_ACCESS_KEY_ID')
    expect(result.stderr).not.toContain(secret)
    expect(result.stdout).not.toContain('child-started')
  })

  it('accepts complete production settings with all real-provider gates disabled', () => {
    const environment = configuredProductionEnvironment()
    Object.assign(environment, {
      ALIYUN_OSS_REALNAME_MODE: 'mock',
      ALIYUN_SMS_MODE: 'mock',
      PUBLIC_STORAGE_MODE: 'local',
      WECHATPAY_MODE: 'fixture',
      WESTDIGITAL_MODE: 'fixture',
    })
    expect(() => assertRuntimeEnvironment(environment, 'production')).not.toThrow()
    expect(RUNTIME_MODE_KEYS.every((key) => Boolean(environment[key]))).toBe(true)
    expect(REAL_PROVIDER_GATE_KEYS.every((key) => environment[key] === 'false')).toBe(true)
  })

  it('limits transient overrides to contract-test gates and the test phone', () => {
    expect([...TRANSIENT_OVERRIDE_KEYS].sort()).toEqual(
      [
        'ALIYUN_SMS_MODE',
        'ALLOW_REAL_ALIYUN_SMS_SENDS',
        'ALLOW_REAL_PROVIDER_WRITES',
        'WANMI_CONTRACT_TEST_PHONE',
      ].sort(),
    )
    expect(TRANSIENT_OVERRIDE_KEYS.has('ALIBABA_CLOUD_ACCESS_KEY_SECRET')).toBe(false)
    expect(TRANSIENT_OVERRIDE_KEYS.has('OSS_REALNAME_BUCKET')).toBe(false)
  })

  it('rejects duplicate settings without echoing their values', () => {
    const secret = 'must-not-appear-in-error'
    expect(() =>
      parseRuntimeEnvironmentFile(`PAYLOAD_SECRET=${secret}\nPAYLOAD_SECRET=${secret}`),
    ).toThrow('Runtime environment file repeats setting: PAYLOAD_SECRET')
    try {
      parseRuntimeEnvironmentFile(`PAYLOAD_SECRET=${secret}\nPAYLOAD_SECRET=${secret}`)
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })
})
