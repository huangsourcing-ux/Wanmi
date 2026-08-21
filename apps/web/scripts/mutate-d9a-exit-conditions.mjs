import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const acceptanceFile = 'tests/integration/d9a-exit-conditions.acceptance.integration.test.ts'
const vitestArguments = ['exec', 'vitest', 'run', acceptanceFile, '--reporter=verbose']

const mutations = [
  {
    expectedTest: '同一微信 openid 从网页授权与 PC 扫码解析为同一账号，不产生重复账号',
    file: 'src/services/auth/wechat.ts',
    find: '      openid: exchanged.openid,',
    id: 'D9A-01',
    replace: '      openid: `${exchanged.openid}:mutated-oauth`,',
  },
  {
    expectedTest:
      '扫码后未点击确认不得建立浏览器会话；scene 一次性、过期失效、跨会话不可复用；未验签的服务号事件不得建立会话',
    file: 'src/services/auth/wechat.ts',
    find: "        AND status = 'confirmed'\n        AND expires_at > NOW()",
    id: 'D9A-02',
    replace: "        AND status IN ('scanned', 'confirmed')\n        AND expires_at > NOW()",
  },
  {
    expectedTest: '网页授权 state 重放、授权码复用、跨站请求均 fail-closed',
    file: 'src/services/auth/wechat.ts',
    find: '        AND browser_session_hash = ${hmac(input.flowToken, getEnv().SESSION_PEPPER)}\n        AND consumed_at IS NULL',
    id: 'D9A-03',
    replace: '        AND consumed_at IS NULL',
  },
  {
    expectedTest:
      '验证码只在短信发送与二维码创建/刷新时校验，轮询不重复校验；校验失败 fail-closed；与四维限频叠加后短信轰炸测试通过',
    file: 'src/services/auth/otp.ts',
    find: '  if (!captcha.ok) {',
    id: 'D9A-04',
    replace: '  if (false && !captcha.ok) {',
  },
  {
    expectedTest: '解绑最后一个可登录身份被拒绝；手机号或微信换绑后全部旧会话失效',
    file: 'src/services/auth/customer-identities.ts',
    find: "      await revokeAllCustomerSessions(req, customer.id, 'identity_replaced')",
    id: 'D9A-05',
    replace: '      // mutation: replacement no longer revokes existing sessions',
  },
  {
    expectedTest: '账户找回成功后高风险域名操作进入冷静期且被拒绝',
    file: 'src/services/auth/account-recovery.ts',
    find: `      await startRecoveryCooldown(req, {
        customerId,
        expectedCooldownStartedAt: state.cooldownStartedAt,
        expectedRestrictions: finalRestrictions,
        expectedStatus: finalStatus,
        startedAt: cooldownStartedAt,
      })`,
    id: 'D9A-06',
    replace: '      // mutation: approved recovery no longer starts the identity-risk cooldown',
  },
  {
    expectedTest: '历史账号不得生成伪造的条款同意时间；未补条款的历史用户仍可处理到期域名',
    file: 'src/services/commerce/order-creation.ts',
    find: `    if (quote.operation === 'registration') {
      await assertLegacyRegistrationPurchaseAllowed(req, options.customer.id)
    }`,
    id: 'D9A-07',
    replace: `    if (true) {
      await assertLegacyRegistrationPurchaseAllowed(req, options.customer.id)
    }`,
  },
  {
    expectedTest: '持有域名、处理中订单或资金差异时不能完成注销',
    file: 'src/services/auth/account-closure.ts',
    find: "  ['domains_held', domainsHeld],\n",
    id: 'D9A-08',
    replace: '',
  },
  {
    expectedTest: 'A4 第 1 行：添加普通子域解析仅需当前会话并记录审计，不错误要求 step-up',
    file: 'src/services/domains/dns-records.ts',
    find: "    record.type === 'MX' ||",
    id: 'D9A-09-A4-01',
    replace: "    record.type === 'A' ||\n    record.type === 'MX' ||",
  },
  {
    expectedTest:
      'A4 第 2 行：修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS 缺少 step-up 时逐项 fail-closed，且二次确认独立生效',
    file: 'src/services/domains/dns-records.ts',
    find: '  if (!highRiskRecord(record)) return',
    id: 'D9A-09-A4-02',
    replace: '  if (true) return',
  },
  {
    expectedTest: 'A4 第 3 行：批量删除解析缺少 step-up 或绑定变更预览时 fail-closed',
    file: 'src/services/domains/dns-records.ts',
    find: `  if (!input.deviceId || !input.stepUpToken) {
    throw new AppError('STEP_UP_GRANT_REQUIRED', '批量删除 DNS 解析需要 step-up 授权', 403)
  }
  await authorizeStepUpGrant(req, {
    customerId: options.customer.id,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: 'dns_bulk_delete',
    stepUpToken: input.stepUpToken,
  })`,
    id: 'D9A-09-A4-03',
    replace: '  // mutation: batch deletion no longer requires a step-up grant',
  },
  {
    expectedTest: 'A4 第 4 行：关闭域名锁缺少 step-up 时 fail-closed，成功后向 active 渠道通知',
    file: 'src/services/domains/domain-management.ts',
    find: `    await authorizeStepUpGrant(req, {
      customerId: options.customer.id,
      deviceId: input.deviceId,
      headers: req.headers,
      purpose: 'domain_lock_change',
      stepUpToken: input.stepUpToken,
    })`,
    id: 'D9A-09-A4-04',
    replace: '    // mutation: unlocking no longer requires a step-up grant',
  },
  {
    expectedTest: 'A4 第 5 行：修改实名信息缺少 step-up 或二次确认时 fail-closed',
    file: 'src/services/domains/domain-management.ts',
    find: `  await authorizeStepUpGrant(req, {
    customerId: customer.id,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: 'realname_change',
    stepUpToken: input.stepUpToken,
  })`,
    id: 'D9A-09-A4-05',
    replace: '  // mutation: real-name changes no longer require a step-up grant',
  },
  {
    expectedTest:
      'A4 第 6 行：获取或修改域名管理密码要求 purpose-bound step-up、active 渠道，并在成功后逐 provider 告知',
    file: 'src/services/domains/domain-management.ts',
    find: `  await authorizeStepUpGrant(req, {
    customerId: customer.id,
    deviceId: input.deviceId,
    headers: req.headers,
    purpose: 'domain_management_password',
    stepUpToken: input.stepUpToken,
  })`,
    id: 'D9A-09-A4-06',
    replace: '  // mutation: management-password operations no longer require a step-up grant',
  },
  {
    expectedTest: 'A4 第 7 行：交互式余额消费缺少 balance_spend step-up 时 fail-closed',
    file: 'src/services/commerce/balance-payments.ts',
    find: `    await authorizeStepUpGrant(req, {
      customerId: options.customer.id,
      deviceId: options.deviceId,
      headers: req.headers,
      purpose: 'balance_spend',
      stepUpToken: options.stepUpToken,
    })`,
    id: 'D9A-09-A4-07',
    replace: '    // mutation: interactive balance spending no longer requires a step-up grant',
  },
  {
    expectedTest:
      'A4 第 8 行：注销申请缺少 account_deletion step-up 时 fail-closed，授权后仍受注销冷静期约束',
    file: 'src/services/auth/step-up.ts',
    find: `          UPDATE step_up_grants
          SET consumed_at = NOW(), updated_at = NOW()
          WHERE token_hash = \${tokenHash}
            AND customer_id = \${input.customerId}
            AND purpose = \${input.purpose}
            AND device_hash = \${deviceHash}`,
    id: 'D9A-09-A4-08',
    replace: `          UPDATE step_up_grants
          SET consumed_at = NOW(), updated_at = NOW()
          WHERE token_hash = \${tokenHash}
            AND customer_id = \${input.customerId}
            AND device_hash = \${deviceHash}`,
  },
  {
    expectedTest: 'A4 第 9 行：账号刚完成找回或换绑时，冷静期内禁止上述全部高风险操作',
    file: 'src/services/auth/step-up.ts',
    find: '    await assertIdentityRiskCooldownInactive(req, input.customerId)',
    id: 'D9A-09-A4-09',
    replace:
      "    if (input.purpose !== 'balance_spend') await assertIdentityRiskCooldownInactive(req, input.customerId)",
  },
  {
    expectedTest:
      'step-up 未完成时风险分级表中的动作全部 fail-closed；step-up 短信验证码发送频控与连续失败次数限制生效',
    file: 'src/services/auth/step-up.ts',
    find: '       AND attempts < $5',
    id: 'D9A-09-SMS',
    replace: '       AND attempts <= $5',
  },
]

