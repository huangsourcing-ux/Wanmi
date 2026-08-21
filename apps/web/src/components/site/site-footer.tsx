import { RegistrarDisclosure } from '@/components/compliance/registrar-disclosure'
import type { PublicComplianceConfig } from '@/lib/public-compliance'

import { DeferredHomeFooter } from './deferred-home-footer'
import { FooterLegalLinks } from './site-footer-legal'
import { FooterRegistration } from './site-footer-registration'

export function SiteFooter({ compliance }: { compliance: PublicComplianceConfig }) {
  return (
    <>
      <DeferredHomeFooter />
      <div
        className="border-t border-[#D4DCEC] bg-dyna-page text-dyna-navy/75"
        data-wanmi-compliance-footer
      >
        <div className="mx-auto grid max-w-1440 gap-5 px-7 py-6 text-[13px] leading-5 md:px-14 lg:grid-cols-3 2xl:px-[120px]">
          <FooterRegistration compliance={compliance} />
          <div>
            <RegistrarDisclosure compact registrarName={compliance.registrarName} />
            <FooterLegalLinks />
          </div>
          {compliance.showPrelaunchNotice ? (
            <p className="lg:text-right">生产服务上线前仍需完成资质、备案、合规复核及最终批准。</p>
          ) : null}
        </div>
      </div>
    </>
  )
}
