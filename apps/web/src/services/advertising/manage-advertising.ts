import { randomUUID } from 'node:crypto'

import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeValidateHook,
  PayloadRequest,
} from 'payload'

import { isAdminUser } from '@/access/roles'
import {
  AD_CREATIVE_STATUSES,
  AD_PAGE_TYPES,
  AD_SCHEDULE_STATUSES,
  ADVERTISER_STATUSES,
  normalizeAdPlacementCode,
  normalizeAdTarget,
  normalizeAllowedAdHost,
} from '@/lib/advertising'
import { AppError } from '@/lib/errors'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type DocumentRecord = Record<string, unknown>
type AdvertisingCollection =
  | 'adCreatives'
  | 'adMedia'
  | 'adPlacements'
  | 'adSchedules'
  | 'advertisers'

const ADVERTISER_TRANSITIONS = {
  active: ['paused', 'disabled'],
  disabled: ['draft'],
  draft: ['active', 'disabled'],
  paused: ['active', 'disabled'],
} as const

const CREATIVE_TRANSITIONS = {
  approved: ['draft', 'disabled'],
  disabled: ['draft'],
  draft: ['pending_review', 'disabled'],
  pending_review: ['draft', 'approved', 'rejected', 'disabled'],
  rejected: ['draft', 'disabled'],
} as const

const SCHEDULE_TRANSITIONS = {
  active: ['paused', 'ended', 'disabled'],
  disabled: ['draft'],
  draft: ['scheduled', 'disabled'],
  ended: [],
  paused: ['active', 'ended', 'disabled'],
  scheduled: ['draft', 'active', 'paused', 'ended', 'disabled'],
} as const

function record(value: unknown): DocumentRecord {
  return typeof value === 'object' && value !== null ? (value as DocumentRecord) : {}
}

function relationshipId(value: unknown, field: string): number | string {
  if (typeof value === 'number' || typeof value === 'string') return value
  const candidate = record(value).id
  if (typeof candidate === 'number' || typeof candidate === 'string') return candidate
  throw new AppError('AD_RELATION_INVALID', `${field} 关联无效`, 400)
}

function relatedId(value: unknown): string {
  return String(relationshipId(value, '广告'))
}

function nonEmptyText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new AppError('AD_FIELD_INVALID', `${field}不能为空`, 400)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new AppError('AD_FIELD_INVALID', `${field}必须为 1～${maxLength} 个字符`, 400)
  }
  return normalized
}

function allowedHosts(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 20) {
    throw new AppError('AD_ALLOWED_HOST_INVALID', '每个广告主最多配置 20 个目标主机', 400)
  }
  const normalized = value.map((row) => normalizeAllowedAdHost(record(row).host))
  if (new Set(normalized).size !== normalized.length) {
    throw new AppError('AD_ALLOWED_HOST_INVALID', '广告目标主机不能重复', 400)
  }
  return normalized
}

function rowsForHosts(hosts: readonly string[]): Array<{ host: string }> {
  return hosts.map((host) => ({ host }))
}

function statusValue<T extends readonly string[]>(
  value: unknown,
  statuses: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && statuses.includes(value) ? (value as T[number]) : fallback
}

function enforceTransition(
  current: string,
  next: string,
  transitions: Record<string, readonly string[]>,
): void {
  if (current === next) return
  if (!transitions[current]?.includes(next)) {
    throw new AppError(
      'AD_STATUS_TRANSITION_INVALID',
      `广告状态不能从 ${current} 变更为 ${next}`,
      409,
    )
  }
}

async function findRelated(
  req: PayloadRequest,
  collection: 'adCreatives' | 'adMedia' | 'adPlacements' | 'advertisers',
  id: number | string,
): Promise<DocumentRecord> {
  return (await req.payload.findByID({
    collection,
    depth: 0,
    id,
    overrideAccess: !req.user,
    req,
    user: req.user,
  })) as unknown as DocumentRecord
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new AppError('AD_SCHEDULE_TIME_INVALID', `${field}无效`, 400)
  }
  const parsed = new Date(value).getTime()
  if (!Number.isFinite(parsed)) throw new AppError('AD_SCHEDULE_TIME_INVALID', `${field}无效`, 400)
  return parsed
}

export const guardAdvertiserChange: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  data.name = nonEmptyText(data.name ?? originalDoc?.name, '广告主名称', 120)
  if (data.legalName !== undefined && data.legalName !== null) {
    data.legalName = nonEmptyText(data.legalName, '广告主体名称', 160)
  }
  if (data.allowedHosts !== undefined)
    data.allowedHosts = rowsForHosts(allowedHosts(data.allowedHosts))

  const current = statusValue(originalDoc?.status, ADVERTISER_STATUSES, 'draft')
  let next = statusValue(data.status ?? originalDoc?.status, ADVERTISER_STATUSES, 'draft')
  if (operation === 'create' && isAdminUser(req.user)) next = 'draft'
  if (operation === 'update' && isAdminUser(req.user)) {
    enforceTransition(current, next, ADVERTISER_TRANSITIONS)
  }
  data.status = next
  return data
}

