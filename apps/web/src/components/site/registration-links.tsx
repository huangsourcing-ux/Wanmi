import { ICP_REGISTRATION_URL, type PublicComplianceConfig } from '@/lib/public-compliance'

const linkClassName =
  'rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-ring'

/** Copyright line plus ICP / 公安 registration links (each only when configured). */
export function RegistrationLinks({ compliance }: { compliance: PublicComplianceConfig }) {
  const registrations = [
    { href: ICP_REGISTRATION_URL, label: compliance.icpRegistrationNumber },
    {
      href: compliance.publicSecurityRegistration?.url,
      label: compliance.publicSecurityRegistration?.number,
    },
  ]
  return (
    <>
      <p>© 2026 Wanmi.net。公开查询结果以所标注的数据来源和时间为准。</p>
      {registrations.map(({ href, label }) =>
        href && label ? (
          <p key={href}>
            <a className={linkClassName} href={href} rel="noreferrer" target="_blank">
              {label}
            </a>
          </p>
        ) : null,
      )}
    </>
  )
}
