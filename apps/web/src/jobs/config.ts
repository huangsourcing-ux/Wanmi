import type { WorkflowConfig } from 'payload'

import {
  runConfiguredCommerceFulfillment,
  type FulfillmentInput,
} from '@/services/commerce/fulfillment'
import { runWechatRefund } from '@/services/commerce/refunds'
import { runPaymentTimeoutClose } from '@/services/commerce/payments'
import { getRuntimeWechatPayProvider } from '@/providers/wechatpay'
import { runScheduledContentPublish } from '@/services/content/workflow'
import { CONTENT_COLLECTIONS, type ContentCollection } from '@/services/content/types'
import { runAdvertisingMaintenance } from '@/services/advertising/maintenance'
import { reconcileSmsReceipts } from '@/services/auth/sms-receipts'
import { runRealnameCleanup } from '@/services/realname/lifecycle'
import { createConfiguredWestDigitalBalanceProvider } from '@/providers/westdigital-balance'
import { monitorWestDigitalBalance } from '@/services/commerce/balance-control'
import {
  runConfiguredNameserverChange,
  type NameserverChangeJobInput,
} from '@/services/domains/nameserver-changes'
import { runConfiguredDomainExpiryReminders } from '@/services/domains/expiry-reminders'
import { runConfiguredAutomaticRenewals } from '@/services/domains/automatic-renewals'
import { runConfiguredDomainAssetSynchronization } from '@/services/domains/domain-assets'
import { runOperationsMonitoring } from '@/services/operations/monitoring'
import { recordCommerceWorkerHeartbeat } from '@/services/operations/worker-heartbeat'
import { runWalletLedgerConsistencyCheck } from '@/services/wallet/invariants'
import { runNotificationDeliveries } from '@/services/notifications/outbox'

const probeInput = [{ name: 'traceId', type: 'text', required: true }] as const

export const publishingProbe: WorkflowConfig<{ traceId: string }> = {
  slug: 'publishingProbe',
  inputSchema: [...probeInput],
  queue: 'publishing',
  retries: 0,
  handler: async ({ job, req }) => {
    req.payload.logger.info(
      { jobId: job.id, traceId: job.input.traceId },
      'publishing probe completed',
    )
  },
}

export const backgroundProbe: WorkflowConfig<{ traceId: string }> = {
  slug: 'backgroundProbe',
  inputSchema: [...probeInput],
  queue: 'background',
  retries: 0,
  handler: async ({ job, req }) => {
    req.payload.logger.info(
      { jobId: job.id, traceId: job.input.traceId },
      'background probe completed',
    )
  },
}

export const advertisingMaintenance: WorkflowConfig = {
  slug: 'advertisingMaintenance',
  concurrency: {
    exclusive: true,
    key: () => 'advertising:maintenance',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '0 * * * * *', queue: 'background' }],
  handler: async ({ req }) => {
    await runAdvertisingMaintenance(req)
  },
}

export const smsReceiptReconciliation: WorkflowConfig = {
  slug: 'smsReceiptReconciliation',
  concurrency: {
    exclusive: true,
    key: () => 'sms:delivery-receipts',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '30 * * * * *', queue: 'background' }],
  handler: async ({ req }) => {
    await reconcileSmsReceipts(req)
  },
}

export const realnameCleanup: WorkflowConfig = {
  slug: 'realnameCleanup',
  concurrency: {
    exclusive: true,
    key: () => 'realname:cleanup',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '0 15 * * * *', queue: 'background' }],
  handler: async ({ req }) => {
    await runRealnameCleanup(req)
  },
}

type ScheduledContentPublishInput = {
  collection: ContentCollection
  documentId: string
  publishAt: string
  scheduledBy: string
}

export const contentScheduledPublish: WorkflowConfig<ScheduledContentPublishInput> = {
  slug: 'contentScheduledPublish',
  concurrency: {
    exclusive: true,
    key: ({ input }) => `content:${input.collection}:${input.documentId}`,
    supersedes: true,
  },
  inputSchema: [
    {
      name: 'collection',
      type: 'select',
      options: [...CONTENT_COLLECTIONS],
      required: true,
    },
    { name: 'documentId', type: 'text', required: true },
    { name: 'publishAt', type: 'date', required: true },
    { name: 'scheduledBy', type: 'text', required: true },
  ],
  queue: 'publishing',
  retries: 2,
  handler: async ({ job, req }) => {
    await runScheduledContentPublish(req, job.input)
  },
}

export const commerceFulfillment: WorkflowConfig<FulfillmentInput> = {
  slug: 'commerceFulfillment',
  concurrency: {
    exclusive: true,
    key: ({ input }) => input.operationKey,
    supersedes: true,
  },
  inputSchema: [
    { name: 'operationKey', type: 'text', required: true },
    { name: 'orderId', type: 'number', required: true },
    { name: 'salesStopReviewId', type: 'number' },
    { name: 'traceId', type: 'text', required: true },
  ],
  queue: 'commerce',
  retries: 0,
  handler: async ({ job, req }) => {
    await runConfiguredCommerceFulfillment(req, job.input)
  },
}

