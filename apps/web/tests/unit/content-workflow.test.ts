import { describe, expect, it } from 'vitest'

import { AppError } from '@/lib/errors'
import { canExecuteContentAction, contentStatusAfterAction } from '@/services/content/workflow'
import {
  CONTENT_WORKFLOW_ACTIONS,
  CONTENT_WORKFLOW_STATUSES,
  type ContentWorkflowAction,
  type ContentWorkflowStatus,
} from '@/services/content/types'

const allowed: Array<[ContentWorkflowStatus, ContentWorkflowAction, ContentWorkflowStatus]> = [
  ['draft', 'submit_review', 'in_review'],
  ['in_review', 'publish', 'published'],
  ['in_review', 'schedule_publish', 'in_review'],
  ['in_review', 'cancel_scheduled_publish', 'in_review'],
  ['published', 'publish_revision', 'published'],
  ['published', 'unpublish', 'unpublished'],
  ['unpublished', 'archive', 'archived'],
]

describe('D3 content workflow matrix', () => {
  it.each(allowed)('allows %s -> %s -> %s', (from, action, to) => {
    expect(canExecuteContentAction(from, action)).toBe(true)
    expect(contentStatusAfterAction(from, action)).toBe(to)
  })

  it('rejects every transition not explicitly listed and keeps archived terminal', () => {
    const keys = new Set(allowed.map(([status, action]) => `${status}:${action}`))
    for (const status of CONTENT_WORKFLOW_STATUSES) {
      for (const action of CONTENT_WORKFLOW_ACTIONS) {
        if (keys.has(`${status}:${action}`)) continue
        expect(canExecuteContentAction(status, action)).toBe(false)
        expect(() => contentStatusAfterAction(status, action)).toThrow(AppError)
      }
    }
  })
})
