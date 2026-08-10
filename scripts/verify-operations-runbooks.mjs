import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runbooks = [
  'abnormal-orders.md',
  'refund-failure.md',
  'balance-shortage.md',
  'realname-leak.md',
  'provider-outage.md',
  'emergency-sales-stop.md',
  'realname-master-key.md',
]
const requiredHeadings = ['触发信号', '影响判定', '处置步骤', '不可做', '事后审计']

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

let endpointCount = 0
for (const filename of runbooks) {
  const path = join(repositoryRoot, 'docs/operations', filename)
  const source = readFileSync(path, 'utf8')
  for (const heading of requiredHeadings) {
    assert(source.includes(`## ${heading}`), `${filename} is missing section: ${heading}`)
  }
  for (const match of source.matchAll(/`(GET|POST|PATCH|PUT|DELETE) (\/api\/v1\/[^` ]+)`/gu)) {
    const [, method, endpoint] = match
    const routePath = endpoint.replaceAll(/\{([^}]+)\}/gu, '[$1]')
    const sourcePath = join(repositoryRoot, 'apps/web/src/app', routePath, 'route.ts')
    assert(existsSync(sourcePath), `${filename} references missing route: ${method} ${endpoint}`)
    const routeSource = readFileSync(sourcePath, 'utf8')
    assert(
      new RegExp(`export\\s+async\\s+function\\s+${method}\\b`, 'u').test(routeSource),
      `${filename} references unsupported method: ${method} ${endpoint}`,
    )
    endpointCount += 1
  }
}

const requiredCodeReferences = [
  [
    'docs/operations/abnormal-orders.md',
    'apps/web/src/services/commerce/payments.ts',
    'replayArchivedWechatPaymentNotification',
  ],
  [
    'docs/operations/refund-failure.md',
    'apps/web/src/services/commerce/refunds.ts',
    'runWechatRefund',
  ],
  [
    'docs/operations/balance-shortage.md',
    'apps/web/src/services/commerce/balance-control.ts',
    'resolvePaidOrderSalesStop',
  ],
  [
    'docs/operations/realname-leak.md',
    'apps/web/src/services/operations/monitoring.ts',
    'readRealnameDocumentAccessTrail',
  ],
  [
    'docs/operations/provider-outage.md',
    'apps/web/src/services/providers/westdigital-operations.ts',
    'claimAttempt',
  ],
  [
    'docs/operations/emergency-sales-stop.md',
    'apps/web/src/services/commerce/balance-control.ts',
    'updateBalanceControl',
  ],
  [
    'docs/operations/realname-master-key.md',
    'apps/web/src/services/realname/master-key.ts',
    'createRealnameDocumentMasterKeyring',
  ],
]

for (const [documentation, sourceFile, symbol] of requiredCodeReferences) {
  const source = readFileSync(join(repositoryRoot, sourceFile), 'utf8')
  assert(
    source.includes(symbol),
    `${documentation} relies on missing implementation symbol ${symbol}`,
  )
}

process.stdout.write(
  `Verified ${runbooks.length} operations Runbooks, ${endpointCount} endpoint references, and implementation links.\n`,
)
