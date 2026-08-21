export type SiteShellLink = {
  description?: string
  href: string
  label: string
}

export type SiteShellMenuGroup = {
  label: string
  links: SiteShellLink[]
}

export type SiteShellMenuPanel = {
  description: string
  groups: SiteShellMenuGroup[]
  id: string
  label: string
}

export const SITE_SHELL_ANNOUNCEMENT =
  '公开查询与工具入口已开放，真实注册、支付和履约仍以页面状态为准。'

export const SITE_SHELL_MENU_PANELS: SiteShellMenuPanel[] = [
  {
    description: '从可售状态、公开注册信息到价格，先把域名事实查清楚。',
    groups: [
      {
        label: '查询域名',
        links: [
          {
            description: '查询完整域名或关键词的可售状态',
            href: '/tools/domain-search',
            label: '域名可注册查询',
          },
          {
            description: '核验公开注册信息与注册商数据',
            href: '/tools/whois',
            label: 'WHOIS / RDAP',
          },
        ],
      },
      {
        label: '价格与资产',
        links: [
          {
            description: '比较已配置后缀的注册与续费成本',
            href: '/pricing',
            label: 'TLD 价格与成本',
          },
          {
            description: '查看当前账号名下的域名资产',
            href: '/account/domains',
            label: '我的域名',
          },
        ],
      },
    ],
    id: 'domains',
    label: '域名服务',
  },
  {
    description: '六类核心工具各自回答一个问题，并明确展示数据来源与边界。',
    groups: [
      {
        label: '查询与核验',
        links: [
          { href: '/tools/domain-search', label: '可注册查询' },
          { href: '/tools/whois', label: 'WHOIS / RDAP' },
          { href: '/tools/dns', label: 'DNS / NS 查询' },
        ],
      },
      {
        label: '转换与检查',
        links: [
          { href: '/tools/ssl-check', label: 'SSL / CAA 检查' },
          { href: '/tools/idn', label: 'IDN / Punycode' },
          { href: '/tools', label: '工具中心' },
        ],
      },
    ],
    id: 'tools',
    label: '工具',
  },
  {
    description: '从查询结果继续阅读后缀规则、专题指南和数据说明。',
    groups: [
      {
        label: '内容',
        links: [
          { href: '/articles', label: '实用内容' },
          { href: '/topics', label: '专题与指南' },
          { href: '/pricing', label: 'TLD 页面' },
        ],
      },
      {
        label: '支持',
        links: [
          { href: '/help', label: '帮助与数据来源' },
          { href: '/contact', label: '联系我们' },
          { href: '/feedback', label: '提交反馈' },
        ],
      },
    ],
    id: 'resources',
    label: '内容与帮助',
  },
]

export const SITE_SHELL_FOOTER_GROUPS = [
  {
    links: [
      { href: '/tools/domain-search', label: '域名可注册查询' },
      { href: '/pricing', label: 'TLD 价格与成本' },
      { href: '/account/domains', label: '我的域名' },
    ],
    title: '域名服务',
  },
  {
    links: [
      { href: '/tools', label: '工具中心' },
      { href: '/articles', label: '实用内容' },
      { href: '/topics', label: '专题与指南' },
      { href: '/help', label: '帮助与数据来源' },
    ],
    title: '探索',
  },
  {
    links: [
      { href: '/legal/privacy', label: '隐私说明' },
      { href: '/legal/realname', label: '实名说明' },
      { href: '/legal/payment', label: '支付说明' },
      { href: '/legal/terms', label: '使用条款' },
      { href: '/legal/cookies', label: 'Cookie 说明' },
      { href: '/legal/advertising', label: '广告说明' },
    ],
    title: '合规',
  },
  {
    links: [
      { href: '/contact', label: '联系我们' },
      { href: '/feedback', label: '提交反馈' },
      { href: '/requests', label: '提交需求' },
    ],
    title: '联系',
  },
] as const
