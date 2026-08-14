import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import {
  applyEntries,
  assertRuntimeEnvironment,
  BASE_RUNTIME_KEYS,
  PRODUCTION_PROVIDER_KEYS,
  REAL_PROVIDER_GATE_KEYS,
  RUNTIME_MODE_KEYS,
  TRANSIENT_OVERRIDE_KEYS,
  parseRuntimeEnvironmentFile,
} from '../../scripts/runtime-environment-contract.mjs'

const WECHATPAY_TRANSIENT_OVERRIDE_KEYS = [
  'ALLOW_REAL_WECHATPAY',
  'ALLOW_REAL_WECHATPAY_PAYMENTS',
  'ALLOW_REAL_WECHATPAY_REFUNDS',
  'WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN',
  'WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN',
] as const

function configuredWechatPayTransientEntries() {
  return new Map(
    WECHATPAY_TRANSIENT_OVERRIDE_KEYS.map((key) => [key, key.endsWith('_FEN') ? '1' : 'true']),
  )
}

function configuredProductionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ...Object.fromEntries(
      [...BASE_RUNTIME_KEYS, ...PRODUCTION_PROVIDER_KEYS, ...REAL_PROVIDER_GATE_KEYS].map((key) => [
        key,
        key.startsWith('ALLOW_REAL_') ? 'false' : 'configured',
      ]),
    ),
    ALIYUN_CAPTCHA_MODE: 'live',
    WECHAT_OFFICIAL_MODE: 'live',
  }
}

describe('D7 production runtime environment contract', () => {
  it('names every missing production requirement and fails before startup', () => {
    const environment = configuredProductionEnvironment()
    for (const [key, value] of [
      ['ALIYUN_OSS_REALNAME_MODE', 'mock'],
      ['ALIYUN_CAPTCHA_MODE', 'live'],
      ['ALIYUN_SMS_MODE', 'mock'],
      ['PUBLIC_STORAGE_MODE', 'local'],
      ['WECHATPAY_MODE', 'fixture'],
      ['WECHAT_OFFICIAL_MODE', 'live'],
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
      ALIYUN_CAPTCHA_MODE: 'live',
      ALIYUN_SMS_MODE: 'mock',
      NODE_ENV: 'production',
      PUBLIC_STORAGE_MODE: 'local',
      WANMI_RUNTIME_PROFILE: 'production',
      WECHATPAY_MODE: 'fixture',
      WECHAT_OFFICIAL_MODE: 'live',
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
      ALIYUN_CAPTCHA_MODE: 'live',
      ALIYUN_SMS_MODE: 'mock',
      PUBLIC_STORAGE_MODE: 'local',
      WECHATPAY_MODE: 'fixture',
      WECHAT_OFFICIAL_MODE: 'live',
      WESTDIGITAL_MODE: 'fixture',
    })
    expect(() => assertRuntimeEnvironment(environment, 'production')).not.toThrow()
    expect(RUNTIME_MODE_KEYS.every((key) => Boolean(environment[key]))).toBe(true)
    expect(REAL_PROVIDER_GATE_KEYS.every((key) => environment[key] === 'false')).toBe(true)
  })

  it('rejects captcha and Wechat Official fixture modes in the production profile', () => {
    const environment = configuredProductionEnvironment()
    Object.assign(environment, {
      ALIYUN_OSS_REALNAME_MODE: 'mock',
      ALIYUN_CAPTCHA_MODE: 'fixture',
      ALIYUN_SMS_MODE: 'mock',
      PUBLIC_STORAGE_MODE: 'local',
      WECHATPAY_MODE: 'fixture',
      WECHAT_OFFICIAL_MODE: 'fixture',
      WESTDIGITAL_MODE: 'fixture',
    })

    expect(() => assertRuntimeEnvironment(environment, 'production')).toThrow(
      /ALIYUN_CAPTCHA_MODE, WECHAT_OFFICIAL_MODE/u,
    )
  })

  it('limits transient overrides to the approved contract-test settings', () => {
    expect([...TRANSIENT_OVERRIDE_KEYS].sort()).toEqual(
      [
        'ALIYUN_SMS_MODE',
        'ALLOW_REAL_ALIYUN_SMS_SENDS',
        'ALLOW_REAL_PROVIDER_WRITES',
        ...WECHATPAY_TRANSIENT_OVERRIDE_KEYS,
        'WANMI_CONTRACT_TEST_PHONE',
      ].sort(),
    )
    expect(TRANSIENT_OVERRIDE_KEYS.has('ALIBABA_CLOUD_ACCESS_KEY_SECRET')).toBe(false)
    expect(TRANSIENT_OVERRIDE_KEYS.has('OSS_REALNAME_BUCKET')).toBe(false)
  })

  it('accepts the Wechat Pay gates and amount limits as transient overrides', () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
    const entries = configuredWechatPayTransientEntries()

    expect(() =>
      applyEntries(environment, entries, TRANSIENT_OVERRIDE_KEYS, 'Transient runtime override'),
    ).not.toThrow()
    expect(environment).toMatchObject(Object.fromEntries(entries))
  })

  it('leaves Wechat Pay settings subject to the existing persistent-file rules', () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
    const entries = configuredWechatPayTransientEntries()

    expect(() =>
      applyEntries(environment, entries, undefined, 'Persistent runtime environment'),
    ).not.toThrow()
    expect(environment).toMatchObject(Object.fromEntries(entries))
  })

  it('continues to reject settings outside the transient override allowlist', () => {
    expect(() =>
      applyEntries(
        {},
        new Map([['WECHATPAY_API_V3_KEY', 'must-not-be-applied']]),
        TRANSIENT_OVERRIDE_KEYS,
        'Transient runtime override',
      ),
    ).toThrow(
      'Transient runtime override contains a setting that cannot be overridden: WECHATPAY_API_V3_KEY',
    )
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
