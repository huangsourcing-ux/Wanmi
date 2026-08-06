import { normalizeDomain } from '@/lib/domain-name'
import { formatCnyFen } from '@/lib/money'
import { getPublicToolDefinition, type PublicToolSlug, type QueryToolSlug } from '@/lib/site-config'
import type { DnsRecord } from '@/schemas/dns'
import type { DomainSearchItem } from '@/schemas/domain-search'
import type { PricingItem } from '@/schemas/pricing'
import type { CaaInspection, TlsCertificate, TlsInspection } from '@/schemas/tls'

const queryToolSlugs = new Set<QueryToolSlug>(['dns', 'domain-search', 'idn', 'ssl-check', 'whois'])

const availabilityLabels: Record<DomainSearchItem['status'], string> = {
  available: '可注册',
  premium: '溢价域名',
  query_failed: '查询失败',
  registered: '已注册',
  restricted: '保留/限制',
  unsupported: '暂不支持',
}

const pricingLabels: Record<PricingItem['status'], string> = {
  priced: '价格可追溯',
  query_failed: '查询失败',
  stale: '历史快照',
  unconfigured: '未开放',
  unsupported: '暂不支持',
}

function normalizeClipboardDomain(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.$/u, '')
  const wildcard = trimmed.startsWith('*.')
  const candidate = wildcard ? trimmed.slice(2) : trimmed
  const normalized = normalizeDomain(candidate)
  if (!normalized.ok) return undefined
  return wildcard ? `*.${normalized.value.ascii}` : normalized.value.ascii
}

function normalizeUrlHostname(value: string): string | undefined {
  if (value.toLowerCase().startsWith('mailto:')) {
    const match = /^mailto:([^@?]+)@([^?]+)(.*)$/iu.exec(value)
    if (!match) return undefined
    const hostname = normalizeClipboardDomain(match[2] ?? '')
    return hostname ? `mailto:${match[1]}@${hostname}${match[3] ?? ''}` : undefined
  }
  try {
    const url = new URL(value)
    if (!url.hostname) return undefined
    const hostname = normalizeClipboardDomain(url.hostname)
    if (!hostname) return undefined
    url.hostname = hostname
    return url.toString()
  } catch {
    return undefined
  }
}

function domainValue(value: string): string {
  const normalized = normalizeClipboardDomain(value)
  if (normalized) return normalized
  return /[^\u0000-\u007f]/u.test(value) ? '（无法转换为 Punycode）' : value
}

function caaValue(tag: 'iodef' | 'issue' | 'issuewild', value: string): string {
  if (!value) return value
  if (tag === 'iodef') {
    return (
      normalizeUrlHostname(value) ??
      (/[^\u0000-\u007f]/u.test(value) ? '（无法转换为 Punycode）' : value)
    )
  }
  const [issuer, ...parameters] = value.split(';')
  const normalizedIssuer = domainValue(issuer?.trim() ?? '')
  return [normalizedIssuer, ...parameters].join(';')
}

export function normalizeDomainForClipboard(value: string): string {
  const normalized = normalizeClipboardDomain(value)
  if (!normalized) throw new Error('Clipboard domain must be a valid domain name')
  return normalized
}

export function buildToolHref(tool: PublicToolSlug, domain?: string): string {
  const definition = getPublicToolDefinition(tool)
  if (!domain || !queryToolSlugs.has(tool as QueryToolSlug)) return definition.href
  const normalized = normalizeClipboardDomain(domain)
  if (!normalized || !normalized.includes('.')) return definition.href
  return `${definition.href}?q=${encodeURIComponent(normalized)}`
}

export function buildShareUrl({
  domain,
  includeDomain,
  origin,
  tool,
}: {
  domain?: string
  includeDomain: boolean
  origin: string
  tool: PublicToolSlug
}): string {
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error('Share origin must use HTTP or HTTPS')
  }
  const path = buildToolHref(tool, includeDomain ? domain : undefined)
  if (includeDomain && tool !== 'pricing' && !path.includes('?q=')) {
    throw new Error('Domain sharing requires a valid full domain')
  }
  return new URL(path, parsedOrigin.origin).toString()
}

