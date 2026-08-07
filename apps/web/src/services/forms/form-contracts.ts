import { z } from 'zod'

import { AppError } from '@/lib/errors'
import { REQUEST_ID_PATTERN } from '@/lib/request-id'
import type { PublicForm, PublicFormPurpose, PublicFormSubmissionRequest } from '@/schemas/forms'

type ContractOption = { label: string; value: string }

export type FormFieldContract = {
  label: string
  maxLength?: number
  name: string
  options?: readonly ContractOption[]
  redactDomains?: boolean
  required: boolean
  sensitive?: boolean
  type: 'checkbox' | 'email' | 'number' | 'select' | 'text' | 'textarea'
}

const toolOptions = [
  { label: '域名可注册查询', value: 'domain-search' },
  { label: 'WHOIS / RDAP', value: 'whois' },
  { label: 'DNS 查询', value: 'dns' },
  { label: 'SSL / CAA 检查', value: 'ssl-check' },
  { label: 'IDN 转换', value: 'idn' },
  { label: 'TLD 价格', value: 'pricing' },
] as const

export const PUBLIC_FORM_CONTRACTS = {
  contact: {
    fields: [
      {
        label: '姓名或称呼',
        maxLength: 80,
        name: 'name',
        redactDomains: true,
        required: false,
        type: 'text',
      },
      {
        label: '联系方式',
        maxLength: 160,
        name: 'contact',
        required: true,
        sensitive: true,
        type: 'text',
      },
      {
        label: '联系主题',
        name: 'topic',
        options: [
          { label: '一般咨询', value: 'general' },
          { label: '内容合作', value: 'content' },
          { label: '广告合作', value: 'advertising' },
          { label: '其他事项', value: 'other' },
        ],
        required: true,
        type: 'select',
      },
      {
        label: '具体内容',
        maxLength: 2_000,
        name: 'message',
        redactDomains: true,
        required: true,
        type: 'textarea',
      },
    ],
    submitButtonLabel: '提交联系信息',
    title: '联系 Wanmi',
  },
  feedback: {
    fields: [
      {
        label: '联系方式（选填）',
        maxLength: 160,
        name: 'contact',
        required: false,
        sensitive: true,
        type: 'text',
      },
      {
        label: '反馈类型',
        name: 'feedbackType',
        options: [
          { label: '工具结果问题', value: 'tool_error' },
          { label: '内容问题', value: 'content_issue' },
          { label: '体验建议', value: 'suggestion' },
          { label: '其他反馈', value: 'other' },
        ],
        required: true,
        type: 'select',
      },
      {
        label: '相关工具（选填）',
        name: 'tool',
        options: toolOptions,
        required: false,
        type: 'select',
      },
      {
        label: '相关页面路径（选填）',
        maxLength: 300,
        name: 'pagePath',
        required: false,
        type: 'text',
      },
      {
        label: '请求 ID（选填）',
        maxLength: 128,
        name: 'requestId',
        required: false,
        type: 'text',
      },
      {
        label: '反馈内容',
        maxLength: 2_000,
        name: 'message',
        redactDomains: true,
        required: true,
        type: 'textarea',
      },
    ],
    submitButtonLabel: '提交反馈',
    title: '提交反馈',
  },
  request: {
    fields: [
      {
        label: '联系方式',
        maxLength: 160,
        name: 'contact',
        required: true,
        sensitive: true,
        type: 'text',
      },
      {
        label: '需求类型',
        name: 'requestType',
        options: [
          { label: '新工具能力', value: 'tool_feature' },
          { label: 'TLD 或价格信息', value: 'tld_pricing' },
          { label: '内容选题', value: 'content_topic' },
          { label: '商务合作', value: 'business' },
          { label: '其他需求', value: 'other' },
        ],
        required: true,
        type: 'select',
      },
      {
        label: '需求说明',
        maxLength: 2_000,
        name: 'message',
        redactDomains: true,
        required: true,
        type: 'textarea',
      },
      {
        label: '我同意 Wanmi 使用上述联系方式回复本次需求',
        name: 'consent',
        required: true,
        type: 'checkbox',
      },
    ],
    submitButtonLabel: '提交需求',
    title: '提交需求',
  },
} as const satisfies Record<
  PublicFormPurpose,
  { fields: readonly FormFieldContract[]; submitButtonLabel: string; title: string }
>

const HTML_DELIMITER_PATTERN = /[<>]/u
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu
const DOMAIN_PATTERN =
  /(?<![@\p{Letter}\p{Number}_-])(?:[\p{Letter}\p{Number}](?:[\p{Letter}\p{Number}-]{0,61}[\p{Letter}\p{Number}])?\.)+(?:xn--[a-z0-9-]{2,59}|[\p{Letter}]{2,63})(?![\p{Letter}\p{Number}_-])/giu
