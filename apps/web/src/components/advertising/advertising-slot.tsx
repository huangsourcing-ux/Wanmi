import config from '@payload-config'
import { getPayload } from 'payload'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  readPublicAdvertisement,
  type PublicAdvertisement,
} from '@/services/advertising/read-public-ad'

const deviceClasses = {
  all: '',
  desktop: 'hidden md:block',
  mobile: 'md:hidden',
} as const

export async function AdvertisingSlot({
  className,
  pageType,
  placementCode,
}: {
  className?: string
  pageType: 'content' | 'home' | 'tld' | 'tool'
  placementCode: string
}) {
  const advertisement = await loadAdvertisement({ pageType, placementCode })
  if (!advertisement) return null

  return <AdvertisementCard advertisement={advertisement} className={className} />
}

async function loadAdvertisement({
  pageType,
  placementCode,
}: {
  pageType: 'content' | 'home' | 'tld' | 'tool'
  placementCode: string
}): Promise<PublicAdvertisement | null> {
  try {
    const payload = await getPayload({ config })
    return await readPublicAdvertisement(payload, { pageType, placementCode })
  } catch {
    return null
  }
}

export function AdvertisementCard({
  advertisement,
  className,
}: {
  advertisement: PublicAdvertisement
  className?: string
}) {
  return (
    <aside
      aria-label={`广告：${advertisement.headline}`}
      className={cn(
        'mx-auto my-8 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]',
        deviceClasses[advertisement.deviceScope],
        className,
      )}
      data-ad-placement={advertisement.placementCode}
      data-commercial-content="advertisement"
    >
      <div className="rounded-xl border-2 border-dashed border-primary/30 bg-card p-4 shadow-sm sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Badge className="uppercase tracking-[0.18em]" variant="outline">
            广告
          </Badge>
          <span className="text-xs text-muted-foreground">商业推广，不影响工具结果排序</span>
        </div>
        <a
          className="group grid items-center gap-4 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,220px)_1fr]"
          href={advertisement.clickHref}
          referrerPolicy="origin"
          rel="sponsored nofollow noopener"
          target={advertisement.external ? '_blank' : undefined}
        >
          {advertisement.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- Payload returns short-lived signed OSS URLs with dynamic hosts
            <img
              alt={advertisement.image.alt}
              className="h-auto max-h-36 w-full rounded-md border object-cover"
              decoding="async"
              height={advertisement.image.height}
              loading="lazy"
              src={advertisement.image.url}
              width={advertisement.image.width}
            />
          ) : null}
          <span className="min-w-0">
            <span className="block font-heading text-lg font-semibold group-hover:text-primary">
              {advertisement.headline}
            </span>
            {advertisement.body ? (
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                {advertisement.body}
              </span>
            ) : null}
            <span className="mt-3 block text-sm font-medium text-primary">查看广告内容 →</span>
          </span>
        </a>
      </div>
    </aside>
  )
}