export const guardAdCreativeChange: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const original = record(originalDoc)
  data.name = nonEmptyText(data.name ?? original.name, '素材名称', 120)
  data.headline = nonEmptyText(data.headline ?? original.headline, '广告标题', 120)
  if (data.body !== undefined && data.body !== null) {
    data.body = nonEmptyText(data.body, '广告说明', 240)
  }

  const advertiserId = relationshipId(data.advertiser ?? original.advertiser, '广告主')
  const advertiser = await findRelated(req, 'advertisers', advertiserId)
  const hosts = allowedHosts(advertiser.allowedHosts)
  const targetType = data.targetType ?? original.targetType ?? 'internal'
  if (targetType !== 'internal' && targetType !== 'external') {
    throw new AppError('AD_TARGET_INVALID', '广告目标类型无效', 400)
  }
  data.targetType = targetType
  data.targetUrl = normalizeAdTarget({
    allowedHosts: hosts,
    targetType,
    targetUrl: data.targetUrl ?? original.targetUrl,
  })

  const creativeType = data.creativeType ?? original.creativeType ?? 'image'
  if (creativeType !== 'image' && creativeType !== 'text') {
    throw new AppError('AD_CREATIVE_TYPE_INVALID', '广告素材类型无效', 400)
  }
  data.creativeType = creativeType
  if (creativeType === 'image') {
    const imageId = relationshipId(data.image ?? original.image, '广告图片')
    const image = await findRelated(req, 'adMedia', imageId)
    data.alt = nonEmptyText(data.alt ?? original.alt ?? image.alt, '广告图片替代文本', 160)
  } else {
    data.image = null
    data.alt = null
  }

  const current = statusValue(original.status, AD_CREATIVE_STATUSES, 'draft')
  let next = statusValue(data.status ?? original.status, AD_CREATIVE_STATUSES, 'draft')
  const materialFields = [
    'advertiser',
    'alt',
    'body',
    'creativeType',
    'headline',
    'image',
    'targetType',
    'targetUrl',
  ]
  const materialChange =
    operation === 'update' &&
    materialFields.some(
      (field) =>
        data[field] !== undefined &&
        JSON.stringify(data[field]) !== JSON.stringify(original[field]),
    )
  if (current === 'approved' && materialChange && next === 'approved') next = 'draft'
  if (operation === 'create' && isAdminUser(req.user)) next = 'draft'
  if (operation === 'update' && isAdminUser(req.user)) {
    enforceTransition(current, next, CREATIVE_TRANSITIONS)
  }

  if (next === 'approved') {
    if (advertiser.status !== 'active') {
      throw new AppError('AD_CREATIVE_NOT_PUBLISHABLE', '只有启用广告主的素材可以通过审核', 409)
    }
    if (creativeType === 'image') {
      const image = await findRelated(
        req,
        'adMedia',
        relationshipId(data.image ?? original.image, '广告图片'),
      )
      if (image.reviewed !== true) {
        throw new AppError('AD_CREATIVE_NOT_PUBLISHABLE', '广告图片必须先完成审核', 409)
      }
    }
    data.reviewedAt = new Date().toISOString()
    data.reviewedBy = req.user?.id ? String(req.user.id) : (original.reviewedBy ?? null)
  } else if (current === 'approved') {
    data.reviewedAt = null
    data.reviewedBy = null
  }
  data.status = next
  return data
}

export const guardAdPlacementChange: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  const original = record(originalDoc)
  data.code = normalizeAdPlacementCode(data.code ?? original.code)
  data.name = nonEmptyText(data.name ?? original.name, '广告位名称', 120)
  data.description = nonEmptyText(data.description ?? original.description, '广告位说明', 500)

  const pageTypes = data.pageTypes ?? original.pageTypes
  if (
    !Array.isArray(pageTypes) ||
    pageTypes.length === 0 ||
    pageTypes.some((value) => typeof value !== 'string' || !AD_PAGE_TYPES.includes(value as never))
  ) {
    throw new AppError('AD_PLACEMENT_PAGE_TYPE_INVALID', '广告位必须选择至少一个有效页面类型', 400)
  }
  data.pageTypes = [...new Set(pageTypes)]

  for (const field of ['width', 'height'] as const) {
    const value = data[field] ?? original[field]
    if (!Number.isInteger(value) || Number(value) < 48 || Number(value) > 2_000) {
      throw new AppError('AD_PLACEMENT_SIZE_INVALID', '广告位宽高必须为 48～2000 的整数像素', 400)
    }
    data[field] = value
  }
  return data
}

