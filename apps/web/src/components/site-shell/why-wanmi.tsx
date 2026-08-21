import Image from 'next/image'
import Link from 'next/link'
import { ArrowUpRightIcon, BookOpenTextIcon, CircleAlertIcon } from 'lucide-react'

export function WhyWanmi() {
  return (
    <section className="relative overflow-hidden bg-[#eef2ff] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
      <div
        aria-hidden="true"
        className="absolute top-24 right-[8%] size-20 rotate-12 rounded-[1.7rem] border border-white/75 bg-white/35 shadow-[0_28px_70px_-35px_rgba(50,85,195,0.65)]"
      />
      <div className="relative mx-auto max-w-[90rem]">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold tracking-[0.16em] text-[#3255c3] uppercase">
            为什么选择 Wanmi
          </p>
          <h2 className="mt-3 font-heading text-3xl leading-tight font-semibold tracking-[-0.035em] text-[#031242] sm:text-5xl">
            先建立可信边界，再提供下一步
          </h2>
          <p className="mt-5 text-base leading-7 text-[#31446f]/75">
            不用模糊结论掩盖不确定性。页面会把来源、时间、缓存和失败状态放在结果旁边。
          </p>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          <article className="flex min-h-[34rem] flex-col overflow-hidden rounded-[2rem] bg-white p-7 shadow-[0_22px_70px_-44px_rgba(3,18,66,0.5)] sm:p-9">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-[#3255c3] uppercase">
                确定性优先
              </p>
              <h3 className="mt-3 font-heading text-2xl font-semibold text-[#031242]">
                未知，就明确展示为未知
              </h3>
              <p className="mt-3 max-w-xl text-sm leading-7 text-[#31446f]/72">
                没有明确上游确认时，不把失败、超时或模糊响应推断成“可注册”。
              </p>
              <Link
                className="mt-5 inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-[#0072bc] focus-visible:ring-2 focus-visible:ring-[#3255c3]/60 focus-visible:outline-none"
                href="/help"
              >
                查看数据边界
                <ArrowUpRightIcon aria-hidden="true" className="size-4" />
              </Link>
            </div>
            <div className="mt-auto overflow-hidden rounded-2xl bg-[#e7f4ff]">
              <Image
                alt="域名服务安全与身份边界示意图"
                className="h-auto w-full"
                height={420}
                loading="lazy"
                sizes="(max-width: 1024px) calc(100vw - 5rem), 42rem"
                src="/site-shell/security-boundary.webp"
                width={638}
              />
            </div>
          </article>

          <article className="flex min-h-[34rem] flex-col overflow-hidden rounded-[2rem] bg-white p-7 shadow-[0_22px_70px_-44px_rgba(3,18,66,0.5)] sm:p-9">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-[#3255c3] uppercase">
                可追溯结果
              </p>
              <h3 className="mt-3 font-heading text-2xl font-semibold text-[#031242]">
                来源、时间和缓存状态并列
              </h3>
              <p className="mt-3 max-w-xl text-sm leading-7 text-[#31446f]/72">
                查询结果会说明数据来自哪里、何时观察，以及是否使用短时缓存。
              </p>
              <Link
                className="mt-5 inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-[#0072bc] focus-visible:ring-2 focus-visible:ring-[#3255c3]/60 focus-visible:outline-none"
                href="/tools/domain-search"
              >
                查看查询入口
                <ArrowUpRightIcon aria-hidden="true" className="size-4" />
              </Link>
            </div>
            <div className="mt-auto overflow-hidden rounded-2xl bg-[#e7f4ff]">
              <Image
                alt="查询来源与状态面板示意图"
                className="h-auto w-full"
                height={420}
                loading="lazy"
                sizes="(max-width: 1024px) calc(100vw - 5rem), 42rem"
                src="/site-shell/source-dashboard.webp"
                width={855}
              />
            </div>
          </article>

          <article className="grid overflow-hidden rounded-[2rem] bg-[#031242] p-7 text-white shadow-[0_22px_70px_-44px_rgba(3,18,66,0.7)] sm:p-9 lg:col-span-2 lg:grid-cols-[1fr_1.15fr] lg:items-center lg:gap-16">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-[#63c2ff] uppercase">
                服务边界
              </p>
              <h3 className="mt-3 font-heading text-2xl font-semibold">
                查询、内容与真实交易清楚分开
              </h3>
              <p className="mt-3 text-sm leading-7 text-white/62">
                当前页面不会把公开信息、DNS 结果或前端跳转当成注册、支付和履约已经完成。
              </p>
            </div>
            <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:mt-0">
              {[
                {
                  description: '公开数据可能受隐私政策、缓存与网络视角影响。',
                  icon: BookOpenTextIcon,
                  title: '查询有来源',
                },
                {
                  description: '真实能力只按页面明确状态开放，不用营销文案代替确认。',
                  icon: CircleAlertIcon,
                  title: '交易有门槛',
                },
              ].map((item) => {
                const Icon = item.icon
                return (
                  <div
                    className="rounded-2xl border border-white/12 bg-white/7 p-5"
                    key={item.title}
                  >
                    <Icon aria-hidden="true" className="size-5 text-[#63c2ff]" />
                    <h4 className="mt-4 font-semibold">{item.title}</h4>
                    <p className="mt-2 text-sm leading-6 text-white/55">{item.description}</p>
                  </div>
                )
              })}
            </div>
          </article>
        </div>
      </div>
    </section>
  )
}
