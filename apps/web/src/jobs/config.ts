import type { WorkflowConfig } from 'payload'

import { runMockFulfillment, type FulfillmentInput } from '@/services/commerce/fulfillment'

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

export const workflows = [publishingProbe, backgroundProbe, commerceFulfillment]
