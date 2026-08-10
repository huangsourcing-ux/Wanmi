const inCi = /^(?:1|true)$/iu.test(process.env.CI ?? '')
const realWritesEnabled = /^(?:1|true)$/iu.test(process.env.ALLOW_REAL_PROVIDER_WRITES ?? '')

if (inCi && realWritesEnabled) {
  throw new Error(
    'CI safety gate: ALLOW_REAL_PROVIDER_WRITES must remain false; real provider writes are forbidden in CI',
  )
}

console.log('Provider write policy verified: CI cannot enable real provider writes.')
