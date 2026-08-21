import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const acceptanceFile =
  'tests/integration/d9-exit-conditions-part-two.acceptance.integration.test.ts'
const vitestArguments = ['exec', 'vitest', 'run', acceptanceFile, '--reporter=verbose']

const highWaterTest = 'VIP 为历史最高水位：重算结果一致；普通退款不降级；经审批的数据纠错可降级'
const raisedThresholdTest = '提高门槛后已达成用户保留原等级；充值本身不计入累计消费'
const restoreTest = '数据库备份恢复后，余额、积分、等级与域名任务状态可重新对账'
const providerUnknownTest = '外部 provider 超时或返回未知状态时不得盲目重复写操作'

const mutations = [
  {
    expectedTests: ['NS、MX、解锁、管理密码操作未完成 step-up 时 fail-closed'],
    file: 'src/services/domains/domain-management.ts',
    find: `    await authorizeStepUpGrant(req, {
      customerId: options.customer.id,
      deviceId: input.deviceId,
      headers: req.headers,
      purpose: 'domain_lock_change',
      stepUpToken: input.stepUpToken,
    })`,
    id: 'D9-EXIT-02-01',
    replace: '    // mutation: unlocking no longer requires a step-up grant',
  },
  {
    expectedTests: ['注册商不支持某能力时返回明确 capability 错误而非通用失败'],
    file: 'src/services/domains/capabilities.ts',
    find: "throw new AppError(value.unsupportedCode, '当前注册商不支持该域名能力', 409, {",
    id: 'D9-EXIT-02-02',
    replace: "throw new AppError('DOMAIN_OPERATION_FAILED', '域名操作失败', 500, {",
  },
  {
    expectedTests: ['域名已不属于当前上游账户时自动阻止操作'],
    file: 'src/services/providers/westdigital-operations.ts',
    find: "  if (queried.state === 'ready') return queried.data\n  const code =",
    id: 'D9-EXIT-02-03',
    replace: `  if (queried.state === 'ready') return queried.data
  if ('problem' in queried && queried.problem.code === 'WESTDIGITAL_ASSET_NOT_IN_ACCOUNT') {
    return {
      domainAscii: input.domainAscii,
      expiresAt: '2028-08-20T04:00:00.000Z',
      nameservers: ['ns1.mutated.example', 'ns2.mutated.example'],
      registeredAt: '2026-08-20T04:00:00.000Z',
      registrarCode: 'west',
      status: 'active',
    }
  }
  const code =`,
  },
  {
    expectedTests: ['米币赚取幂等；跨批次消费按最早过期优先且分配可重算；米币与余额不可互换'],
    file: 'src/services/points/ledger.ts',
    find: '    ORDER BY expires_at ASC, id ASC',
    id: 'D9-EXIT-02-04',
    replace: '    ORDER BY expires_at DESC, id DESC',
  },
  {
    expectedTests: [highWaterTest],
    file: 'src/services/vip/tiers.ts',
    find: '    return { cumulativeSpendFen: cumulative, reversed: true }',
    id: 'D9-EXIT-02-05',
    replace: `    await (
      await database(req)
    ).execute(sql\`DELETE FROM vip_tier_events WHERE customer_id = \${customerId}\`)
    return { cumulativeSpendFen: cumulative, reversed: true }`,
  },
  {
    expectedTests: [highWaterTest, raisedThresholdTest],
    file: 'src/services/vip/tiers.ts',
    find: '        !current || current.tierRank === 0',
    id: 'D9-EXIT-02-06',
    replace:
      '        !current || current.tierRank === 0 || (currentBenefits !== undefined && currentBenefits.thresholdFen > cumulative)',
  },
  {
    expectedTests: [
      '邀请奖励只在不可退成功订单后发放；自邀与刷量被拦截并告警，且不自动扣回已发放奖励',
    ],
    file: 'src/services/invitations/rewards.ts',
    find: "    if (input.status !== 'succeeded') return { outcome: 'pending' }",
    id: 'D9-EXIT-02-07',
    replace: "    if (input.status === 'fulfilling') return { outcome: 'pending' }",
  },
  {
    expectedTests: ['通知重复消费同一 outbox 事件只能发送一次'],
    file: 'src/services/notifications/outbox.ts',
    find: "        AND status IN ('pending', 'retry_pending', 'sent')",
    id: 'D9-EXIT-02-08',
    replace: "        AND status IN ('pending', 'retry_pending', 'sent', 'sending')",
  },
  {
    expectedTests: [restoreTest],
    file: 'src/services/commerce/reconciliation.ts',
    find: "          WHEN entry.entry_type = 'credit' THEN entry.amount_fen",
    id: 'D9-EXIT-02-09',
    replace: "          WHEN entry.entry_type = 'credit' THEN 0",
  },
  {
    expectedTests: [restoreTest, providerUnknownTest],
    file: 'src/services/providers/westdigital-operations.ts',
    find: "          status: submitted.error.statusKnown ? 'failed' : 'unknown',",
    id: 'D9-EXIT-02-10',
    replace: "          status: submitted.error.statusKnown ? 'failed' : 'prepared',",
  },
]

