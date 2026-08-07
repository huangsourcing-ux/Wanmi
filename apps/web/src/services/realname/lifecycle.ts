import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import { getTraceId } from '@/lib/request-id'
import { createRealnameObjectProvider } from '@/providers/oss-realname'
import type { RealnameObjectProvider } from '@/providers/types'
import { recordAuditEvent, type AuditActor } from '@/services/audit/record-audit-event'

import { disableRealnameTemplateForLifecycle } from './templates'

export { realnameCleanupDeadline } from './retention'

type TemplateRecord = Record<string, unknown> & { id: number | string }
type DocumentRecord = Record<string, unknown> & { id: number | string }
type BackupObject = { deletedAt?: string | null; id?: string | null; objectKey: string }

export async function disableCustomerRealnameTemplates(
  req: PayloadRequest,
  input: { actor: AuditActor; customerId: number | string; startedAt: string },
): Promise<number> {
  const templates = await req.payload.find({
    collection: 'realnameTemplates',
    depth: 0,
    limit: 1000,
    overrideAccess: true,
    req,
    where: {
      and: [{ customer: { equals: input.customerId } }, { status: { not_equals: 'disabled' } }],
    },
  })
  for (const template of templates.docs) {
    await disableRealnameTemplateForLifecycle(req, template as unknown as TemplateRecord, {
      actor: input.actor,
      reasonCode: 'customer_account_deletion_requested',
      startedAt: input.startedAt,
    })
  }
  return templates.docs.length
}

async function markPrimaryDeleted(
  req: PayloadRequest,
  document: DocumentRecord,
  provider: RealnameObjectProvider,
): Promise<DocumentRecord> {
  if (document.primaryObjectDeletedAt) return document
  if (typeof document.objectKey !== 'string' || !document.objectKey) {
    throw new AppError('REALNAME_CLEANUP_REFERENCE_INVALID', '实名清理引用无效', 500)
  }
  const deleted = await provider.deleteObject({
    key: document.objectKey,
    traceId: getTraceId(req.headers),
  })
  if (!deleted.ok) {
    throw new AppError('REALNAME_CLEANUP_STORAGE_UNAVAILABLE', '实名文件清理暂时失败', 503, {
      retryable: true,
    })
  }
  return (await req.payload.update({
    collection: 'realnameDocuments',
    data: { primaryObjectDeletedAt: new Date().toISOString(), storageState: 'deleting' },
    id: document.id,
    overrideAccess: true,
    req,
  })) as unknown as DocumentRecord
}

async function deleteBackupObjects(
  req: PayloadRequest,
  document: DocumentRecord,
  provider: RealnameObjectProvider,
): Promise<DocumentRecord> {
  let current = document
  const backups = Array.isArray(current.backupObjects)
    ? (current.backupObjects as BackupObject[])
    : []
  for (let index = 0; index < backups.length; index += 1) {
    if (backups[index]?.deletedAt) continue
    const backup = backups[index]
    if (!backup?.objectKey) {
      throw new AppError('REALNAME_CLEANUP_REFERENCE_INVALID', '实名清理引用无效', 500)
    }
    const deleted = await provider.deleteObject({
      key: backup.objectKey,
      traceId: getTraceId(req.headers),
    })
    if (!deleted.ok) {
      throw new AppError('REALNAME_CLEANUP_STORAGE_UNAVAILABLE', '实名文件清理暂时失败', 503, {
        retryable: true,
      })
    }
    const nextBackups = (current.backupObjects as BackupObject[]).map(
      (candidate, candidateIndex) =>
        candidateIndex === index
          ? { ...candidate, deletedAt: new Date().toISOString() }
          : candidate,
    )
    current = (await req.payload.update({
      collection: 'realnameDocuments',
      data: { backupObjects: nextBackups },
      id: current.id,
      overrideAccess: true,
      req,
    })) as unknown as DocumentRecord
  }
  return current
}

