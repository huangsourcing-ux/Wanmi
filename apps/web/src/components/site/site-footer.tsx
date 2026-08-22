import { RegistrarDisclosure } from '@/components/compliance/registrar-disclosure'
import { LegalLinks } from '@/components/site/legal-links'
import { RegistrationLinks } from '@/components/site/registration-links'
import { SiteFooter as SourceSiteFooter } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/SiteFooter'
import type { PublicComplianceConfig } from '@/lib/public-compliance'

/**
 * The vendored site footer, followed by the statutory compliance bar (ICP / 公安 registration,
 * pre-launch notice, legal documents and the registrar disclosure) carried over from the
 * previous shell. The bar is required by law, so it is not part of the design baseline.
 */
export function SiteFooter({ compliance }: { compliance: PublicComplianceConfig }) {
  return (
    <>
      <SourceSiteFooter />
      <div
        className="border-t bg-card text-xs leading-5 text-muted-foreground"
        data-wanmi-compliance-footer
      >
        <div className="mx-auto grid max-w-7xl gap-2 px-4 py-5 sm:px-6 md:grid-cols-2 lg:px-8">
          <div>
            <RegistrationLinks compliance={compliance} />
            <LegalLinks />
            <RegistrarDisclosure compact registrarName={compliance.registrarName} />
          </div>
          {compliance.showPrelaunchNotice ? (
            <p className="md:text-right">生产服务上线前仍需完成资质、备案、合规复核及最终批准。</p>
          ) : null}
        </div>
      </div>
    </>
  )
}