export const commerceWorkerHeartbeat: WorkflowConfig = {
  slug: 'commerceWorkerHeartbeat',
  concurrency: {
    exclusive: true,
    key: () => 'commerce:worker-heartbeat',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'commerce',
  retries: 0,
  schedule: [{ cron: '0 * * * * *', queue: 'commerce' }],
  handler: async ({ req }) => {
    await recordCommerceWorkerHeartbeat(req)
  },
}

export const automaticRenewalScheduling: WorkflowConfig = {
  slug: 'automaticRenewalScheduling',
  concurrency: {
    exclusive: true,
    key: () => 'commerce:automatic-renewal-scheduling',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'commerce',
  retries: 0,
  schedule: [{ cron: '0 10 * * * *', queue: 'commerce' }],
  handler: async ({ req }) => {
    await runConfiguredAutomaticRenewals(req)
  },
}

export const nameserverChange: WorkflowConfig<NameserverChangeJobInput> = {
  slug: 'nameserverChange',
  concurrency: {
    exclusive: true,
    key: ({ input }) => input.operationKey,
    supersedes: true,
  },
  inputSchema: [
    { name: 'assetId', type: 'number', required: true },
    { name: 'changeId', type: 'number', required: true },
    { name: 'operationKey', type: 'text', required: true },
    { name: 'traceId', type: 'text', required: true },
  ],
  queue: 'commerce',
  retries: 0,
  handler: async ({ job, req }) => {
    await runConfiguredNameserverChange(req, job.input)
  },
}

export const westdigitalBalanceMonitoring: WorkflowConfig = {
  slug: 'westdigitalBalanceMonitoring',
  concurrency: {
    exclusive: true,
    key: () => 'westdigital:balance-monitoring',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '0 */5 * * * *', queue: 'background' }],
  handler: async ({ job, req }) => {
    const failures: unknown[] = []
    try {
      await monitorWestDigitalBalance(req, {
        provider: createConfiguredWestDigitalBalanceProvider(),
        traceId: `westdigital-balance-job-${job.id}`,
      })
    } catch (error) {
      failures.push(error)
    }
    try {
      await runOperationsMonitoring(req)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) {
      throw new AggregateError(failures, 'One or more operations monitoring checks failed')
    }
  },
}

export const domainExpiryReminders: WorkflowConfig = {
  slug: 'domainExpiryReminders',
  concurrency: {
    exclusive: true,
    key: () => 'domain:expiry-reminders',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '0 5 * * * *', queue: 'background' }],
  handler: async ({ job, req }) => {
    await runConfiguredDomainExpiryReminders(req, `domain-expiry-reminders-${job.id}`)
  },
}

export const domainAssetSynchronization: WorkflowConfig = {
  slug: 'domainAssetSynchronization',
  concurrency: {
    exclusive: true,
    key: () => 'domain:asset-synchronization',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '0 15 1 * * *', queue: 'background' }],
  handler: async ({ job, req }) => {
    await runConfiguredDomainAssetSynchronization(req, `domain-asset-sync-${job.id}`)
  },
}

export const walletLedgerConsistencyCheck: WorkflowConfig = {
  slug: 'walletLedgerConsistencyCheck',
  concurrency: {
    exclusive: true,
    key: () => 'wallet:ledger-consistency',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '0 30 2 * * *', queue: 'background' }],
  handler: async ({ req }) => {
    await runWalletLedgerConsistencyCheck(req)
  },
}

export const notificationDelivery: WorkflowConfig = {
  slug: 'notificationDelivery',
  concurrency: {
    exclusive: true,
    key: () => 'notifications:transactional-outbox-delivery',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'background',
  retries: 0,
  schedule: [{ cron: '*/15 * * * * *', queue: 'background' }],
  handler: async ({ req }) => {
    await runNotificationDeliveries(req)
  },
}

export const wechatRefund: WorkflowConfig<{ refundId: number; traceId: string }> = {
  slug: 'wechatRefund',
  concurrency: ({ input }) => `wechat-refund:${input.refundId}`,
  inputSchema: [
    { name: 'refundId', type: 'number', required: true },
    { name: 'traceId', type: 'text', required: true },
  ],
  queue: 'commerce',
  retries: 0,
  handler: async ({ job, req }) => {
    await runWechatRefund(req, job.input, getRuntimeWechatPayProvider())
  },
}

export const paymentTimeoutClose: WorkflowConfig = {
  slug: 'paymentTimeoutClose',
  concurrency: {
    exclusive: true,
    key: () => 'wechat-payment-timeout-close',
    supersedes: true,
  },
  inputSchema: [],
  queue: 'commerce',
  retries: 0,
  schedule: [{ cron: '*/30 * * * * *', queue: 'commerce' }],
  handler: async ({ job, req }) => {
    await runPaymentTimeoutClose(req, {
      provider: getRuntimeWechatPayProvider(),
      traceId: `payment-timeout-job-${job.id}`,
    })
  },
}

export const workflows = [
  publishingProbe,
  contentScheduledPublish,
  backgroundProbe,
  advertisingMaintenance,
  smsReceiptReconciliation,
  realnameCleanup,
  westdigitalBalanceMonitoring,
  domainExpiryReminders,
  domainAssetSynchronization,
  walletLedgerConsistencyCheck,
  notificationDelivery,
  commerceFulfillment,
  automaticRenewalScheduling,
  commerceWorkerHeartbeat,
  nameserverChange,
  wechatRefund,
  paymentTimeoutClose,
]
