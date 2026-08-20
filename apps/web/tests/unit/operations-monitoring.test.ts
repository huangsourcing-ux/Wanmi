import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_OPERATIONS_MONITORING_THRESHOLDS } from '@/schemas/operations-monitoring'
import {
  collectAbuseMonitoringSnapshot,
  evaluateOperationsMonitoring,
  type MonitoringSnapshot,
} from '@/services/operations/monitoring'

function healthySnapshot(): MonitoringSnapshot {
  return {
    abuse: {
      invitationGrowthCount: 0,
      pointsEarned: 0,
      registrationCount: 0,
      smsRequestCount: 0,
      walletAbsoluteChangeFen: 0,
    },
    balance: { alertCount: 0, observationAgeMinutes: 0 },
    documents: { accessCount: 0, distinctDocumentCount: 0 },
    fulfillment: { failedOrUnknownCount: 0, staleSubmittedCount: 0 },
    orders: { oldestOpenAgeMinutes: 0, openManualReviewCount: 0 },
    payments: { openManualReviewCount: 0 },
    reconciliation: { differenceCount: 0 },
    refunds: { failedOrUnknownCount: 0, staleSubmittedCount: 0 },
    sms: { attemptCount: 0, failureCount: 0, unknownCount: 0 },
    tools: {
      failureCount: 0,
      firstPartyFailureCount: 0,
      rejectedCount: 0,
      requestCount: 0,
      timeoutCount: 0,
    },
    workers: { commerceHeartbeatAgeMinutes: 0 },
  }
}

