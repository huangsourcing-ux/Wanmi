'use client'

import { useRequestId } from '@/components/request-context'
import { ProblemDetailsView } from '@/components/results/result-state'
import { AppError, toProblemDetails } from '@/lib/errors'
import { createTraceId, isValidTraceId } from '@/lib/request-id'

export default function FrontendError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const contextualRequestId = useRequestId()
  const digestRequestId = error.digest ? `digest-${error.digest}` : undefined
  const traceId =
    contextualRequestId ??
    (isValidTraceId(digestRequestId) ? digestRequestId : undefined) ??
    createTraceId()
  const problem = toProblemDetails(
    new AppError('PAGE_RENDER_FAILED', '页面暂时无法完成加载', 500, {
      action: '请重试；如果问题持续，请提供请求 ID',
      retryable: true,
      title: '页面暂时不可用',
    }),
    traceId,
  )

  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
      <ProblemDetailsView
        headingLevel={1}
        primaryAction={{ label: '重新加载', onClick: reset }}
        problem={problem}
        secondaryAction={{ href: '/tools', label: '返回工具中心' }}
      />
    </section>
  )
}