export const initializeAdSchedule: CollectionBeforeValidateHook = ({
  data,
  operation,
  originalDoc,
}) => {
  if (!data) return data
  data.publicId = operation === 'create' ? randomUUID() : originalDoc?.publicId
  return data
}

export const guardAdScheduleChange: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const original = record(originalDoc)
  data.name = nonEmptyText(data.name ?? original.name, '广告排期名称', 120)
  data.publicId = data.publicId ?? original.publicId

  const startsAt = data.startsAt ?? original.startsAt
  const endsAt = data.endsAt ?? original.endsAt
  const startsAtMs = timestamp(startsAt, '开始时间')
  const endsAtMs = timestamp(endsAt, '结束时间')
  if (startsAtMs >= endsAtMs) {
    throw new AppError('AD_SCHEDULE_TIME_INVALID', '广告排期结束时间必须晚于开始时间', 400)
  }

  const priority = data.priority ?? original.priority ?? 0
  if (!Number.isInteger(priority) || Number(priority) < 0 || Number(priority) > 1_000) {
    throw new AppError('AD_SCHEDULE_PRIORITY_INVALID', '广告优先级必须为 0～1000 的整数', 400)
  }
  data.priority = priority

  const advertiserId = relationshipId(data.advertiser ?? original.advertiser, '广告主')
  const creativeId = relationshipId(data.creative ?? original.creative, '广告素材')
  const placementId = relationshipId(data.placement ?? original.placement, '广告位')
  const [advertiser, creative, placement] = await Promise.all([
    findRelated(req, 'advertisers', advertiserId),
    findRelated(req, 'adCreatives', creativeId),
    findRelated(req, 'adPlacements', placementId),
  ])
  if (relatedId(creative.advertiser) !== String(advertiserId)) {
    throw new AppError('AD_SCHEDULE_RELATION_INVALID', '排期广告主必须与素材广告主一致', 400)
  }

  const current = statusValue(original.status, AD_SCHEDULE_STATUSES, 'draft')
  let next = statusValue(data.status ?? original.status, AD_SCHEDULE_STATUSES, 'draft')
  if (operation === 'create' && isAdminUser(req.user)) next = 'draft'
  if (operation === 'update' && isAdminUser(req.user)) {
    enforceTransition(current, next, SCHEDULE_TRANSITIONS)
  }
  if (next === 'scheduled' || next === 'active') {
    if (
      advertiser.status !== 'active' ||
      creative.status !== 'approved' ||
      placement.enabled !== true
    ) {
      throw new AppError(
        'AD_SCHEDULE_NOT_PUBLISHABLE',
        '启用排期要求广告主、素材和广告位均可用',
        409,
      )
    }
  }
  if (next === 'active' && (Date.now() < startsAtMs || Date.now() >= endsAtMs)) {
    throw new AppError('AD_SCHEDULE_NOT_ACTIVE', '只有当前有效期内的排期可以启用', 409)
  }
  data.status = next
  return data
}

function changedFields(previousDoc: unknown, doc: unknown): string[] {
  const previous = record(previousDoc)
  const current = record(doc)
  const candidates = [
    'allowedHosts',
    'creative',
    'enabled',
    'endsAt',
    'image',
    'placement',
    'priority',
    'reviewed',
    'startsAt',
    'status',
    'targetType',
    'targetUrl',
  ]
  return candidates.filter(
    (field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]),
  )
}

export function auditAdvertisingChange(
  collection: AdvertisingCollection,
): CollectionAfterChangeHook {
  return async ({ doc, operation, previousDoc, req }) => {
    if (!isAdminUser(req.user)) return doc
    const fields = changedFields(previousDoc, doc)
    await recordAuditEvent(req, {
      action: 'advertising.change',
      metadata: {
        collection,
        fields: fields.filter((field) => field !== 'targetUrl'),
        operation,
        statusAfter: doc.status,
        statusBefore: previousDoc?.status,
        targetChanged: fields.includes('targetUrl'),
      },
      targetId: doc.id,
    })
    return doc
  }
}

export function auditAdvertisingDelete(
  collection: AdvertisingCollection,
): CollectionAfterDeleteHook {
  return async ({ doc, req }) => {
    if (!isAdminUser(req.user)) return doc
    await recordAuditEvent(req, {
      action: 'advertising.delete',
      metadata: { collection, statusBefore: doc?.status },
      targetId: doc?.id,
    })
    return doc
  }
}
