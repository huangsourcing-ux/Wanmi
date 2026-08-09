import { describe, expect, it } from 'vitest'

import { DEFAULT_OPERATIONS_MONITORING_THRESHOLDS } from '@/schemas/operations-monitoring'
import {
  evaluateOperationsMonitoring,
  type MonitoringSnapshot,
} from '@/services/operations/monitoring'

function healthySnapshot(): MonitoringSnapshot {
  return {
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
  }
}

describe('D7 operations monitoring thresholds', () => {
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

  it('raises explicit alerts for all nine monitoring categories at their configured boundary', () => {
    const thresholds = DEFAULT_OPERATIONS_MONITORING_THRESHOLDS
    const snapshot = healthySnapshot()
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

    const alerts = evaluateOperationsMonitoring(snapshot, thresholds)
    expect(new Set(alerts.map((alert) => alert.category))).toEqual(
      new Set([
        'tools',
        'sms',
        'payments',
        'orders',
        'fulfillment',
        'refunds',
        'balance',
        'documents',
        'reconciliation',
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
      /phone|documentContent|domainAscii|customerId|upstreamCost|markup|credential/iu,
    )
  })
})
