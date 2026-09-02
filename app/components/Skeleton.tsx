// ── Skeleton ─────────────────────────────────────────────────────────────────
// Content-shaped loading placeholders.
//
// A skeleton that mirrors the final layout reads as faster than a centred
// spinner at identical timings, because the page stops jumping when data
// arrives — the boxes are already the right size and in the right place. Used
// for first paint of a screen; the existing spinner stays for in-place actions
// like saving a row, where a skeleton would wrongly imply the whole view is
// reloading.
//
// The shimmer itself is `.skeleton` in globals.css, so it's one animation
// definition rather than one per component.
// ─────────────────────────────────────────────────────────────────────────────

export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />
}

// Four stat tiles, matching the dashboard's grid.
export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-[10px] border border-line bg-surface p-4">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="mt-3 h-7 w-16" />
          <Skeleton className="mt-3 h-2.5 w-24" />
        </div>
      ))}
    </div>
  )
}

// A table with a header row and n body rows. Widths vary per column so it reads
// as tabular data rather than a grey block.
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-surface">
      <div className="flex gap-4 border-b border-line bg-canvas px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-2.5" style={{ width: i === 0 ? '22%' : '12%' }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-line/60 px-4 py-3 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className="h-3"
              // Deterministic pseudo-random widths — a fixed width per column
              // looks like a loading bar, and Math.random() would differ between
              // server and client render and trip hydration.
              style={{ width: c === 0 ? `${18 + ((r * 7) % 10)}%` : `${8 + ((r + c) % 6)}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// Page title + subtitle, so the header doesn't pop in after the body.
export function SkeletonHeader() {
  return (
    <div className="mb-6">
      <Skeleton className="h-5 w-56" />
      <Skeleton className="mt-2.5 h-3 w-96 max-w-full" />
    </div>
  )
}
