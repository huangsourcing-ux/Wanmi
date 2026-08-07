import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'

import type { PayloadRequest } from 'payload'

import {
  AD_MAINTENANCE_CONTEXT,
  normalizeAdTarget,
  type AdTargetCheckFailure,
  type AdTargetCheckStatus,
} from '@/lib/advertising'
import { isPublicDnsAddress } from '@/services/dns/query-dns-records'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type DocumentRecord = Record<string, unknown>
type ResolvedAddress = { address: string; family: 4 | 6 }

export type AdTargetProbeResult = {
  failure: AdTargetCheckFailure
  status: AdTargetCheckStatus
}

export type AdTargetProbe = (targetUrl: string) => Promise<AdTargetProbeResult>

export const AD_TARGET_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
export const AD_TARGET_PROBE_TIMEOUT_MS = 3_000
const AD_TARGET_MAX_RESOLVED_ADDRESSES = 16
const AD_TARGET_CHECK_BATCH_SIZE = 50
const AD_TARGET_CHECK_CONCURRENCY = 4

function record(value: unknown): DocumentRecord {
  return typeof value === 'object' && value !== null ? (value as DocumentRecord) : {}
}

function relationshipId(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value
  const id = record(value).id
  return typeof id === 'number' || typeof id === 'string' ? id : undefined
}

function allowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    const host = record(row).host
    return typeof host === 'string' ? [host] : []
  })
}

async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  )
}

function requestPinnedStatus(
  target: URL,
  address: ResolvedAddress,
  method: 'GET' | 'HEAD',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      target,
      {
        headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        maxHeaderSize: 16_384,
        method,
        timeout: AD_TARGET_PROBE_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0
        response.destroy()
        resolve(status)
      },
    )
    request.once('timeout', () => request.destroy(new Error('target probe timed out')))
    request.once('error', reject)
    request.end()
  })
}

export async function probeExternalAdTarget(
  targetUrl: string,
  dependencies: {
    requestStatus?: typeof requestPinnedStatus
    resolveAddresses?: typeof resolvePublicAddresses
  } = {},
): Promise<AdTargetProbeResult> {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return { failure: 'not_allowlisted', status: 'unsafe' }
  }
  if (target.protocol !== 'https:' || target.port || target.username || target.password) {
    return { failure: 'not_allowlisted', status: 'unsafe' }
  }

  let addresses: ResolvedAddress[]
  try {
    addresses = await (dependencies.resolveAddresses ?? resolvePublicAddresses)(target.hostname)
  } catch {
    return { failure: 'unreachable', status: 'unreachable' }
  }
  if (
    addresses.length === 0 ||
    addresses.length > AD_TARGET_MAX_RESOLVED_ADDRESSES ||
    addresses.some(({ address }) => !isPublicDnsAddress(address))
  ) {
    return { failure: 'restricted_address', status: 'unsafe' }
  }

  const requestStatus = dependencies.requestStatus ?? requestPinnedStatus
  try {
    let statusCode = await requestStatus(target, addresses[0]!, 'HEAD')
    if (statusCode === 405 || statusCode === 501) {
      statusCode = await requestStatus(target, addresses[0]!, 'GET')
    }
    return statusCode >= 200 && statusCode < 400
      ? { failure: 'none', status: 'reachable' }
      : { failure: 'http_error', status: 'unreachable' }
  } catch {
    return { failure: 'unreachable', status: 'unreachable' }
  }
}

async function expireSchedule(req: PayloadRequest, schedule: DocumentRecord, now: Date) {
  const id = relationshipId(schedule.id)
  if (id === undefined || typeof schedule.updatedAt !== 'string') return false
  try {
    await req.payload.update({
      collection: 'adSchedules',
      context: {
        [AD_MAINTENANCE_CONTEXT]: {
          expectedUpdatedAt: schedule.updatedAt,
          kind: 'expire',
          now: now.toISOString(),
        },
      },
      data: { status: 'ended' },
      id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'advertising.maintenance',
      actor: { type: 'system' },
      metadata: { operation: 'schedule_expired', statusAfter: 'ended' },
      targetId: id,
    })
    return true
  } catch (error) {
    const failure = record(error)
    req.payload.logger?.warn(
      {
        code: typeof failure.code === 'string' ? failure.code : undefined,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        operation: 'schedule_expiry',
        targetId: String(id),
      },
      'advertising maintenance update skipped',
    )
    return false
  }
}

