import { z } from 'zod'

const countThreshold = z.number().int().min(1).max(1_000_000)
const ageThreshold = z
  .number()
  .int()
  .min(5)
  .max(30 * 24 * 60)

export const operationsMonitoringThresholdsSchema = z
  .object({
    balance: z
      .object({
        alertCount: countThreshold,
        maximumObservationAgeMinutes: ageThreshold,
      })
      .strict(),
    documents: z
      .object({
        accessCount: countThreshold,
        distinctDocumentCount: countThreshold,
      })
      .strict(),
    fulfillment: z
      .object({
        failedOrUnknownCount: countThreshold,
        staleSubmittedCount: countThreshold,
        staleSubmittedMinutes: ageThreshold,
      })
      .strict(),
    orders: z
      .object({
        maximumOpenAgeMinutes: ageThreshold,
        openManualReviewCount: countThreshold,
      })
      .strict(),
    payments: z.object({ openManualReviewCount: countThreshold }).strict(),
    reconciliation: z.object({ differenceCount: countThreshold }).strict(),
    refunds: z
      .object({
        failedOrUnknownCount: countThreshold,
        staleSubmittedCount: countThreshold,
        staleSubmittedMinutes: ageThreshold,
      })
      .strict(),
    schemaVersion: z.literal(1),
    sms: z
      .object({
        failureRateBasisPoints: z.number().int().min(1).max(10_000),
        minimumAttempts: countThreshold,
        unknownCount: countThreshold,
      })
      .strict(),
    tools: z
      .object({
        failureRateBasisPoints: z.number().int().min(1).max(10_000),
        firstPartyFailureCount: countThreshold,
        minimumRequests: countThreshold,
        rejectedCount: countThreshold,
        timeoutCount: countThreshold,
      })
      .strict(),
    workers: z
      .object({
        commerceMaximumHeartbeatAgeMinutes: ageThreshold.default(5),
      })
      .strict()
      .default({ commerceMaximumHeartbeatAgeMinutes: 5 }),
    windowMinutes: z
      .number()
      .int()
      .min(15)
      .max(24 * 60),
  })
  .strict()

export type OperationsMonitoringThresholds = z.infer<typeof operationsMonitoringThresholdsSchema>

export const DEFAULT_OPERATIONS_MONITORING_THRESHOLDS = operationsMonitoringThresholdsSchema.parse({
  balance: { alertCount: 1, maximumObservationAgeMinutes: 15 },
  documents: { accessCount: 50, distinctDocumentCount: 20 },
  fulfillment: {
    failedOrUnknownCount: 1,
    staleSubmittedCount: 1,
    staleSubmittedMinutes: 30,
  },
  orders: { maximumOpenAgeMinutes: 60, openManualReviewCount: 1 },
  payments: { openManualReviewCount: 1 },
  reconciliation: { differenceCount: 1 },
  refunds: {
    failedOrUnknownCount: 1,
    staleSubmittedCount: 1,
    staleSubmittedMinutes: 30,
  },
  schemaVersion: 1,
  sms: { failureRateBasisPoints: 1_000, minimumAttempts: 10, unknownCount: 3 },
  tools: {
    failureRateBasisPoints: 1_000,
    firstPartyFailureCount: 10,
    minimumRequests: 20,
    rejectedCount: 5,
    timeoutCount: 5,
  },
  workers: { commerceMaximumHeartbeatAgeMinutes: 5 },
  windowMinutes: 60,
})