const COMPLETE_DOMAIN_PATTERN =
  /^(?:[\p{Letter}\p{Number}](?:[\p{Letter}\p{Number}-]{0,61}[\p{Letter}\p{Number}])?\.)+(?:xn--[a-z0-9-]{2,59}|[\p{Letter}]{2,63})$/iu
const EMAIL_IN_TEXT_PATTERN =
  /[\p{Letter}\p{Number}._%+-]{1,64}@(?:[\p{Letter}\p{Number}](?:[\p{Letter}\p{Number}-]{0,61}[\p{Letter}\p{Number}])?\.)+(?:xn--[a-z0-9-]{2,59}|[\p{Letter}]{2,63})/giu
const PHONE_IN_TEXT_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu
const CHINESE_ID_IN_TEXT_PATTERN =
  /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/gu

function invalid(message: string, code = 'FORM_INVALID'): AppError {
  return new AppError(code, message, 400, {
    action: '请检查填写内容后重试',
    retryable: false,
    title: '表单内容无效',
  })
}

function textLength(value: string): number {
  return [...value].length
}

export function sanitizePlainFormText(
  value: unknown,
  options: { maxLength: number; redactDomains?: boolean; required?: boolean },
): string {
  if (typeof value !== 'string') throw invalid('表单文本字段格式无效')
  const normalized = value
    .normalize('NFKC')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .trim()
  if (!normalized) {
    if (options.required) throw invalid('请填写所有必填字段')
    return ''
  }
  if (HTML_DELIMITER_PATTERN.test(normalized)) {
    throw invalid('表单只接受纯文本，不接受 HTML', 'FORM_HTML_FORBIDDEN')
  }
  if (textLength(normalized) > options.maxLength) {
    throw invalid(`表单文本不能超过 ${options.maxLength} 个字符`, 'FORM_VALUE_TOO_LONG')
  }
  return options.redactDomains ? normalized.replace(DOMAIN_PATTERN, '[域名已隐藏]') : normalized
}

