import Link from 'next/link'

export function RegistrarDisclosure({
  compact = false,
  registrarName,
}: {
  compact?: boolean
  registrarName?: string
}) {
  if (!registrarName) return null

  return (
    <aside
      className={
        compact
          ? 'mt-5 rounded-lg border border-primary/20 bg-primary/5 p-4'
          : 'rounded-xl border border-primary/25 bg-primary/5 p-5 sm:p-6'
      }
      data-registrar-disclosure
    >
      <h2 className="text-sm font-semibold text-foreground">域名注册服务机构披露</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Wanmi 提供域名代理注册服务；实际域名注册服务机构为
        <strong className="font-semibold text-foreground">{registrarName}</strong>。Wanmi
        与注册服务机构的服务范围、履约及责任边界，请查阅
        <Link
          className="rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-ring"
          href="/legal/terms"
        >
          《使用条款》
        </Link>
        。
      </p>
    </aside>
  )
}