function runAcceptance() {
  return spawnSync('pnpm', vitestArguments, {
    cwd: webRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 32 * 1024 * 1024,
  })
}

function plain(output) {
  return output.replaceAll(/\u001b\[[0-9;]*m/g, '')
}

function outputFor(result) {
  return plain(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

function requireBaseline() {
  const result = runAcceptance()
  const output = outputFor(result)
  if (result.status !== 0 || !/Tests\s+10 passed \(10\)/u.test(output)) {
    throw new Error(`D9 acceptance part-two baseline did not pass:\n${output}`)
  }
  process.stdout.write('BASELINE\t10 passed (10)\n')
}

function applySingleMutation(mutation) {
  const absoluteFile = fileURLToPath(new URL(mutation.file, new URL('..', import.meta.url)))
  const original = readFileSync(absoluteFile, 'utf8')
  const occurrences = original.split(mutation.find).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `${mutation.id}: expected one mutation anchor in ${mutation.file}, found ${occurrences}`,
    )
  }

  writeFileSync(absoluteFile, original.replace(mutation.find, mutation.replace))
  try {
    const result = runAcceptance()
    const output = outputFor(result)
    const failedTests = output
      .split('\n')
      .filter((line) => /^ FAIL\s+.* > /u.test(line))
      .map((line) => line.slice(line.lastIndexOf(' > ') + 3))
    const expected = [...mutation.expectedTests].sort()
    const actual = [...failedTests].sort()
    const failedCount = expected.length
    const passedCount = 10 - failedCount
    const summaryIsExact = new RegExp(
      `Tests\\s+${failedCount} failed \\| ${passedCount} passed \\(10\\)`,
      'u',
    ).test(output)
    if (
      result.status === 0 ||
      !summaryIsExact ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    ) {
      throw new Error(
        `${mutation.id}: mutation isolation failed; expected only ${JSON.stringify(expected)} to fail:\n${output}`,
      )
    }
    const diagnosticLines = output.split('\n').map((line) => line.trim())
    const diagnostic =
      diagnosticLines.find(
        (line) =>
          (line.startsWith('AssertionError:') || line.startsWith('Error:')) &&
          !line.includes('Command failed: pnpm exec tsx scripts/verify-d9-exit-restore.ts'),
      ) ??
      diagnosticLines.find((line) => line.startsWith('→')) ??
      'AssertionError: see Vitest output'
    process.stdout.write(`${mutation.id}\t${expected.join('；')}\t${diagnostic}\n`)
  } finally {
    writeFileSync(absoluteFile, original)
  }
}

requireBaseline()
const requestedIds = new Set(process.argv.slice(2))
const selectedMutations = requestedIds.size
  ? mutations.filter((mutation) => requestedIds.has(mutation.id))
  : mutations
if (requestedIds.size > 0 && requestedIds.size !== selectedMutations.length) {
  throw new Error(`Unknown mutation id(s): ${[...requestedIds].join(', ')}`)
}
for (const mutation of selectedMutations) applySingleMutation(mutation)
process.stdout.write(`COMPLETE\t${selectedMutations.length} isolated mutations proved\n`)