export function formatAvailabilityRecord(item: DomainSearchItem): string {
  const fields = [normalizeDomainForClipboard(item.domainAscii), availabilityLabels[item.status]]
  if (item.status === 'premium') fields.push(formatCnyFen(item.premiumRegistrationPriceFen))
  return fields.join('\t')
}

export function formatWhoisField(label: string, value: string, domain = false): string {
  return `${label}\t${domain ? normalizeDomainForClipboard(value) : value}`
}

export function formatDnsRecord(record: DnsRecord): string {
  const owner = normalizeDomainForClipboard(record.ownerName)
  let value: string
  if (record.type === 'A' || record.type === 'AAAA') value = record.address
  else if (record.type === 'CNAME') value = domainValue(record.target)
  else if (record.type === 'MX') value = `${record.priority} ${domainValue(record.exchange)}`
  else if (record.type === 'TXT') value = JSON.stringify(record.value)
  else if (record.type === 'NS') value = domainValue(record.host)
  else if (record.type === 'SOA') {
    value = [
      domainValue(record.primaryNameServer),
      domainValue(record.responsibleMailbox),
      record.serial,
      record.refresh,
      record.retry,
      record.expire,
      record.minimum,
    ].join(' ')
  } else {
    value = `${record.flags} ${record.tag} ${JSON.stringify(caaValue(record.tag, record.value))}`
  }
  return `${owner} ${record.ttl} IN ${record.type} ${value}`
}

export function formatPricingRecord(item: PricingItem): string {
  const fields = [`.${normalizeClipboardDomain(item.tld) ?? item.tld}`, pricingLabels[item.status]]
  if (item.status === 'priced' || item.status === 'stale') {
    fields.push(
      `注册价 ${formatCnyFen(item.registrationPriceFen)}`,
      `续费价/年 ${formatCnyFen(item.renewalPriceFen)}`,
      `1 年总成本 ${formatCnyFen(item.oneYearTotalFen)}`,
      `3 年总成本 ${formatCnyFen(item.threeYearTotalFen)}`,
      `最低注册 ${item.minimumRegistrationYears} 年`,
    )
  }
  return fields.join('\t')
}

export function formatTlsConnection(tls: TlsInspection): string {
  if (tls.status !== 'connected') return `TLS 连接\t${tls.status}\t端口 ${tls.port}`
  return `TLS 连接\t${tls.protocol}\t${tls.cipherSuite}\t端口 ${tls.port}`
}

export function formatCertificateRecord(certificate: TlsCertificate, index = 0): string {
  const chainCertificate = certificate.chain.certificates[index]
  if (!chainCertificate) throw new Error('Certificate record does not exist')
  const subject = chainCertificate.subject.commonName
    ? domainValue(chainCertificate.subject.commonName)
    : '未提供 CN'
  const issuer = chainCertificate.issuer.commonName
    ? domainValue(chainCertificate.issuer.commonName)
    : '未提供 CN'
  const fields = [`证书 ${index + 1}`, `主题 ${subject}`, `签发者 ${issuer}`]
  if (chainCertificate.validFrom) fields.push(`生效 ${chainCertificate.validFrom}`)
  if (chainCertificate.validTo) fields.push(`到期 ${chainCertificate.validTo}`)
  if (chainCertificate.fingerprint256) fields.push(`SHA-256 ${chainCertificate.fingerprint256}`)
  return fields.join('\t')
}

export function formatSanRecord(value: string): string {
  return `SAN\t${domainValue(value)}`
}

export function formatCaaRecord(record: CaaInspection['records'][number]): string {
  return `${normalizeDomainForClipboard(record.ownerName)} ${record.ttl} IN CAA ${record.flags} ${record.tag} ${JSON.stringify(caaValue(record.tag, record.value))}`
}
