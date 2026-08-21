export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="relative flex size-9 items-center justify-center overflow-hidden rounded-xl bg-[linear-gradient(135deg,#63c2ff_0%,#7868ff_48%,#f098ff_100%)] text-sm font-black text-white shadow-[0_8px_24px_-10px_rgba(99,194,255,0.95)]"
      >
        W
        <span className="absolute inset-x-1 bottom-1 h-px bg-white/50" />
      </span>
      <span className="font-heading text-xl font-semibold tracking-[-0.035em] text-current">
        WANMI
        {compact ? null : (
          <span className="ml-1 text-[0.55em] tracking-[0.08em] opacity-60">.NET</span>
        )}
      </span>
    </span>
  )
}
