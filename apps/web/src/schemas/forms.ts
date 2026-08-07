import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

export const PUBLIC_FORM_PURPOSES = ['contact', 'feedback', 'request'] as const

export const publicFormPurposeSchema = z.enum(PUBLIC_FORM_PURPOSES)

export type PublicFormPurpose = z.infer<typeof publicFormPurposeSchema>

export const publicFormFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    label: z.string().min(1).max(120),
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    required: z.boolean(),
    type: z.literal('checkbox'),
  }),
  z.strictObject({
    label: z.string().min(1).max(120),
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    required: z.boolean(),
    type: z.enum(['email', 'number', 'text', 'textarea']),
  }),
  z.strictObject({
    label: z.string().min(1).max(120),
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    options: z
      .array(
        z.strictObject({ label: z.string().min(1).max(120), value: z.string().min(1).max(80) }),
      )
      .min(1)
      .max(20),
    placeholder: z.string().min(1).max(120).optional(),
    required: z.boolean(),
    type: z.literal('select'),
  }),
])

export const publicFormSchema = z.strictObject({
  fields: z.array(publicFormFieldSchema).min(1).max(10),
  purpose: publicFormPurposeSchema,
  submitButtonLabel: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
})

export type PublicForm = z.infer<typeof publicFormSchema>
export type PublicFormField = z.infer<typeof publicFormFieldSchema>

const publicFormValueSchema = z.union([z.boolean(), z.number().finite(), z.string().max(4_000)])

export const publicFormSubmissionRequestSchema = z.strictObject({
  purpose: publicFormPurposeSchema,
  values: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), publicFormValueSchema)
    .refine((values) => Object.keys(values).length <= 10, '表单字段数量超过上限'),
})

export type PublicFormSubmissionRequest = z.infer<typeof publicFormSubmissionRequestSchema>

export const publicFormSubmissionReceiptSchema = z.strictObject({
  accepted: z.literal(true),
  purpose: publicFormPurposeSchema,
})

export const publicFormSubmissionResultSchema = createResultSchema(
  publicFormSubmissionReceiptSchema,
)

export type PublicFormSubmissionResult = z.infer<typeof publicFormSubmissionResultSchema>
