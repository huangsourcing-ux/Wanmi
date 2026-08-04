import type { Field } from 'payload'

import { absoluteSiteUrl, contentPath, validateSameOriginCanonical } from '@/lib/seo'

export function appendSeoFields({ defaultFields }: { defaultFields: Field[] }): Field[] {
  return [
    ...defaultFields,
    {
      name: 'canonical',
      type: 'text',
      admin: {
        description: '留空时按内容类型与 slug 自动生成；只允许 Wanmi 主域内的路径或完整 URL。',
      },
      maxLength: 2048,
      validate: validateSameOriginCanonical,
    },
    {
      name: 'noIndex',
      type: 'checkbox',
      admin: { description: '启用后，已发布页面也不会进入搜索引擎索引或 sitemap。' },
      defaultValue: false,
    },
  ]
}

export function generateSeoPreviewUrl(collection: unknown, slug: unknown): string {
  if (collection !== 'articles' && collection !== 'topics' && collection !== 'tldPages') {
    return absoluteSiteUrl('/')
  }
  return absoluteSiteUrl(contentPath(collection, slug))
}
