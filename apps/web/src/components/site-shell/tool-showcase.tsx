import Link from 'next/link'
import {
  ArrowUpRightIcon,
  BadgeDollarSignIcon,
  BracesIcon,
  FileSearchIcon,
  NetworkIcon,
  SearchIcon,
  ShieldCheckIcon,
} from 'lucide-react'

import { PRICING_TOOL, TOOL_DEFINITIONS } from '@/lib/site-config'

const toolIcons = {
  dns: NetworkIcon,
  'domain-search': SearchIcon,
  idn: BracesIcon,
  pricing: BadgeDollarSignIcon,
  'ssl-check': ShieldCheckIcon,
  whois: FileSearchIcon,
} as const

const tools = [...TOOL_DEFINITIONS, { ...PRICING_TOOL, slug: 'pricing' as const }]

export function ToolShowcase() {
  return (
    <section
      aria-labelledby="core-tools-title"
      className="mx-auto max-w-[90rem] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24"
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold tracking-[0.16em] text-[#3255c3] uppercase">
            六类核心工具
          </p>
          <h2
            className="mt-3 font-heading text-3xl leading-tight font-semibold tracking-[-0.035em] text-[#031242] sm:text-5xl"
            id="core-tools-title"
          >
            从一个问题，走到下一步
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#31446f]/75">
            每个入口只解决一类问题：可售状态、公开信息、DNS、价格、中文域名或证书。
          </p>
        </div>
        <Link
          className="inline-flex w-fit items-center gap-2 rounded-full border border-[#031242]/14 bg-white px-5 py-2.5 text-sm font-semibold text-[#031242] shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[#3255c3]/60 focus-visible:outline-none"
          href="/tools"
        >
          浏览全部工具
          <ArrowUpRightIcon aria-hidden="true" className="size-4" />
        </Link>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {tools.map((tool, index) => {
          const Icon = toolIcons[tool.slug]
          return (
            <Link
              className="group relative min-h-64 overflow-hidden rounded-3xl border border-[#cddbf1] bg-white p-7 shadow-[0_16px_50px_-36px_rgba(3,18,66,0.45)] transition-[transform,box-shadow,border-color] hover:-translate-y-1 hover:border-[#8bb9ef] hover:shadow-[0_26px_60px_-34px_rgba(3,18,66,0.52)] focus-visible:ring-3 focus-visible:ring-[#3255c3]/45 focus-visible:outline-none"
              href={tool.href}
              key={tool.href}
            >
              <span
                aria-hidden="true"
                className="absolute -top-14 -right-12 size-40 rounded-full bg-[radial-gradient(circle,rgba(99,194,255,0.22),rgba(99,194,255,0))] transition-transform duration-500 group-hover:scale-125"
              />
              <span className="relative flex h-full flex-col">
                <span className="flex items-start justify-between gap-4">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-[#ebf3ff] text-[#1746a2]">
                    <Icon aria-hidden="true" className="size-6" />
                  </span>
                  <span className="font-mono text-xs tracking-[0.16em] text-[#31446f]/35">
                    0{index + 1}
                  </span>
                </span>
                <span className="mt-7 font-heading text-xl font-semibold text-[#031242]">
                  {tool.title}
                </span>
                <span className="mt-3 text-sm leading-6 text-[#31446f]/70">{tool.description}</span>
                <span className="mt-auto inline-flex items-center gap-2 pt-6 text-sm font-semibold text-[#0072bc]">
                  打开入口
                  <ArrowUpRightIcon
                    aria-hidden="true"
                    className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  />
                </span>
              </span>
            </Link>
          )
        })}
      </div>
    </section>
  )
}
