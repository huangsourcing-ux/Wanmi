import { ICP_REGISTRATION_URL, type PublicComplianceConfig } from '@/lib/public-compliance'

export function FooterRegistration({ compliance }: { compliance: PublicComplianceConfig }) {
  return (
    <div>
      <p>© 2026 Wanmi.net。公开查询结果以所标注的数据来源和时间为准。</p>
      {compliance.icpRegistrationNumber ? (
        <p>
          <a
            className="underline underline-offset-4 hover:text-dyna-navy"
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
            className="underline underline-offset-4 hover:text-dyna-navy"
            href={compliance.publicSecurityRegistration.url}
            rel="noreferrer"
            target="_blank"
          >
            {compliance.publicSecurityRegistration.number}
          </a>
        </p>
      ) : null}
    </div>
  )
}
