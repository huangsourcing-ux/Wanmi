import type { PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import {
  DEFAULT_OPERATIONS_MONITORING_THRESHOLDS,
  operationsMonitoringThresholdsSchema,
  type OperationsMonitoringThresholds,
} from '@/schemas/operations-monitoring'

export const OPERATIONS_MONITORING_THRESHOLDS_KEY = 'operations.monitoring.thresholds.v1'

export async function loadOperationsMonitoringThresholds(
  req: PayloadRequest,
): Promise<OperationsMonitoringThresholds> {
  const result = await req.payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: OPERATIONS_MONITORING_THRESHOLDS_KEY } },
  })
  if (!result.docs[0]) return DEFAULT_OPERATIONS_MONITORING_THRESHOLDS
  const parsed = operationsMonitoringThresholdsSchema.safeParse(result.docs[0].value)
  if (!parsed.success) {
    throw new AppError('OPERATIONS_MONITORING_THRESHOLDS_INVALID', '运营监控阈值配置无效', 503)
  }
  return parsed.data
}
