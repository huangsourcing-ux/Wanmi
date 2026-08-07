'use client'

import { CheckCircle2Icon, LoaderCircleIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { FormField } from '@/components/forms/form-field'
import { ProblemDetailsView, ResultState } from '@/components/results/result-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  publicFormSubmissionResultSchema,
  type PublicForm,
  type PublicFormSubmissionResult,
} from '@/schemas/forms'

type FormValue = boolean | string

function initialValues(form: PublicForm): Record<string, FormValue> {
  return Object.fromEntries(
    form.fields.map((field) => [field.name, field.type === 'checkbox' ? false : '']),
  )
}

function fallbackProblem(): PublicFormSubmissionResult {
  return publicFormSubmissionResultSchema.parse({
    problem: {
      action: '请稍后重试',
      code: 'FORM_RESPONSE_INVALID',
      detail: '表单服务返回了无法识别的响应',
      message: '表单服务返回了无法识别的响应',
      retryable: true,
      status: 502,
      title: '表单提交失败',
      traceId: globalThis.crypto.randomUUID(),
      type: 'urn:wanmi:problem:FORM_RESPONSE_INVALID',
    },
    state: 'error',
  })
}

export function PublicFormView({ form }: { form: PublicForm }) {
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialValues(form))
  const [result, setResult] = useState<PublicFormSubmissionResult>()
  const [submitting, setSubmitting] = useState(false)

  function setValue(name: string, value: FormValue) {
    setValues((current) => ({ ...current, [name]: value }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setResult(undefined)
    try {
      const response = await fetch('/api/v1/forms/submissions', {
        body: JSON.stringify({ purpose: form.purpose, values }),
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        referrerPolicy: 'origin',
      })
      const parsed = publicFormSubmissionResultSchema.safeParse(
        await response.json().catch(() => undefined),
      )
      const next = parsed.success ? parsed.data : fallbackProblem()
      setResult(next)
      if (next.state === 'ready') setValues(initialValues(form))
    } catch {
      setResult(fallbackProblem())
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <form className="space-y-5" onSubmit={submit}>
        {form.fields.map((field) => {
          const id = `public-form-${form.purpose}-${field.name}`
          if (field.type === 'checkbox') {
            return (
              <div className="flex items-start gap-3" key={field.name}>
                <input
                  checked={values[field.name] === true}
                  className="mt-1 size-4 rounded border-input accent-primary"
                  id={id}
                  name={field.name}
                  onChange={(event) => setValue(field.name, event.currentTarget.checked)}
                  required={field.required}
                  type="checkbox"
                />
                <label className="text-sm leading-6" htmlFor={id}>
                  {field.label}
                  {field.required ? <span aria-hidden="true"> *</span> : null}
                </label>
              </div>
            )
          }

          return (
            <FormField
              id={id}
              key={field.name}
              label={`${field.label}${field.required ? ' *' : ''}`}
            >
              {(controlProps) => {
                if (field.type === 'textarea') {
                  return (
                    <textarea
                      {...controlProps}
                      className={cn(
                        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-36 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
                      )}
                      name={field.name}
                      onChange={(event) => setValue(field.name, event.currentTarget.value)}
                      required={field.required}
                      value={String(values[field.name] ?? '')}
                    />
                  )
                }
                if (field.type === 'select') {
                  return (
                    <select
                      {...controlProps}
                      className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-10 w-full rounded-md border bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
                      name={field.name}
                      onChange={(event) => setValue(field.name, event.currentTarget.value)}
                      required={field.required}
                      value={String(values[field.name] ?? '')}
                    >
                      <option value="">请选择</option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )
                }
                return (
                  <Input
                    {...controlProps}
                    inputMode={field.type === 'number' ? 'decimal' : undefined}
                    name={field.name}
                    onChange={(event) => setValue(field.name, event.currentTarget.value)}
                    required={field.required}
                    type={field.type}
                    value={String(values[field.name] ?? '')}
                  />
                )
              }}
            </FormField>
          )
        })}
        <Button disabled={submitting} type="submit">
          {submitting ? (
            <>
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
              正在提交
            </>
          ) : (
            form.submitButtonLabel
          )}
        </Button>
      </form>

      {result?.state === 'ready' ? (
        <Alert role="status">
          <CheckCircle2Icon aria-hidden="true" className="size-5" />
          <AlertTitle>提交成功</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>我们已收到这次提交。需要回复时，会使用你主动填写的联系方式。</p>
            {result.meta?.traceId ? (
              <p className="text-xs">
                请求 ID：<span className="font-mono break-all">{result.meta.traceId}</span>
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {result?.state === 'error' || result?.state === 'rate_limited' ? (
        <ProblemDetailsView problem={result.problem} />
      ) : null}
      {result?.state === 'partial' || result?.state === 'degraded' ? (
        <ResultState
          description={result.problem.detail}
          state={result.state}
          suggestedAction={result.problem.action}
          title={result.problem.title}
          traceId={result.problem.traceId}
        />
      ) : null}
      {result?.state === 'empty' ? (
        <ResultState description="本次提交没有可保存的内容。" state="empty" title="没有提交内容" />
      ) : null}
    </div>
  )
}
