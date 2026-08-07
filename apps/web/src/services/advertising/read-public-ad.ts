import type { Payload } from 'payload'

import {
  PUBLIC_AD_INTERNAL_CONTEXT,
  type AdDeviceScope,
  type AdPageType,
  normalizeAdTarget,
  publicAdClickPath,
} from '@/lib/advertising'
import { logger } from '@/lib/logging'

type PublicAdPayload = Pick<Payload, 'find' | 'findByID'>
type DocumentRecord = Record<string, unknown>

export type PublicAdvertisement = {
  body?: string
  clickHref: string
  deviceScope: AdDeviceScope
  external: boolean
  headline: string
  image?: {
    alt: string
    height: number
    url: string
    width: number
  }
  placementCode: string
  publicId: string
}

export type ResolvedAdTarget = {
  external: boolean
  targetUrl: string
}

function record(value: unknown): DocumentRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as DocumentRecord) : undefined
}

function relationshipId(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value
  const candidate = record(value)?.id
  return typeof candidate === 'number' || typeof candidate === 'string' ? candidate : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function allowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    const host = stringValue(record(row)?.host)
    return host ? [host] : []
  })
}

function internalContext() {
  return { [PUBLIC_AD_INTERNAL_CONTEXT]: true }
}

async function readByID(
  payload: PublicAdPayload,
  collection: 'adCreatives' | 'adMedia' | 'adPlacements' | 'advertisers',
  id: number | string,
): Promise<DocumentRecord | undefined> {
  return (await payload.findByID({
    collection,
    context: internalContext(),
    depth: 0,
    id,
    overrideAccess: false,
  })) as unknown as DocumentRecord
}

function currentSchedule(schedule: DocumentRecord, now: Date): boolean {
  const startsAt = stringValue(schedule.startsAt)
  const endsAt = stringValue(schedule.endsAt)
  if (schedule.status !== 'active' || !startsAt || !endsAt) return false
  const nowMs = now.getTime()
  return new Date(startsAt).getTime() <= nowMs && new Date(endsAt).getTime() > nowMs
}

function placementMatches(
  placement: DocumentRecord,
  placementCode: string,
  pageType: AdPageType,
): boolean {
  return (
    placement.enabled === true &&
    placement.code === placementCode &&
    Array.isArray(placement.pageTypes) &&
    placement.pageTypes.includes(pageType)
  )
}

async function resolveRelations(
  payload: PublicAdPayload,
  schedule: DocumentRecord,
): Promise<
  | {
      advertiser: DocumentRecord
      creative: DocumentRecord
      placement: DocumentRecord
    }
  | undefined
> {
  const advertiserId = relationshipId(schedule.advertiser)
  const creativeId = relationshipId(schedule.creative)
  const placementId = relationshipId(schedule.placement)
  if (advertiserId === undefined || creativeId === undefined || placementId === undefined) {
    return undefined
  }
  const [advertiser, creative, placement] = await Promise.all([
    readByID(payload, 'advertisers', advertiserId),
    readByID(payload, 'adCreatives', creativeId),
    readByID(payload, 'adPlacements', placementId),
  ])
  if (!advertiser || !creative || !placement) return undefined
  if (
    advertiser.status !== 'active' ||
    creative.status !== 'approved' ||
    String(relationshipId(creative.advertiser)) !== String(advertiserId)
  ) {
    return undefined
  }
  return { advertiser, creative, placement }
}

function validatedTarget(
  advertiser: DocumentRecord,
  creative: DocumentRecord,
): ResolvedAdTarget | undefined {
  const targetType = creative.targetType
  if (targetType !== 'external' && targetType !== 'internal') return undefined
  try {
    return {
      external: targetType === 'external',
      targetUrl: normalizeAdTarget({
        allowedHosts: allowedHosts(advertiser.allowedHosts),
        targetType,
        targetUrl: creative.targetUrl,
      }),
    }
  } catch {
    return undefined
  }
}

async function publicImage(
  payload: PublicAdPayload,
  creative: DocumentRecord,
): Promise<PublicAdvertisement['image'] | undefined> {
  if (creative.creativeType !== 'image') return undefined
  const imageId = relationshipId(creative.image)
  if (imageId === undefined) return undefined
  const image = await readByID(payload, 'adMedia', imageId)
  const alt = stringValue(creative.alt) ?? stringValue(image?.alt)
  const url = stringValue(image?.url)
  const width = numberValue(image?.width)
  const height = numberValue(image?.height)
  if (!image || image.reviewed !== true || !alt || !url || !width || !height) return undefined
  return { alt, height, url, width }
}

export async function readPublicAdvertisement(
  payload: PublicAdPayload,
  input: { now?: Date; pageType: AdPageType; placementCode: string },
): Promise<PublicAdvertisement | null> {
  const now = input.now ?? new Date()
  try {
    const schedules = await payload.find({
      collection: 'adSchedules',
      context: internalContext(),
      depth: 0,
      limit: 20,
      overrideAccess: false,
      sort: '-priority',
      where: {
        and: [
          { status: { equals: 'active' } },
          { startsAt: { less_than_equal: now.toISOString() } },
          { endsAt: { greater_than: now.toISOString() } },
        ],
      },
    })

    const ordered = [...(schedules.docs as unknown as DocumentRecord[])].sort((left, right) => {
      const priority = Number(right.priority ?? 0) - Number(left.priority ?? 0)
      if (priority !== 0) return priority
      return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
    })
    for (const schedule of ordered) {
      if (!currentSchedule(schedule, now)) continue
      const publicId = stringValue(schedule.publicId)
      const relations = await resolveRelations(payload, schedule)
      if (!publicId || !relations) continue
      if (!placementMatches(relations.placement, input.placementCode, input.pageType)) continue
      const target = validatedTarget(relations.advertiser, relations.creative)
      if (!target) continue
      const image = await publicImage(payload, relations.creative)
      if (relations.creative.creativeType === 'image' && !image) continue
      const headline = stringValue(relations.creative.headline)
      if (!headline) continue
      return {
        body: stringValue(relations.creative.body),
        clickHref: publicAdClickPath(publicId),
        deviceScope:
          relations.placement.deviceScope === 'desktop' ||
          relations.placement.deviceScope === 'mobile'
            ? relations.placement.deviceScope
            : 'all',
        external: target.external,
        headline,
        image,
        placementCode: input.placementCode,
        publicId,
      }
    }
  } catch (error) {
    logger.warn({ err: error, msg: 'Public advertisement unavailable' })
  }
  return null
}

export async function resolvePublicAdTarget(
  payload: PublicAdPayload,
  publicId: string,
  now = new Date(),
): Promise<ResolvedAdTarget | null> {
  try {
    const schedules = await payload.find({
      collection: 'adSchedules',
      context: internalContext(),
      depth: 0,
      limit: 1,
      overrideAccess: false,
      where: {
        and: [
          { publicId: { equals: publicId } },
          { status: { equals: 'active' } },
          { startsAt: { less_than_equal: now.toISOString() } },
          { endsAt: { greater_than: now.toISOString() } },
        ],
      },
    })
    const schedule = schedules.docs[0] as unknown as DocumentRecord | undefined
    if (!schedule || !currentSchedule(schedule, now)) return null
    const relations = await resolveRelations(payload, schedule)
    if (!relations || relations.placement.enabled !== true) return null
    return validatedTarget(relations.advertiser, relations.creative) ?? null
  } catch (error) {
    logger.warn({ err: error, msg: 'Controlled advertisement redirect unavailable' })
    return null
  }
}
