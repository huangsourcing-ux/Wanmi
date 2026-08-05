// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import FrontendError from '@/app/(frontend)/error'
import { DomainQueryForm } from '@/components/forms/domain-query-form'
import { FormField } from '@/components/forms/form-field'
import { RequestIdProvider } from '@/components/request-context'
import { ProblemDetailsView, ResultState } from '@/components/results/result-state'
import { PageLoading } from '@/components/site/page-loading'
import { toProblemDetails, AppError } from '@/lib/errors'

const traceId = 'component-trace-d1-02'

describe('D1 shared form and result states', () => {
  it('associates labels, descriptions and field errors with the form control', () => {
    render(
      <FormField description="请输入测试值" error="这个字段无效" id="test-field" label="测试字段">
        {(controlProps) => <input {...controlProps} />}
      </FormField>,
    )

    const input = screen.getByLabelText('测试字段')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('test-field-description test-field-error')
    expect(screen.getByRole('alert').textContent).toBe('这个字段无效')
  })

  it('renders the reusable query form with a bounded accessible GET control', () => {
    const { container } = render(<DomainQueryForm defaultValue="wanmi.net" />)
    const input = screen.getByLabelText('输入完整域名或关键词')
    expect(input.getAttribute('name')).toBe('q')
    expect(input.getAttribute('maxlength')).toBe('253')
    expect(input.getAttribute('value')).toBe('wanmi.net')
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/tools/domain-search')
    expect(container.querySelector('form')?.getAttribute('method')).toBe('get')
  })

  it('renders every non-ready state with semantic status treatment', () => {
    for (const state of ['empty', 'partial', 'degraded'] as const) {
      const { unmount } = render(
        <ResultState description={`${state} 说明`} state={state} title={`${state} 标题`} />,
      )
      expect(screen.getByRole('status').textContent).toContain(`${state} 标题`)
      unmount()
    }

    for (const state of ['error', 'rate_limited'] as const) {
      const { unmount } = render(
        <ResultState description={`${state} 说明`} state={state} title={`${state} 标题`} />,
      )
      expect(screen.getByRole('alert').textContent).toContain(`${state} 标题`)
      unmount()
    }
  })

  it('renders an accessible bounded loading state', () => {
    const { container } = render(<PageLoading />)
    const status = screen.getByRole('status', { name: '页面正在加载' })
    expect(status.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(6)
  })

  it('shows source, time, retryability and the contextual request ID for degraded data', () => {
    render(
      <RequestIdProvider requestId={traceId}>
        <ResultState
          cacheStatus="mixed"
          dataSource="Who-Dat"
          description="正在展示最近成功的数据"
          lastSuccessfulAt="2026-08-04T11:00:00.000Z"
          observedAt="2026-08-04T12:00:00.000Z"
          retryable
          state="degraded"
          suggestedAction="稍后重试"
          title="最新数据暂时不可用"
        />
      </RequestIdProvider>,
    )

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Who-Dat')
    expect(status.textContent).toContain('是否可以重试是')
    expect(status.textContent).toContain(traceId)
    expect(status.textContent).toContain('最后成功时间')
    expect(status.textContent).toContain('缓存状态部分缓存命中')
  })

  it('maps a 429 Problem Details object to the rate-limited presentation', () => {
    const problem = toProblemDetails(
      new AppError('RATE_LIMITED', '请求太频繁', 429, {
        action: '稍后重试',
        retryable: true,
        title: '请放慢请求速度',
      }),
      traceId,
    )
    render(<ProblemDetailsView problem={problem} />)
    expect(screen.getByRole('alert').textContent).toContain('请放慢请求速度')
    expect(screen.getByText(traceId)).toBeTruthy()
  })

  it('keeps raw render errors private and offers a working retry action', () => {
    const reset = vi.fn()
    render(
      <RequestIdProvider requestId={traceId}>
        <FrontendError error={new Error('secret server stack')} reset={reset} />
      </RequestIdProvider>,
    )

    expect(screen.getByRole('heading', { level: 1, name: '页面暂时不可用' })).toBeTruthy()
    expect(screen.queryByText(/secret server stack/)).toBeNull()
    expect(screen.getByText(traceId)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(reset).toHaveBeenCalledOnce()
  })
})
