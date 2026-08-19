import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integration = 'tests/integration/d9b3-balance-payments.integration.test.ts'
const route = 'tests/unit/payment-route.test.ts'

const files = {
  paymentRoute: 'src/app/api/v1/orders/[orderNumber]/payments/route.ts',
  schema: 'src/schemas/payments.ts',
  service: 'src/services/commerce/balance-payments.ts',
}

const mutations = [
  {
    file: files.schema,
    id: 'schema-device-required',
    predicate: 'a balance request must provide its step-up device binding',
    replacement: '    deviceId: z.string().min(16).max(128).optional(),\n',
    search: '    deviceId: z.string().min(16).max(128),\n',
    test: 'rejects balance payment without deviceId before dispatch',
    testFile: route,
  },
  {
    file: files.schema,
    id: 'schema-token-required',
    predicate: 'a balance request must provide a step-up token',
    replacement: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),\n',
    search: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n',
    test: 'rejects balance payment without stepUpToken before dispatch',
    testFile: route,
  },
  {
    file: files.schema,
    id: 'schema-token-format',
    predicate: 'the balance step-up token must use the opaque-token format',
    replacement: '    stepUpToken: z.string().min(1),\n',
    search: '    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),\n',
    test: 'rejects balance payment without well-formed stepUpToken before dispatch',
    testFile: route,
  },
  {
    file: files.paymentRoute,
    id: 'route-device-source',
    predicate: 'the route forwards the submitted device binding to the balance service',
    replacement: '',
    search: '                  deviceId: input.deviceId,\n',
    test: 'dispatches balance without invoking the WeChat payment path or returning provider URLs',
    testFile: route,
  },
  {
    file: files.paymentRoute,
    id: 'route-token-source',
    predicate: 'the route forwards the submitted step-up token to the balance service',
    replacement: '',
    search: '                  stepUpToken: input.stepUpToken,\n',
    test: 'dispatches balance without invoking the WeChat payment path or returning provider URLs',
    testFile: route,
  },
  {
    file: files.service,
    id: 'service-stepup-callpoint',
    predicate: 'interactive balance spend consumes a valid step-up grant',
    replacement: '',
    search:
      "    await authorizeStepUpGrant(req, {\n      customerId: options.customer.id,\n      deviceId: options.deviceId,\n      headers: req.headers,\n      purpose: 'balance_spend',\n      stepUpToken: options.stepUpToken,\n    })\n",
    test: 'rejects a missing balance_spend step-up grant without changing balance or order state',
    testFile: integration,
  },
  {
    file: files.service,
    id: 'service-purpose-source',
    predicate: 'interactive balance spend requests exactly the balance_spend purpose',
    replacement: "      purpose: 'dns_record_change',\n",
    search: "      purpose: 'balance_spend',\n",
    test: 'rejects a dns_record_change grant for balance spend without changing balance or order state',
    testFile: integration,
  },
  {
    file: files.service,
    id: 'service-device-source',
    predicate: 'authorization uses the submitted device rather than another request field',
    replacement: '      deviceId: options.stepUpToken,\n',
    search: '      deviceId: options.deviceId,\n',
    test: 'accepts a matching balance_spend grant bound to the submitted device and token',
    testFile: integration,
  },
  {
    file: files.service,
    id: 'service-token-source',
    predicate: 'authorization uses the submitted token rather than another request field',
    replacement: '      stepUpToken: options.deviceId,\n',
    search: '      stepUpToken: options.stepUpToken,\n',
    test: 'accepts a matching balance_spend grant bound to the submitted device and token',
    testFile: integration,
  },
]

function occurrences(source, search) {
  return source.split(search).length - 1
}

function mutatedSource(mutation) {
  const source = readFileSync(`${webRoot}/${mutation.file}`, 'utf8')
  const found = occurrences(source, mutation.search)
  if (found !== 1) {
    throw new Error(`expected 1 occurrence of ${JSON.stringify(mutation.search)}, found ${found}`)
  }
  return { original: source, mutated: source.replace(mutation.search, mutation.replacement) }
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.id}\t${mutation.predicate}\t${mutation.testFile} :: ${mutation.test}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}

if (selectors.includes('--validate')) {
  let valid = 0
  for (const mutation of mutations) {
    try {
      mutatedSource(mutation)
      valid += 1
    } catch (error) {
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${valid}/${mutations.length}\n`)
  if (valid !== mutations.length) process.exitCode = 1
  process.exit()
}

const selected = selectors.length
  ? mutations.filter((mutation) => selectors.includes(mutation.id))
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-B-3 balance step-up mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  let source
  try {
    source = mutatedSource(mutation)
  } catch (error) {
    process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    failed = true
    continue
  }
  let result
  try {
    writeFileSync(path, source.mutated, 'utf8')
    result = spawnSync(
      'pnpm',
      [
        '--filter',
        '@wanmi/web',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.config.mts',
        mutation.testFile,
        '-t',
        mutation.test,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_REAL_WECHATPAY: 'false',
          ALLOW_REAL_WECHATPAY_PAYMENTS: 'false',
          ALLOW_REAL_WECHATPAY_REFUNDS: 'false',
          ALLOW_REAL_WESTDIGITAL: 'false',
          ALLOW_REAL_WESTDIGITAL_DNS_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_READS: 'false',
          ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES: 'false',
          ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES: 'false',
        },
      },
    )
  } finally {
    writeFileSync(path, source.original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const lines = output.split('\n')
  const assertionIndex = lines.findIndex((line) => line.includes('AssertionError:'))
  const rawFailure = assertionIndex >= 0 ? lines.slice(assertionIndex, assertionIndex + 12) : []
  process.stdout.write(
    `\nMUTATION ${mutation.id}\nPREDICATE ${mutation.predicate}\nTEST ${mutation.testFile} :: ${mutation.test}\nRAW_FAILURE\n${rawFailure.join('\n')}\n`,
  )
  if (result?.status !== 0 && assertionIndex >= 0) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`RAW_OUTPUT ${lines.slice(-35).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write(
  `\nD9B3_BALANCE_STEP_UP_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
