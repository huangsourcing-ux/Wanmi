'use client'

import { Button, toast, useDocumentInfo, useFormFields, useFormModified } from '@payloadcms/ui'
import { useMemo, useState } from 'react'

import type { ContentWorkflowAction, ContentWorkflowStatus } from '@/services/content/types'

const actionLabels: Record<ContentWorkflowAction, string> = {
  archive: '归档',
  cancel_scheduled_publish: '取消定时',
  publish: '立即发布',
  publish_revision: '发布修订',
  schedule_publish: '定时发布',
  submit_review: '提交审核',
  unpublish: '下线',
}

function actionsFor(status: ContentWorkflowStatus, scheduled: boolean): ContentWorkflowAction[] {
  if (status === 'draft') return ['submit_review']
  if (status === 'in_review') {
    return scheduled
      ? ['publish', 'schedule_publish', 'cancel_scheduled_publish']
      : ['publish', 'schedule_publish']
  }
  if (status === 'published') return ['publish_revision', 'unpublish']
  if (status === 'unpublished') return ['archive']
  return []
}

export function ContentWorkflowControls() {
  const { collectionSlug, id } = useDocumentInfo()
  const modified = useFormModified()
  const workflowStatus = useFormFields(([fields]) => fields.workflowStatus?.value)
  const scheduledPublishAt = useFormFields(([fields]) => fields.scheduledPublishAt?.value)
  const slug = useFormFields(([fields]) => fields.slug?.value)
  const [publishAt, setPublishAt] = useState('')
  const [pending, setPending] = useState<ContentWorkflowAction | null>(null)
  const status =
    typeof workflowStatus === 'string' ? (workflowStatus as ContentWorkflowStatus) : 'draft'
  const actions = useMemo(
    () => actionsFor(status, typeof scheduledPublishAt === 'string' && Boolean(scheduledPublishAt)),
    [scheduledPublishAt, status],
  )

  if (!id || !collectionSlug) {
    return <span className="content-workflow-note">保存草稿后可使用内容工作流</span>
  }

  const run = async (action: ContentWorkflowAction) => {
    if (modified) {
      toast.error('请先等待自动保存完成，再执行工作流操作')
      return
    }
    if (action === 'schedule_publish' && !publishAt) {
      toast.error('请选择定时发布时间')
      return
    }
    setPending(action)
    try {
      const response = await fetch(`/api/v1/content/${collectionSlug}/${id}/workflow`, {
        body: JSON.stringify({
          action,
          publishAt: action === 'schedule_publish' ? new Date(publishAt).toISOString() : undefined,
        }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        const problem = (await response.json().catch(() => undefined)) as
          | { message?: string }
          | undefined
        throw new Error(problem?.message ?? '工作流操作失败')
      }
      toast.success(`${actionLabels[action]}成功`)
      window.location.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '工作流操作失败')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="content-workflow-controls">
      <span className="content-workflow-status">状态：{status}</span>
      {status === 'in_review' ? (
        <input
          aria-label="定时发布时间"
          className="content-workflow-datetime"
          onChange={(event) => setPublishAt(event.target.value)}
          type="datetime-local"
          value={publishAt}
        />
      ) : null}
      {actions.map((action) => (
        <Button
          buttonStyle={action === 'archive' || action === 'unpublish' ? 'secondary' : 'primary'}
          disabled={Boolean(pending)}
          key={action}
          onClick={() => void run(action)}
          size="small"
          type="button"
        >
          {pending === action ? '处理中…' : actionLabels[action]}
        </Button>
      ))}
      {typeof slug === 'string' && slug ? (
        <a
          className="content-workflow-preview"
          href={`/preview/content/${collectionSlug}/${encodeURIComponent(slug)}`}
          rel="noopener"
          target="_blank"
        >
          预览
        </a>
      ) : null}
    </div>
  )
}
