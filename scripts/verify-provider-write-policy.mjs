import { readFileSync } from 'node:fs'

const inCi = /^(?:1|true)$/iu.test(process.env.CI ?? '')
const realWritesEnabled = /^(?:1|true)$/iu.test(process.env.ALLOW_REAL_PROVIDER_WRITES ?? '')

const gates = [
  'ALLOW_REAL_PROVIDER_WRITES',
  'ALLOW_REAL_ALIYUN_OSS_REALNAME',
  'ALLOW_REAL_ALIYUN_SMS_SENDS',
  'ALLOW_REAL_WECHAT_OFFICIAL_MESSAGES',
  'ALLOW_REAL_WECHATPAY',
  'ALLOW_REAL_WECHATPAY_PAYMENTS',
  'ALLOW_REAL_WECHATPAY_REFUNDS',
  'ALLOW_REAL_WESTDIGITAL',
  'ALLOW_REAL_WESTDIGITAL_DNS_WRITES',
  'ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES',
  'ALLOW_REAL_WESTDIGITAL_READS',
  'ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES',
  'ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES',
  'ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES',
  'ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES',
]

const policyFiles = [
  {
    file: '.env.example',
    pattern: (gate) => new RegExp(`^${gate}=false$`, 'mu'),
  },
  {
    file: '.github/workflows/ci.yml',
    pattern: (gate) => new RegExp(`^\\s+${gate}: 'false'$`, 'mu'),
  },
  {
    file: 'apps/web/tests/setup.ts',
    pattern: (gate) => new RegExp(`^process\\.env\\.${gate} = 'false'$`, 'mu'),
  },
]

if (inCi && realWritesEnabled) {
  throw new Error(
    'CI safety gate: ALLOW_REAL_PROVIDER_WRITES must remain false; real provider writes are forbidden in CI',
  )
}

for (const { file, pattern } of policyFiles) {
  const source = readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8')
  for (const gate of gates) {
    if (!pattern(gate).test(source)) {
      throw new Error(`${file} must pin ${gate} to false`)
    }
  }
}

console.log(
  'Provider write policy verified: repository defaults, tests, and CI pin every real-provider gate to false.',
)
