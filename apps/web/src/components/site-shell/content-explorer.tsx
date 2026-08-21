import Link from 'next/link'
import { ArrowUpRightIcon } from 'lucide-react'

import type { PublicContentSection } from '@/lib/public-site-data'

const fallbackCopy: Record<PublicContentSection['href'], string> = {
  '/articles': '内容将围绕域名选择、注册规则、DNS、WHOIS、SSL 与建站逐步发布。',
  '/help': '帮助文章会说明数据来源、查询限制和使用边界。',
  '/pricing': '已配置规则的后缀会展示可追溯的价格信息。',
  '/topics': '专题会把工具、TLD 页面和实用指南串联成清晰路径。',
}

function ContentColumn({ section }: { section: PublicContentSection }) {
  const statusLabel =
    section.status === 'ready' ? '已发布' : section.status === 'empty' ? '持续更新' : '暂时不可用'

  return (
    <article className="flex min-h-[25rem] flex-col rounded-3xl border border-[#cddbf1] bg-white p-6 shadow-[0_18px_58px_-42px_rgba(3,18,66,0.45)] sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <h3 className="font-heading text-xl font-semibold text-[#031242]">{section.title}</h3>
        <span className="shrink-0 rounded-full bg-[#ebf3ff] px-3 py-1 text-xs font-medium text-[#3255c3]">
          {statusLabel}
        </span>
      </div>

      {section.status === 'ready' ? (
        <ul className="mt-6 space-y-1">
          {section.items.map((item) => (
            <li className="border-b border-[#d4dcec] py-4 first:pt-0 last:border-0" key={item.id}>
              <Link
                className="group block rounded-lg focus-visible:ring-2 focus-visible:ring-[#3255c3]/60 focus-visible:outline-none"
                href={item.href}
              >
                <span className="font-medium leading-6 text-[#031242] transition-colors group-hover:text-[#0072bc]">
                  {item.title}
                </span>
                {item.summary ? (
                  <span className="mt-1 line-clamp-2 block text-sm leading-6 text-[#31446f]/65">
                    {item.summary}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-6 rounded-2xl bg-[#eef2ff] p-5 text-sm leading-7 text-[#31446f]/70">
          <p>{fallbackCopy[section.href]}</p>
          {section.status === 'unavailable' ? (
            <p className="mt-2 font-medium text-[#31446f]">
              最新条目暂时无法加载，域名查询入口仍可正常使用。
            </p>
          ) : null}
        </div>
      )}

      <Link
        className="mt-auto inline-flex items-center gap-2 self-start rounded-sm pt-6 text-sm font-semibold text-[#0072bc] focus-visible:ring-2 focus-visible:ring-[#3255c3]/60 focus-visible:outline-none"
        href={section.href}
      >
        进入{section.title}
        <ArrowUpRightIcon aria-hidden="true" className="size-4" />
      </Link>
    </article>
  )
}

export function ContentExplorer({
  sections,
}: {
  sections: [PublicContentSection, PublicContentSection, PublicContentSection]
}) {
  return (
    <section className="bg-[#ebf3ff] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
      <div className="mx-auto max-w-[90rem]">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold tracking-[0.16em] text-[#3255c3] uppercase">
            内容入口
          </p>
          <h2 className="mt-3 font-heading text-3xl leading-tight font-semibold tracking-[-0.035em] text-[#031242] sm:text-5xl">
            把查询结果变成可执行的判断
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#31446f]/75">
            首页只读取已发布内容。草稿、空库或单个栏目失败都不会影响主查询。
          </p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {sections.map((section) => (
            <ContentColumn key={section.href} section={section} />
          ))}
        </div>
      </div>
    </section>
  )
}
