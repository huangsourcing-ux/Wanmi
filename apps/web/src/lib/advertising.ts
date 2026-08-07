import { isIP } from 'node:net'

import { AppError } from '@/lib/errors'
import { normalizeRedirectPath } from '@/lib/redirects'

export const ADVERTISER_STATUSES = ['draft', 'active', 'paused', 'disabled'] as const
export const AD_CREATIVE_STATUSES = [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'disabled',
] as const
export const AD_SCHEDULE_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'ended',
  'disabled',
] as const
export const AD_PAGE_TYPES = ['home', 'tool', 'content', 'tld'] as const
export const AD_DEVICE_SCOPES = ['all', 'desktop', 'mobile'] as const
export const AD_PLACEMENT_POSITIONS = [
  'after_core_result',
  'content_inline',
  'tld_inline',
  'home_native',
] as const

export const PUBLIC_AD_INTERNAL_CONTEXT = 'wanmiPublicAdvertisingInternal'

export type AdTargetType = 'external' | 'internal'
export type AdDeviceScope = (typeof AD_DEVICE_SCOPES)[number]
export type AdPageType = (typeof AD_PAGE_TYPES)[number]

const HOST_LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u
const PLACEMENT_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PUBLIC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const RAW_WHITESPACE_OR_CONTROL_PATTERN = /[\u0000-\u0020\u007f]/u
const DYNAMIC_TARGET_TOKEN_PATTERN = /%7b|%7d|\{|\}|\$\{/iu

function invalidTarget(message: string): never {
  throw new AppError('AD_TARGET_INVALID', message, 400)
}

export function normalizeAllowedAdHost(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new AppError('AD_ALLOWED_HOST_INVALID', '广告目标主机不能为空或包含首尾空白', 400)
  }
  if (
    value.length > 253 ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('@') ||
    value.endsWith('.') ||
    RAW_WHITESPACE_OR_CONTROL_PATTERN.test(value)
  ) {
    throw new AppError(
      'AD_ALLOWED_HOST_INVALID',
      '广告目标主机只能填写不含协议、端口或路径的域名',
      400,
    )
  }

  let hostname: string
  try {
    hostname = new URL(`https://${value}`).hostname.toLowerCase()
  } catch {
    throw new AppError('AD_ALLOWED_HOST_INVALID', '广告目标主机格式无效', 400)
  }
  if (
    isIP(hostname) !== 0 ||
    !hostname.includes('.') ||
    hostname.split('.').some((label) => !HOST_LABEL_PATTERN.test(label))
  ) {
    throw new AppError('AD_ALLOWED_HOST_INVALID', '广告目标主机必须是明确的公网域名', 400)
  }
  return hostname
}

function normalizeExternalAdTarget(value: unknown, allowedHosts: readonly string[]): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 2_048 ||
    value.includes('\\') ||
    RAW_WHITESPACE_OR_CONTROL_PATTERN.test(value)
  ) {
    invalidTarget('外部广告目标必须是不含空白或反斜杠的 HTTPS URL')
  }

  let target: URL
  try {
    target = new URL(value)
  } catch {
    invalidTarget('外部广告目标 URL 格式无效')
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.port ||
    target.hash ||
    isIP(target.hostname) !== 0 ||
    target.hostname.endsWith('.')
  ) {
    invalidTarget('外部广告目标仅允许无凭据、无自定义端口和锚点的 HTTPS 域名 URL')
  }
  if (DYNAMIC_TARGET_TOKEN_PATTERN.test(target.href)) {
    invalidTarget('广告目标不得包含查询域名或其他动态替换占位符')
  }

  const normalizedHosts = new Set(allowedHosts.map(normalizeAllowedAdHost))
  if (!normalizedHosts.has(target.hostname.toLowerCase())) {
    invalidTarget('外部广告目标主机不在该广告主的允许列表中')
  }
  return target.toString()
}

export function normalizeAdTarget(input: {
  allowedHosts?: readonly string[]
  targetType: AdTargetType
  targetUrl: unknown
}): string {
  if (input.targetType === 'external') {
    return normalizeExternalAdTarget(input.targetUrl, input.allowedHosts ?? [])
  }
  try {
    const normalized = normalizeRedirectPath(input.targetUrl)
    if (normalized === '/go' || normalized.startsWith('/go/')) {
      invalidTarget('站内广告目标不能指向受控跳转入口')
    }
    return normalized
  } catch (error) {
    if (error instanceof AppError) throw error
    invalidTarget('站内广告目标必须是 D1-04 标准允许的无查询参数路径')
  }
}

export function validateAdTargetSyntax(value: unknown, targetType: unknown): true | string {
  if (targetType !== 'external' && targetType !== 'internal') {
    return '必须先选择站内或外部目标类型'
  }
  try {
    if (targetType === 'external') {
      const target = new URL(typeof value === 'string' ? value : '')
      normalizeAdTarget({ allowedHosts: [target.hostname], targetType, targetUrl: value })
    } else {
      normalizeAdTarget({ targetType, targetUrl: value })
    }
    return true
  } catch {
    return targetType === 'external'
      ? '仅允许广告主白名单主机上的安全 HTTPS URL'
      : '仅允许 D1-04 标准的站内路径；不接受 //、反斜杠、查询参数或保留入口'
  }
}

export function normalizeAdPlacementCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError('AD_PLACEMENT_CODE_INVALID', '广告位代码格式无效', 400)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized.length < 3 || normalized.length > 80 || !PLACEMENT_CODE_PATTERN.test(normalized)) {
    throw new AppError(
      'AD_PLACEMENT_CODE_INVALID',
      '广告位代码只能使用 3～80 位小写字母、数字和单个连字符',
      400,
    )
  }
  return normalized
}

export function isAdPublicId(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_ID_PATTERN.test(value)
}

export function publicAdClickPath(publicId: string): string {
  if (!isAdPublicId(publicId)) throw new AppError('AD_PUBLIC_ID_INVALID', '广告跳转标识无效', 400)
  return `/go/ad/${publicId.toLowerCase()}`
}
