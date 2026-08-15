import { Skeleton } from '@/components/ui/skeleton'

export function PageLoading() {
  return (
    <section
      aria-busy="true"
      aria-label="页面正在加载"
      className="mx-auto min-h-[calc(100svh-4rem)] w-full max-w-7xl space-y-8 px-4 py-12 sm:px-6 lg:px-8"
      role="status"
    >
      <span className="sr-only">页面正在加载，请稍候。</span>
      <div className="space-y-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-5 w-full max-w-2xl" />
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton className="h-52 w-full" key={index} />
        ))}
      </div>
    </section>
  )
}
