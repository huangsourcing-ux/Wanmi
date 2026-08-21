import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import type { Customer } from '@/payload-types'
import { mockSuccess } from '@/providers/mock'
import type { WestDigitalWriteProvider } from '@/providers/types'
import { reconcileWalletLedger } from '@/services/commerce/reconciliation'
import { runNameserverChange } from '@/services/domains/nameserver-changes'
import { readPointsBalance } from '@/services/points/ledger'
import { readCustomerVipStatus } from '@/services/vip/tiers'

type RestoreInput = {
  domain: {
    assetId: number
    changeId: number
    customerId: number
    domainAscii: string
    nameservers: string[]
  }
  pointsCustomerId: number
  period: { end: string; start: string }
  vipCustomerId: number
  vipReadAt: string
  walletAccountId: number
}

function parseInput(): RestoreInput {
  const encoded = process.argv[2]
  if (!encoded) throw new Error('D9 restore verification input is required')
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as RestoreInput
}

function systemHeaders(suffix: string): Headers {
  return new Headers({
    'user-agent': 'Wanmi-D9-Exit-Restore-Exercise',
    'x-forwarded-for': '198.51.100.216',
    'x-request-id': `d9-exit-restore-${suffix}`,
  })
}

const input = parseInput()
const payload = await getPayload({ config })
let exitCode = 0

try {
  const reconciliationReq = await createLocalReq(
    { req: { headers: systemHeaders('wallet') } },
    payload,
  )
  const reconciled = await reconcileWalletLedger(reconciliationReq, {
    loadWechatEntries: async () => [],
    period: input.period,
    traceId: 'd9-exit-restore-wallet',
  })
  const walletResult = reconciled.results.find((result) => {
    const summary = result.record.summary as { accountId?: string } | undefined
    return summary?.accountId === String(input.walletAccountId)
  })
  if (!walletResult) throw new Error('Restored wallet account was not reconciled')

  const pointsReq = await createLocalReq({ req: { headers: systemHeaders('points') } }, payload)
  const points = await readPointsBalance(pointsReq, input.pointsCustomerId)

  const vipCustomer = (await payload.findByID({
    collection: 'customers',
    depth: 0,
    id: input.vipCustomerId,
    overrideAccess: true,
  })) as Customer
  const vipReq = await createLocalReq({ req: { headers: systemHeaders('vip') } }, payload)
  vipReq.user = { ...vipCustomer, collection: 'customers' } as never
  const vip = await readCustomerVipStatus(vipReq, {
    now: () => new Date(input.vipReadAt),
  })

  let domainWriteCount = 0
  let domainQueryCount = 0
  const domainProvider = {
    changeNameservers: async () => {
      domainWriteCount += 1
      throw new Error('A restored unknown operation must not be submitted again')
    },
    queryAsset: async () => {
      domainQueryCount += 1
      return mockSuccess(
        {
          domainAscii: input.domain.domainAscii,
          expiresAt: '2028-08-20T04:00:00.000Z',
          nameservers: input.domain.nameservers,
          registeredAt: '2026-08-20T04:00:00.000Z',
          registrarCode: 'west',
          status: 'active' as const,
        },
        `d9-exit-restore-domain-query-${domainQueryCount}`,
      )
    },
  } as unknown as WestDigitalWriteProvider
  const domainReq = await createLocalReq({ req: { headers: systemHeaders('domain') } }, payload)
  const domain = await runNameserverChange(
    domainReq,
    {
      assetId: input.domain.assetId,
      changeId: input.domain.changeId,
      operationKey: `nameserver-change:${input.domain.changeId}`,
      traceId: 'd9-exit-restore-domain',
    },
    domainProvider,
  )

  process.stdout.write(
    `D9_EXIT_RESTORE_RESULT ${JSON.stringify({
      domain: {
        queryCount: domainQueryCount,
        status: domain.status,
        writeCount: domainWriteCount,
      },
      points: {
        available: points.available.toString(),
        consumed: points.consumed.toString(),
        pending: points.pending.toString(),
      },
      vip: {
        cumulativeSpendFen: vip.cumulativeSpendFen,
        tierRank: vip.tier?.tierRank ?? null,
      },
      wallet: {
        differenceMinor: walletResult.record.differenceMinor,
        status: walletResult.record.status,
      },
    })}\n`,
  )
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await Promise.race([
    payload.db.destroy?.() ?? Promise.resolve(),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ])
}

process.exit(exitCode)
