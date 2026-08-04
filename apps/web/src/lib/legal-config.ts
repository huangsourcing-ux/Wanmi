export type LegalDocument = {
  description: string
  points: string[]
  slug: 'advertising' | 'cookies' | 'privacy' | 'terms'
  title: string
}

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    description: '说明 Wanmi 计划如何最小化处理查询、账号和实名信息。',
    points: [
      '域名工具查询不会因广告展示而向广告主传递完整查询内容。',
      '实名证件将使用独立私有存储、短时访问和全程审计。',
      '正式隐私政策将在真实服务开放前完成专业复核并公布生效日期。',
    ],
    slug: 'privacy',
    title: '隐私说明',
  },
  {
    description: '说明工具、数据和代理注册服务的预定使用边界。',
    points: [
      '查询结果会标明数据来源、时间和可能存在的延迟或缺失。',
      '查询失败、未知状态或缓存结果不会被包装成可注册结论。',
      '正式服务条款将在注册、支付和履约开放前完成专业复核。',
    ],
    slug: 'terms',
    title: '使用条款',
  },
  {
    description: '说明站点计划使用的必要 Cookie 和会话边界。',
    points: [
      '必要 Cookie 将用于安全登录、会话维持和防止请求伪造。',
      '分析能力遵循最小化原则，不默认保存完整查询域名。',
      '非必要 Cookie 的用途和选择机制将在启用前单独说明。',
    ],
    slug: 'cookies',
    title: 'Cookie 说明',
  },
  {
    description: '说明 Wanmi 的广告标识、位置和数据隔离原则。',
    points: [
      'P1 不接入第三方程序化广告脚本，赞助和推广内容必须明确标识。',
      '广告位位于主查询或核心结果之后，加载失败不得影响工具使用。',
      '广告主不会获得用户输入的完整查询域名。',
    ],
    slug: 'advertising',
    title: '广告说明',
  },
]

export function getLegalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((document) => document.slug === slug)
}