export function maskFormContact(value: string): string {
  if (!value) return ''
  const email = z.email().safeParse(value)
  if (email.success) {
    const [local] = value.split('@') as [string, string]
    return `${local.slice(0, 1)}***@***`
  }
  const digits = value.replace(/\D/gu, '')
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`
  if (textLength(value) <= 2) return `${value.slice(0, 1)}***`
  return `${value.slice(0, 1)}***${value.slice(-1)}`
}

function sanitizeOperationalSummary(value: string): string {
  return value
    .replace(EMAIL_IN_TEXT_PATTERN, (email) => `${email.slice(0, 1)}***@***`)
    .replace(PHONE_IN_TEXT_PATTERN, (phone) => maskFormContact(phone))
    .replace(CHINESE_ID_IN_TEXT_PATTERN, '[敏感编号已隐藏]')
}

function normalizePagePath(value: string): string {
  if (!value) return ''
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw invalid('相关页面只接受站内路径', 'FORM_PAGE_PATH_INVALID')
  }
  const path = value.split(/[?#]/u, 1)[0] ?? ''
  if (!/^\/[A-Za-z0-9/_~.%+-]*$/u.test(path)) {
    throw invalid('相关页面路径格式无效', 'FORM_PAGE_PATH_INVALID')
  }
  return path || '/'
}

function normalizedFieldValue(contract: FormFieldContract, value: unknown): string {
  if (contract.type === 'checkbox') {
    if (value !== true && value !== false) throw invalid(`${contract.label}格式无效`)
    if (contract.required && value !== true) throw invalid(`请确认“${contract.label}”`)
    return value ? 'true' : 'false'
  }
  if (contract.type === 'number') {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) throw invalid(`${contract.label}格式无效`)
    return String(number)
  }

  const text = sanitizePlainFormText(value ?? '', {
    maxLength: contract.maxLength ?? 500,
    redactDomains: contract.redactDomains,
    required: contract.required,
  })
  if (!text) return ''
  if (contract.type === 'email' && !z.email().safeParse(text).success) {
    throw invalid(`${contract.label}不是有效邮箱`)
  }
  if (contract.type === 'select') {
    const allowed = new Set(contract.options?.map((option) => option.value))
    if (!allowed.has(text)) throw invalid(`${contract.label}选项无效`)
  }
  if (contract.name === 'pagePath') return normalizePagePath(text)
  if (contract.name === 'requestId') {
    if (!REQUEST_ID_PATTERN.test(text) || COMPLETE_DOMAIN_PATTERN.test(text)) {
      throw invalid('请求 ID 格式无效', 'FORM_REQUEST_ID_INVALID')
    }
  }
  return text
}

export type NormalizedSubmission = {
  contactMasked?: string
  pagePath?: string
  requestId?: string
  submissionData: Array<{ field: string; value: string }>
  summary: string
  tool?: string
}

export function normalizePublicFormSubmission(
  input: PublicFormSubmissionRequest,
): NormalizedSubmission {
  const contract = PUBLIC_FORM_CONTRACTS[input.purpose]
  const expected = new Set<string>(contract.fields.map((field) => field.name))
  for (const name of Object.keys(input.values)) {
    if (!expected.has(name)) throw invalid('表单包含未批准字段', 'FORM_FIELD_FORBIDDEN')
  }

  const normalized = new Map<string, string>()
  for (const field of contract.fields) {
    const value = normalizedFieldValue(field, input.values[field.name])
    if (value || field.type === 'checkbox') normalized.set(field.name, value)
  }
  const message = normalized.get('message') ?? ''
  return {
    ...(normalized.get('contact')
      ? { contactMasked: maskFormContact(normalized.get('contact')!) }
      : {}),
    ...(normalized.get('pagePath') ? { pagePath: normalized.get('pagePath') } : {}),
    ...(normalized.get('requestId') ? { requestId: normalized.get('requestId') } : {}),
    submissionData: [...normalized].map(([field, value]) => ({ field, value })),
    summary: [...sanitizeOperationalSummary(message)].slice(0, 500).join(''),
    ...(normalized.get('tool') ? { tool: normalized.get('tool') } : {}),
  }
}

type ManagedFormField = {
  blockType?: unknown
  label?: unknown
  name?: unknown
  options?: Array<{ label?: unknown; value?: unknown }> | null
  required?: unknown
}

export type ManagedFormDocument = {
  confirmationType?: unknown
  emails?: unknown[] | null
  fields?: ManagedFormField[] | null
  purpose?: unknown
  submitButtonLabel?: unknown
  title?: unknown
}

export function assertManagedFormDefinition(document: ManagedFormDocument): void {
  if (typeof document.purpose !== 'string' || !(document.purpose in PUBLIC_FORM_CONTRACTS)) {
    throw invalid('表单用途无效', 'FORM_PURPOSE_INVALID')
  }
  const purpose = document.purpose as PublicFormPurpose
  const contract = PUBLIC_FORM_CONTRACTS[purpose]
  const fields = document.fields ?? []
  if (fields.length !== contract.fields.length) {
    throw invalid('表单字段必须与批准矩阵一致', 'FORM_FIELD_FORBIDDEN')
  }
  const byName = new Map(fields.map((field) => [field.name, field]))
  if (byName.size !== fields.length) {
    throw invalid('表单字段名不能重复', 'FORM_FIELD_FORBIDDEN')
  }
  for (const expected of contract.fields) {
    const actual = byName.get(expected.name)
    if (
      !actual ||
      actual.blockType !== expected.type ||
      Boolean(actual.required) !== expected.required
    ) {
      throw invalid('表单字段必须与批准矩阵一致', 'FORM_FIELD_FORBIDDEN')
    }
    if (expected.type === 'select') {
      const actualValues = actual.options?.map((option) => option.value) ?? []
      const expectedValues = expected.options?.map((option) => option.value) ?? []
      if (actualValues.join('\u0000') !== expectedValues.join('\u0000')) {
        throw invalid('表单选项必须与批准矩阵一致', 'FORM_FIELD_FORBIDDEN')
      }
    }
  }
  if (document.confirmationType && document.confirmationType !== 'message') {
    throw invalid('公开表单不允许提交后跳转', 'FORM_REDIRECT_FORBIDDEN')
  }
  if (document.emails?.length) {
    throw invalid('公开表单不通过插件邮件外发敏感提交', 'FORM_EMAIL_FORBIDDEN')
  }
}

export function managedFormToPublicForm(document: ManagedFormDocument): PublicForm {
  assertManagedFormDefinition(document)
  const purpose = document.purpose as PublicFormPurpose
  const contract = PUBLIC_FORM_CONTRACTS[purpose]
  const configured = new Map((document.fields ?? []).map((field) => [field.name, field]))
  return {
    fields: contract.fields.map((field) => {
      const stored = configured.get(field.name)
      const label =
        typeof stored?.label === 'string' && stored.label.trim() ? stored.label.trim() : field.label
      if (field.type === 'select') {
        const storedLabels = new Map(
          stored?.options?.map((option) => [option.value, option.label]) ?? [],
        )
        return {
          label,
          name: field.name,
          options: (field.options ?? []).map((option) => ({
            label:
              typeof storedLabels.get(option.value) === 'string' && storedLabels.get(option.value)
                ? String(storedLabels.get(option.value))
                : option.label,
            value: option.value,
          })),
          required: field.required,
          type: 'select' as const,
        }
      }
      return { label, name: field.name, required: field.required, type: field.type }
    }),
    purpose,
    submitButtonLabel:
      typeof document.submitButtonLabel === 'string' && document.submitButtonLabel.trim()
        ? document.submitButtonLabel.trim()
        : contract.submitButtonLabel,
    title:
      typeof document.title === 'string' && document.title.trim()
        ? document.title.trim()
        : contract.title,
  }
}
