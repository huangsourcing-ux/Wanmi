import type { WorkflowConfig } from 'payload'

import { runMockFulfillment, type FulfillmentInput } from '@/services/commerce/fulfillment'
import { runWechatRefund } from '@/services/commerce/refunds'
import { getRuntimeWechatPayProvider } from '@/providers/wechatpay'
import { runScheduledContentPublish } from '@/services/content/workflow'
import { CONTENT_COLLECTIONS, type ContentCollection } from '@/services/content/types'
import { runAdvertisingMaintenance } from '@/services/advertising/maintenance'
import { reconcileSmsReceipts } from '@/services/auth/sms-receipts'
import { runRealnameCleanup } from '@/services/realname/lifecycle'

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
  concurrency: ({ input }) => input.operationKey,
  inputSchema: [
    { name: 'operationKey', type: 'text', required: true },
    { name: 'orderId', type: 'number', required: true },
    { name: 'traceId', type: 'text', required: true },
    {
      name: 'simulate',
      type: 'select',
      options: ['success', 'timeout-before-submit', 'timeout-after-submit'],
    },
  ],
  queue: 'commerce',
  retries: 0,
  handler: async ({ job, req }) => {
    await runMockFulfillment(req, job.input)
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

export const workflows = [
  publishingProbe,
  contentScheduledPublish,
  backgroundProbe,
  advertisingMaintenance,
  smsReceiptReconciliation,
  realnameCleanup,
  commerceFulfillment,
  wechatRefund,
]
