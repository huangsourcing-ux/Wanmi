import Image from 'next/image'
import Link from 'next/link'
import { ArrowDownIcon, CheckCircle2Icon } from 'lucide-react'

import { DomainQueryForm } from '@/components/forms/domain-query-form'

const quickLinks = [
  { href: '/tools/whois', label: 'WHOIS / RDAP' },
  { href: '/tools/dns', label: 'DNS / NS' },
  { href: '/tools/ssl-check', label: 'SSL / CAA' },
  { href: '/tools/idn', label: 'IDN 转换' },
] as const

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden rounded-b-[2rem] bg-[#031242] text-white sm:rounded-b-[2.5rem]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(29,78,216,0.52),transparent_32%),radial-gradient(circle_at_82%_28%,rgba(240,152,255,0.18),transparent_26%)]"
      />
      <div
        aria-hidden="true"
        className="absolute top-16 left-1/2 h-[20rem] w-[46rem] max-w-[120vw] -translate-x-1/2 opacity-35 sm:top-8 sm:h-[28rem] sm:w-[70rem]"
      >
        <Image
          alt=""
          className="h-full w-full object-contain"
          height={644}
          preload
          sizes="(max-width: 640px) 120vw, 1120px"
          src="/site-shell/query-glow.webp"
          width={1476}
        />
      </div>

      <div className="relative mx-auto flex max-w-[90rem] flex-col items-center px-4 pt-16 pb-14 text-center sm:px-6 sm:pt-20 sm:pb-20 lg:px-8 lg:pt-24">
        <div className="inline-flex items-center rounded-full border border-white/16 bg-white/8 px-4 py-2 text-sm font-medium text-[#a8dcff] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
          中文域名工具与服务入口
        </div>

        <h1 className="mt-7 max-w-4xl font-heading text-4xl leading-[1.12] font-semibold tracking-[-0.045em] text-balance sm:text-5xl lg:text-7xl">
          先查清，再决定。
          <span className="block bg-[linear-gradient(90deg,#63c2ff_0%,#f098ff_52%,#fff75f_100%)] bg-clip-text text-transparent">
            让域名选择更简单。
          </span>
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-7 text-white/68 sm:text-lg sm:leading-8">
          从可售状态、公开注册信息到 DNS、证书和价格，用一组清晰的中文工具核验关键事实。
        </p>

        <div className="mt-9 w-full max-w-4xl rounded-[1.6rem] border border-white/18 bg-white/10 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_28px_80px_-36px_rgba(99,194,255,0.75)] backdrop-blur-md sm:p-4">
          <DomainQueryForm />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-3 text-sm text-white/55">
          <span className="inline-flex items-center gap-2 text-white/70">
            <CheckCircle2Icon aria-hidden="true" className="size-4 text-[#63c2ff]" />
            未确认的状态不会被展示为可注册
          </span>
          {quickLinks.map((link) => (
            <Link
              className="rounded-sm transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
              href={link.href}
              key={link.href}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <Link
          aria-label="浏览首页更多内容"
          className="mt-12 inline-flex size-10 items-center justify-center rounded-full border border-white/18 text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
          href="#core-tools-title"
        >
          <ArrowDownIcon aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </section>
  )
}