async function cleanupTemplate(
  req: PayloadRequest,
  template: TemplateRecord,
  provider: RealnameObjectProvider,
): Promise<void> {
  const documents = await req.payload.find({
    collection: 'realnameDocuments',
    depth: 0,
    limit: 1000,
    overrideAccess: true,
    req,
    where: { template: { equals: template.id } },
  })
  for (const rawDocument of documents.docs) {
    const primaryDeleted = await markPrimaryDeleted(
      req,
      rawDocument as unknown as DocumentRecord,
      provider,
    )
    await deleteBackupObjects(req, primaryDeleted, provider)
  }

  const orderReferences = await req.payload.find({
    collection: 'orders',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { realnameTemplate: { equals: template.id } },
  })

  const startedTransaction = await initTransaction(req)
  try {
    for (const document of documents.docs) {
      await req.payload.delete({
        collection: 'realnameDocuments',
        id: document.id,
        overrideAccess: true,
        req,
      })
    }
    const cleanupCompletedAt = new Date().toISOString()
    if (orderReferences.totalDocs) {
      await req.payload.update({
        collection: 'realnameTemplates',
        data: {
          addressChinese: '已删除地址',
          addressEnglish: 'deleted address',
          applicableScopes: ['cg'],
          cityChinese: '已删除',
          cityEnglish: 'deleted',
          cleanupCompletedAt,
          contactFirstNameChinese: '删',
          contactFirstNameEnglish: 'deleted',
          contactLastNameChinese: '除',
          contactLastNameEnglish: 'deleted',
          countryCode: 'CN',
          displayName: '已删除实名模板',
          districtChinese: '已删除',
          email: `deleted-${template.id}@invalid.example`,
          fullNameChinese: '已删除用户',
          identityDocumentNumber: 'deleted',
          identityDocumentType: 'deleted',
          organizationNameChinese: null,
          organizationNameEnglish: null,
          phone: 'deleted',
          phoneAreaCode: null,
          phoneCountryCode: '+86',
          phoneExtension: null,
          phoneType: 'mobile',
          postalCode: '00000',
          providerConfirmedAt: null,
          providerLastCheckedAt: null,
          providerRequestId: null,
          providerReviewState: 'unsubmitted',
          providerTemplateId: null,
          provinceChinese: '已删除',
          provinceEnglish: 'deleted',
          safeFailureReason: null,
        },
        id: template.id,
        overrideAccess: true,
        req,
      })
    } else {
      await req.payload.delete({
        collection: 'realnameTemplates',
        id: template.id,
        overrideAccess: true,
        req,
      })
    }
    await recordAuditEvent(req, {
      action: 'realname.template.cleaned',
      actor: { type: 'system' },
      metadata: {
        cleanupDueAt: template.cleanupDueAt,
        disabledAt: template.disabledAt,
        documentCount: documents.totalDocs,
        retainedOrderReferences: orderReferences.totalDocs,
      },
      targetId: template.id,
    })
    if (startedTransaction) await commitTransaction(req)
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}

export async function runRealnameCleanup(
  req: PayloadRequest,
  input: {
    now?: Date
    provider?: RealnameObjectProvider
    templateId?: number | string
  } = {},
): Promise<{ cleaned: number; failed: number }> {
  if (req.user) {
    throw new AppError('REALNAME_CLEANUP_SYSTEM_ONLY', '实名清理任务只能由后台执行', 403)
  }
  const now = input.now ?? new Date()
  const provider = input.provider ?? createRealnameObjectProvider()
  const due = await req.payload.find({
    collection: 'realnameTemplates',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    req,
    sort: 'cleanupDueAt',
    where: {
      and: [
        { status: { equals: 'disabled' } },
        { cleanupDueAt: { less_than_equal: now.toISOString() } },
        { cleanupCompletedAt: { exists: false } },
        ...(input.templateId === undefined ? [] : [{ id: { equals: input.templateId } }]),
      ],
    },
  })
  let cleaned = 0
  let failed = 0
  for (const template of due.docs) {
    try {
      await cleanupTemplate(req, template as unknown as TemplateRecord, provider)
      cleaned += 1
    } catch (error) {
      failed += 1
      req.payload.logger.error({
        err: error,
        msg: 'Real-name cleanup failed and will be retried',
        templateId: template.id,
      })
    }
  }
  return { cleaned, failed }
}