async function checkCreative(
  req: PayloadRequest,
  creative: DocumentRecord,
  now: Date,
  probe: AdTargetProbe,
) {
  const id = relationshipId(creative.id)
  const advertiserId = relationshipId(creative.advertiser)
  if (id === undefined || advertiserId === undefined || typeof creative.updatedAt !== 'string') {
    return false
  }

  let result: AdTargetProbeResult
  try {
    const advertiser = await req.payload.findByID({
      collection: 'advertisers',
      depth: 0,
      id: advertiserId,
      overrideAccess: true,
      req,
    })
    const targetType = creative.targetType
    if (targetType !== 'external' && targetType !== 'internal')
      throw new Error('invalid target type')
    const targetUrl = normalizeAdTarget({
      allowedHosts: allowedHosts(advertiser.allowedHosts),
      targetType,
      targetUrl: creative.targetUrl,
    })
    result =
      targetType === 'external' ? await probe(targetUrl) : { failure: 'none', status: 'reachable' }
  } catch {
    result = { failure: 'not_allowlisted', status: 'unsafe' }
  }

  const changed =
    creative.targetCheckStatus !== result.status || creative.targetCheckFailure !== result.failure
  try {
    await req.payload.update({
      collection: 'adCreatives',
      context: {
        [AD_MAINTENANCE_CONTEXT]: {
          expectedUpdatedAt: creative.updatedAt,
          kind: 'target-check',
          targetCheckFailure: result.failure,
          targetCheckedAt: now.toISOString(),
          targetCheckStatus: result.status,
        },
      },
      data: {
        targetCheckFailure: result.failure,
        targetCheckedAt: now.toISOString(),
        targetCheckStatus: result.status,
      },
      id,
      overrideAccess: true,
      req,
    })
    if (changed) {
      await recordAuditEvent(req, {
        action: 'advertising.maintenance',
        actor: { type: 'system' },
        metadata: {
          failure: result.failure,
          operation: 'target_check',
          statusAfter: result.status,
        },
        targetId: id,
      })
    }
    return true
  } catch (error) {
    const failure = record(error)
    req.payload.logger?.warn(
      {
        code: typeof failure.code === 'string' ? failure.code : undefined,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        operation: 'target_check',
        targetId: String(id),
      },
      'advertising maintenance update skipped',
    )
    return false
  }
}

export async function runAdvertisingMaintenance(
  req: PayloadRequest,
  options: { now?: Date; probe?: AdTargetProbe } = {},
) {
  const now = options.now ?? new Date()
  const expired = await req.payload.find({
    collection: 'adSchedules',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'endsAt',
    where: {
      and: [
        { endsAt: { less_than_equal: now.toISOString() } },
        { or: [{ status: { equals: 'active' } }, { status: { equals: 'scheduled' } }] },
      ],
    },
  })
  const expirationResults = await Promise.all(
    (expired.docs as unknown as DocumentRecord[]).map((schedule) =>
      expireSchedule(req, schedule, now),
    ),
  )

  const cutoff = new Date(now.getTime() - AD_TARGET_RECHECK_INTERVAL_MS).toISOString()
  const creatives = await req.payload.find({
    collection: 'adCreatives',
    depth: 0,
    limit: AD_TARGET_CHECK_BATCH_SIZE,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'targetCheckedAt',
    where: {
      and: [
        { status: { equals: 'approved' } },
        {
          or: [
            { targetCheckStatus: { equals: 'pending' } },
            { targetCheckedAt: { exists: false } },
            { targetCheckedAt: { less_than_equal: cutoff } },
          ],
        },
      ],
    },
  })
  const documents = creatives.docs as unknown as DocumentRecord[]
  let checked = 0
  for (let offset = 0; offset < documents.length; offset += AD_TARGET_CHECK_CONCURRENCY) {
    const results = await Promise.all(
      documents
        .slice(offset, offset + AD_TARGET_CHECK_CONCURRENCY)
        .map((creative) =>
          checkCreative(req, creative, now, options.probe ?? probeExternalAdTarget),
        ),
    )
    checked += results.filter(Boolean).length
  }
  return {
    checked,
    expired: expirationResults.filter(Boolean).length,
  }
}
