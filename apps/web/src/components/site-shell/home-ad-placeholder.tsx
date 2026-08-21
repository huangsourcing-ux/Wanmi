export function HomeAdPlaceholder() {
  return (
    <aside
      aria-label="赞助信息"
      className="mx-auto my-8 min-h-28 max-w-[90rem] px-4 sm:px-6 lg:px-8"
    >
      <div className="relative flex min-h-28 w-full items-center justify-center overflow-hidden rounded-2xl border border-dashed border-[#8bb9ef]/45 bg-[linear-gradient(110deg,rgba(218,232,255,0.42),rgba(238,191,255,0.18),rgba(197,221,255,0.38))] px-6 text-center">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1.5 bg-[linear-gradient(180deg,#63c2ff,#f098ff,#fff75f)]"
        />
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-[#3255c3] uppercase">赞助位</p>
          <p className="mt-2 text-sm text-[#31446f]/70">当前无赞助内容，不影响主查询。</p>
        </div>
      </div>
    </aside>
  )
}
