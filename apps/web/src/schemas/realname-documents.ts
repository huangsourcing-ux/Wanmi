import { z } from 'zod'

export const realnameDocumentIdSchema = z.string().regex(/^\d+$/u)
export const realnameTemplateIdSchema = z.string().regex(/^\d+$/u)

export const realnameDocumentAccessRequestSchema = z.object({
  mode: z.enum(['view', 'download']),
})

export const realnameDocumentSummarySchema = z.object({
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  fileKind: z.enum(['jpeg', 'pdf', 'png']),
  id: z.union([z.number(), z.string()]),
  sizeBytes: z.number().int().positive(),
  status: z.enum(['active', 'submitted', 'deleted']),
})

export const realnameDocumentAccessResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  url: z.url(),
})

export const realnameDocumentMutationResponseSchema = z.object({
  documentId: z.union([z.number(), z.string()]),
  status: z.enum(['submitted', 'deleted']),
})
