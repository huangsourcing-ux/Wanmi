import Link from 'next/link'
import { ArrowUpRightIcon } from 'lucide-react'

import { RegistrarDisclosure } from '@/components/compliance/registrar-disclosure'
import { BrandMark } from '@/components/site-shell/brand-mark'
import { SITE_SHELL_FOOTER_GROUPS } from '@/components/site-shell/site-shell-data'
import { ICP_REGISTRATION_URL, type PublicComplianceConfig } from '@/lib/public-compliance'

export function SiteFooter({ compliance }: { compliance: PublicComplianceConfig }) {
  return (
    <footer className="mt-auto overflow-hidden bg-[#031242] text-white">
      <div className="mx-auto max-w-[90rem] px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(17rem,1.2fr)_2fr] lg:gap-16">
          <div className="max-w-md">
            <Link
              aria-label="Wanmi.net 首页"
              className="inline-flex rounded-xl text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
              href="/"
            >
              <BrandMark />
            </Link>
            <p className="mt-5 text-sm leading-7 text-white/62">
              面向中文用户的域名工具、实用内容与代理注册平台。查询结果会标明数据来源、时间与服务边界。
            </p>
            <Link
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#031242] transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#031242] focus-visible:outline-none"
              href="/tools/domain-search"
            >
              开始查询域名
              <ArrowUpRightIcon aria-hidden="true" className="size-4" />
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4">
            {SITE_SHELL_FOOTER_GROUPS.map((group) => (
              <div className="border-l border-white/12 pl-5" key={group.title}>
                <h2 className="text-sm font-semibold text-white">{group.title}</h2>
                <ul className="mt-4 space-y-3">
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        className="rounded-sm text-sm leading-6 text-[#8ccfff] transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                        href={link.href}
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-14 border-t border-white/12 pt-8">
          <div className="max-w-3xl [&_[data-registrar-disclosure]]:border-white/15 [&_[data-registrar-disclosure]]:bg-white/5 [&_[data-registrar-disclosure]]:text-white/70 [&_[data-registrar-disclosure]_h2]:text-white [&_[data-registrar-disclosure]_strong]:text-white">
            <RegistrarDisclosure compact registrarName={compliance.registrarName} />
          </div>

          <div className="mt-8 grid gap-3 text-xs leading-5 text-white/48 md:grid-cols-2">
            <div>
              <p>© 2026 Wanmi.net。公开查询结果以所标注的数据来源和时间为准。</p>
              {compliance.icpRegistrationNumber ? (
                <p>
                  <a
                    className="rounded-sm underline decoration-white/30 underline-offset-4 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                    href={ICP_REGISTRATION_URL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {compliance.icpRegistrationNumber}
                  </a>
                </p>
              ) : null}
              {compliance.publicSecurityRegistration ? (
                <p>
                  <a
                    className="rounded-sm underline decoration-white/30 underline-offset-4 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                    href={compliance.publicSecurityRegistration.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {compliance.publicSecurityRegistration.number}
                  </a>
                </p>
              ) : null}
            </div>
            {compliance.showPrelaunchNotice ? (
              <p className="md:text-right">
                生产服务上线前仍需完成资质、备案、合规复核及最终批准。
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </footer>
  )
}