function runAcceptance() {
  return spawnSync('pnpm', vitestArguments, {
    cwd: webRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 16 * 1024 * 1024,
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
  if (result.status !== 0 || !/Tests\s+18 passed \(18\)/u.test(output)) {
    throw new Error(`D9-A acceptance baseline did not pass:\n${output}`)
  }
  process.stdout.write('BASELINE\t18 passed (18)\n')
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
    const failedTests = output.split('\n').filter((line) => /^ FAIL\s+.* > /u.test(line))
    const summaryIsExact = /Tests\s+1 failed \| 17 passed \(18\)/u.test(output)
    const targetFailed = failedTests.length === 1 && failedTests[0].includes(mutation.expectedTest)
    if (result.status === 0 || !summaryIsExact || !targetFailed) {
      throw new Error(
        `${mutation.id}: mutation isolation failed; expected only “${mutation.expectedTest}” to fail:\n${output}`,
      )
    }
    const diagnostic =
      output.match(/^AssertionError: .*$/mu)?.[0] ?? 'AssertionError: see Vitest output'
    process.stdout.write(`${mutation.id}\t${mutation.expectedTest}\t${diagnostic}\n`)
  } finally {
    writeFileSync(absoluteFile, original)
  }
}

requireBaseline()
for (const mutation of mutations) applySingleMutation(mutation)
process.stdout.write(`COMPLETE\t${mutations.length} isolated mutations proved\n`)
