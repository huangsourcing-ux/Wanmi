import { z } from 'zod'

import { CONTENT_WORKFLOW_ACTIONS } from '@/services/content/types'

export const contentWorkflowInputSchema = z
  .object({
    action: z.enum(CONTENT_WORKFLOW_ACTIONS),
    publishAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'schedule_publish' && !value.publishAt) {
      context.addIssue({
        code: 'custom',
        message: '定时发布必须提供 publishAt',
        path: ['publishAt'],
      })
    }
    if (value.action !== 'schedule_publish' && value.publishAt) {
      context.addIssue({
        code: 'custom',
        message: '当前操作不接受 publishAt',
        path: ['publishAt'],
      })
    }
  })

export type ContentWorkflowInput = z.infer<typeof contentWorkflowInputSchema>