describe('D7 operations monitoring thresholds', () => {
  it('collects five de-correlated abuse rates from their authoritative fields without identifiers', async () => {
    const start = '2026-08-20T00:00:00.000Z'
    const end = '2026-08-20T01:00:00.000Z'
    const count = vi.fn(async ({ collection }: { collection: string }) => ({
      totalDocs:
        collection === 'smsChallenges'
          ? 11
          : collection === 'customerSecurityEvents'
            ? 13
            : collection === 'invitationRelationships'
              ? 17
              : 9_999,
    }))
    const find = vi.fn(async ({ collection }: { collection: string }) =>
      collection === 'pointsBatches'
        ? {
            docs: [
              { points: 19, phone: '13812345678' },
              { points: 23, identityDocumentNumber: '11010519491231002X' },
            ],
          }
        : {
            docs: [
              { amountFen: 29, deviceId: 'device-fixture-raw' },
              { amountFen: 31, identifierHash: 'hash-must-not-be-exported' },
            ],
          },
    )
    const snapshot = await collectAbuseMonitoringSnapshot(
      { payload: { count, find } } as never,
      start,
      end,
    )

    expect(snapshot).toEqual({
      invitationGrowthCount: 17,
      pointsEarned: 42,
      registrationCount: 13,
      smsRequestCount: 11,
      walletAbsoluteChangeFen: 60,
    })
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'smsChallenges',
        where: {
          and: [{ sentAt: { greater_than_equal: start } }, { sentAt: { less_than: end } }],
        },
      }),
    )
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'customerSecurityEvents',
        where: {
          and: [
            { event: { equals: 'registration_completed' } },
            { occurredAt: { greater_than_equal: start } },
            { occurredAt: { less_than: end } },
          ],
        },
      }),
    )
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'invitationRelationships',
        where: {
          and: [{ boundAt: { greater_than_equal: start } }, { boundAt: { less_than: end } }],
        },
      }),
    )
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'pointsBatches',
        select: { points: true },
        where: {
          and: [{ createdAt: { greater_than_equal: start } }, { createdAt: { less_than: end } }],
        },
      }),
    )
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'walletEntries',
        select: { amountFen: true, entryType: true },
        where: {
          and: [
            { entryType: { in: ['credit', 'capture', 'recovery'] } },
            { createdAt: { greater_than_equal: start } },
            { createdAt: { less_than: end } },
          ],
        },
      }),
    )
    expect(JSON.stringify(snapshot)).not.toMatch(
      /13812345678|device-fixture-raw|11010519491231002X|identifierHash/iu,
    )
  })

  it('keeps a healthy or low-volume window silent', () => {
    const snapshot = healthySnapshot()
    snapshot.tools.requestCount = DEFAULT_OPERATIONS_MONITORING_THRESHOLDS.tools.minimumRequests - 1
    snapshot.tools.failureCount = snapshot.tools.requestCount
    snapshot.sms.attemptCount = DEFAULT_OPERATIONS_MONITORING_THRESHOLDS.sms.minimumAttempts - 1
    snapshot.sms.failureCount = snapshot.sms.attemptCount
    expect(
      evaluateOperationsMonitoring(snapshot, DEFAULT_OPERATIONS_MONITORING_THRESHOLDS),
    ).toEqual([])
  })

  it('raises explicit alerts for every monitoring category at its configured boundary', () => {
    const thresholds = DEFAULT_OPERATIONS_MONITORING_THRESHOLDS
    const snapshot = healthySnapshot()
    snapshot.abuse = { ...thresholds.abuse }
    snapshot.tools = {
      failureCount: 2,
      firstPartyFailureCount: thresholds.tools.firstPartyFailureCount,
      rejectedCount: thresholds.tools.rejectedCount,
      requestCount: 20,
      timeoutCount: thresholds.tools.timeoutCount,
    }
    snapshot.sms = {
      attemptCount: thresholds.sms.minimumAttempts,
      failureCount: thresholds.sms.minimumAttempts,
      unknownCount: thresholds.sms.unknownCount,
    }
    snapshot.payments.openManualReviewCount = thresholds.payments.openManualReviewCount
    snapshot.orders = {
      oldestOpenAgeMinutes: thresholds.orders.maximumOpenAgeMinutes,
      openManualReviewCount: thresholds.orders.openManualReviewCount,
    }
    snapshot.fulfillment = {
      failedOrUnknownCount: thresholds.fulfillment.failedOrUnknownCount,
      staleSubmittedCount: thresholds.fulfillment.staleSubmittedCount,
    }
    snapshot.refunds = {
      failedOrUnknownCount: thresholds.refunds.failedOrUnknownCount,
      staleSubmittedCount: thresholds.refunds.staleSubmittedCount,
    }
    snapshot.balance = {
      alertCount: thresholds.balance.alertCount,
      observationAgeMinutes: thresholds.balance.maximumObservationAgeMinutes,
    }
    snapshot.documents = {
      accessCount: thresholds.documents.accessCount,
      distinctDocumentCount: thresholds.documents.distinctDocumentCount,
    }
    snapshot.reconciliation.differenceCount = thresholds.reconciliation.differenceCount
    snapshot.workers.commerceHeartbeatAgeMinutes =
      thresholds.workers.commerceMaximumHeartbeatAgeMinutes

    const alerts = evaluateOperationsMonitoring(snapshot, thresholds)
    expect(new Set(alerts.map((alert) => alert.category))).toEqual(
      new Set([
        'abuse',
        'tools',
        'sms',
        'payments',
        'orders',
        'fulfillment',
        'refunds',
        'balance',
        'documents',
        'reconciliation',
        'workers',
      ]),
    )
    expect(alerts).toContainEqual({
      category: 'balance',
      condition: 'observation_age_minutes',
      observed: thresholds.balance.maximumObservationAgeMinutes,
      threshold: thresholds.balance.maximumObservationAgeMinutes,
    })
    expect(alerts).toContainEqual({
      category: 'tools',
      condition: 'failure_rate_basis_points',
      observed: 1_000,
      threshold: thresholds.tools.failureRateBasisPoints,
    })
  })

  it('alerts when the commerce Worker heartbeat is missing or stale', () => {
    const thresholds = DEFAULT_OPERATIONS_MONITORING_THRESHOLDS
    const missing = healthySnapshot()
    missing.workers.commerceHeartbeatAgeMinutes = null
    expect(evaluateOperationsMonitoring(missing, thresholds)).toContainEqual({
      category: 'workers',
      condition: 'commerce_heartbeat_age_minutes',
      observed: 'missing',
      threshold: thresholds.workers.commerceMaximumHeartbeatAgeMinutes,
    })

    const stale = healthySnapshot()
    stale.workers.commerceHeartbeatAgeMinutes =
      thresholds.workers.commerceMaximumHeartbeatAgeMinutes
    expect(evaluateOperationsMonitoring(stale, thresholds)).toContainEqual({
      category: 'workers',
      condition: 'commerce_heartbeat_age_minutes',
      observed: thresholds.workers.commerceMaximumHeartbeatAgeMinutes,
      threshold: thresholds.workers.commerceMaximumHeartbeatAgeMinutes,
    })
  })

  it('alerts when the independent balance observation is missing without leaking metric dimensions', () => {
    const snapshot = healthySnapshot()
    snapshot.balance.observationAgeMinutes = null
    const alerts = evaluateOperationsMonitoring(snapshot, DEFAULT_OPERATIONS_MONITORING_THRESHOLDS)
    expect(alerts).toEqual([
      {
        category: 'balance',
        condition: 'observation_age_minutes',
        observed: 'missing',
        threshold: DEFAULT_OPERATIONS_MONITORING_THRESHOLDS.balance.maximumObservationAgeMinutes,
      },
    ])
    expect(JSON.stringify(alerts)).not.toMatch(
      /phone|deviceId|identityDocument|documentContent|domainAscii|customerId|upstreamCost|markup|credential|13812345678|11010519491231002X/iu,
    )
  })

  it.each([
    ['短信请求速率', 'smsRequestCount', 'sms_request_count'],
    ['注册速率', 'registrationCount', 'registration_count'],
    ['邀请增长速率', 'invitationGrowthCount', 'invitation_growth_count'],
    ['米币赚取速率', 'pointsEarned', 'points_earned'],
    ['余额异常变动', 'walletAbsoluteChangeFen', 'wallet_absolute_change_fen'],
  ] as const)('%s 单独越限时产生独立脱敏告警', (_label, field, condition) => {
    const snapshot = healthySnapshot()
    snapshot.abuse[field] = DEFAULT_OPERATIONS_MONITORING_THRESHOLDS.abuse[field]
    const alerts = evaluateOperationsMonitoring(snapshot, DEFAULT_OPERATIONS_MONITORING_THRESHOLDS)
    expect(alerts).toEqual([
      {
        category: 'abuse',
        condition,
        observed: DEFAULT_OPERATIONS_MONITORING_THRESHOLDS.abuse[field],
        threshold: DEFAULT_OPERATIONS_MONITORING_THRESHOLDS.abuse[field],
      },
    ])
    expect(JSON.stringify({ alerts, snapshot })).not.toMatch(
      /13812345678|device-fixture|11010519491231002X|identityDocument|identifierHash/iu,
    )
  })
})
