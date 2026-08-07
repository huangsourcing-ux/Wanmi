import { describe, expect, it } from 'vitest'

import { AppError } from '@/lib/errors'
import { PUBLIC_FORM_CONTRACTS } from '@/services/forms/form-contracts'
import {
  assertManagedFormDefinition,
  managedFormToPublicForm,
  maskFormContact,
  normalizePublicFormSubmission,
  sanitizePlainFormText,
  type ManagedFormDocument,
} from '@/services/forms/form-contracts'

function managedForm(purpose: keyof typeof PUBLIC_FORM_CONTRACTS): ManagedFormDocument {
  const contract = PUBLIC_FORM_CONTRACTS[purpose]
  return {
    confirmationType: 'message',
    emails: [],
    fields: contract.fields.map((field) => ({
      blockType: field.type,
      label: field.label,
      name: field.name,
      options: 'options' in field ? field.options?.map((option) => ({ ...option })) : undefined,
      required: field.required,
    })),
    purpose,
    submitButtonLabel: contract.submitButtonLabel,
    title: contract.title,
  }
}

describe('D3-05 managed Form Builder contracts', () => {
  it.each(['contact', 'feedback', 'request'] as const)(
    'exposes only the approved %s fields as a public model',
    (purpose) => {
      const document = managedForm(purpose)
      expect(() => assertManagedFormDefinition(document)).not.toThrow()
      const publicForm = managedFormToPublicForm(document)
      expect(publicForm.purpose).toBe(purpose)
      expect(publicForm.fields.map(({ name, type }) => `${name}:${type}`)).toEqual(
        PUBLIC_FORM_CONTRACTS[purpose].fields.map(({ name, type }) => `${name}:${type}`),
      )
      expect(JSON.stringify(publicForm)).not.toMatch(/payment|refund|realname|upload|file/u)
    },
  )

  it('rejects upload/payment-like fields, plugin email delivery and redirect confirmations', () => {
    const upload = managedForm('feedback')
    upload.fields![0]!.blockType = 'upload'
    expect(() => assertManagedFormDefinition(upload)).toThrow(AppError)

    const payment = managedForm('request')
    payment.fields!.push({
      blockType: 'text',
      label: '订单号',
      name: 'orderId',
      options: undefined,
      required: false,
    })
    expect(() => assertManagedFormDefinition(payment)).toThrow(/批准矩阵/u)

    expect(() => assertManagedFormDefinition({ ...managedForm('contact'), emails: [{}] })).toThrow(
      /不通过插件邮件外发/u,
    )
    expect(() =>
      assertManagedFormDefinition({ ...managedForm('contact'), confirmationType: 'redirect' }),
    ).toThrow(/不允许提交后跳转/u)
  })

  it('stores only plain text, redacts complete domains and strips query context from page paths', () => {
    expect(() => sanitizePlainFormText('<script>alert(1)</script>', { maxLength: 200 })).toThrow(
      /纯文本/u,
    )

    const normalized = normalizePublicFormSubmission({
      purpose: 'feedback',
      values: {
        contact: 'owner@example.test',
        feedbackType: 'tool_error',
        message: 'wanmi.net 的查询结果有误，请结合请求 ID 检查。',
        pagePath: '/tools/domain-search?q=wanmi.net#result',
        requestId: 'd3-05-unit-request',
        tool: 'domain-search',
      },
    })
    expect(normalized.pagePath).toBe('/tools/domain-search')
    expect(normalized.summary).toContain('[域名已隐藏]')
    expect(normalized.summary).not.toContain('wanmi.net')
    expect(normalized.contactMasked).toBe('o***@***')
    expect(normalized.submissionData).toContainEqual({
      field: 'contact',
      value: 'owner@example.test',
    })
    expect(JSON.stringify(normalized.submissionData)).not.toContain('?q=')
  })

  it('rejects unknown business fields and masks phone-like contacts', () => {
    expect(() =>
      normalizePublicFormSubmission({
        purpose: 'contact',
        values: {
          contact: '13800138000',
          message: '一般咨询',
          orderId: 'forbidden-order',
          topic: 'general',
        },
      } as never),
    ).toThrow(/未批准字段/u)
    expect(maskFormContact('13800138000')).toBe('138****8000')
    expect(() =>
      normalizePublicFormSubmission({
        purpose: 'feedback',
        values: {
          feedbackType: 'tool_error',
          message: '查询结果有误',
          requestId: 'wanmi.net',
        },
      }),
    ).toThrow(/请求 ID/u)
  })

  it('removes contact and identity values from operational summaries', () => {
    const normalized = normalizePublicFormSubmission({
      purpose: 'contact',
      values: {
        contact: 'owner@example.test',
        message: '请联系 owner@example.test 或 13800138000，编号 110105199001011234',
        topic: 'general',
      },
    })
    expect(normalized.summary).toBe('请联系 o***@*** 或 138****8000,编号 [敏感编号已隐藏]')
    expect(normalized.submissionData).toContainEqual({
      field: 'message',
      value: '请联系 owner@example.test 或 13800138000,编号 110105199001011234',
    })
  })
})
