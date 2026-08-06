export type SiteNavigationItem = {
  href: string
  id: string
  label: string
}

export type QueryToolSlug = 'dns' | 'domain-search' | 'idn' | 'ssl-check' | 'whois'
export type PublicToolSlug = QueryToolSlug | 'pricing'

export type ToolDefinition = {
  description: string
  href: string
  slug: QueryToolSlug
  title: string
}

export type PublicToolDefinition = {
  description: string
  href: string
  slug: PublicToolSlug
  title: string
}

export const DEFAULT_NAVIGATION: SiteNavigationItem[] = [
  { href: '/tools/domain-search', id: 'domain-search', label: '域名查询' },
  { href: '/tools', id: 'tools', label: '工具中心' },
  { href: '/pricing', id: 'pricing', label: '价格中心' },
  { href: '/articles', id: 'articles', label: '实用内容' },
  { href: '/help', id: 'help', label: '帮助' },
]

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    description: '输入完整域名或关键词，进入可注册与多后缀查询。',
    href: '/tools/domain-search',
    slug: 'domain-search',
    title: '域名可注册查询',
  },
  {
    description: '查询公开注册信息，并明确区分注册信息与可购买状态。',
    href: '/tools/whois',
    slug: 'whois',
    title: 'WHOIS / RDAP',
  },
  {
    description: '查看常用 DNS 记录、Name Server 与可理解的错误说明。',
    href: '/tools/dns',
    slug: 'dns',
    title: 'DNS / NS 查询',
  },
  {
    description: '检查公开网站的 TLS 证书、有效期、域名匹配与 CAA。',
    href: '/tools/ssl-check',
    slug: 'ssl-check',
    title: 'SSL / CAA 检查',
  },
  {
    description: '在 Unicode 中文域名与 ASCII Punycode 之间安全转换。',
    href: '/tools/idn',
    slug: 'idn',
    title: 'IDN / Punycode',
  },
]

export const PRICING_TOOL = {
  description: '比较 TLD 注册、续费、最低年限和 1 年 / 3 年成本。',
  href: '/pricing',
  slug: 'pricing',
  title: 'TLD 价格与成本',
} as const

export const PUBLIC_TOOL_DEFINITIONS: PublicToolDefinition[] = [...TOOL_DEFINITIONS, PRICING_TOOL]

export function getToolDefinition(slug: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.slug === slug)
}

export function getPublicToolDefinition(slug: PublicToolSlug): PublicToolDefinition {
  const tool = PUBLIC_TOOL_DEFINITIONS.find((candidate) => candidate.slug === slug)
  if (!tool) throw new Error(`Unknown public tool: ${slug}`)
  return tool
}

export function normalizeQueryParam(value: string | string[] | undefined, maxLength = 253): string {
  const query = Array.isArray(value) ? value[0] : value
  return query?.trim().slice(0, maxLength) ?? ''
}
