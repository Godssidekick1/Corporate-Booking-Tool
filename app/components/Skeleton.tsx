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

// A row of tab pills, for pages that open on tabs (reports, trips).
export function SkeletonTabs({ count = 4 }: { count?: number }) {
  return (
    <div className="mb-5 flex gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-8 rounded-full" style={{ width: 84 + ((i * 23) % 40) }} />
      ))}
    </div>
  )
}

// A card of labelled fields: a form or a profile.
export function SkeletonForm({ fields = 4, columns = 1 }: { fields?: number; columns?: 1 | 2 }) {
  return (
    <div className="rounded-[12px] border border-line bg-surface p-5">
      <Skeleton className="h-3.5 w-40" />
      <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-2.5" style={{ width: 70 + ((i * 17) % 50) }} />
            <Skeleton className="mt-2 h-9 w-full" style={{ borderRadius: 8 }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// Stacked cards: trips, flights, people.
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-[12px] border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-3.5" style={{ width: `${34 + ((i * 11) % 18)}%` }} />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-2.5" style={{ width: `${52 + ((i * 7) % 20)}%` }} />
          <Skeleton className="mt-2 h-2.5 w-1/3" />
        </div>
      ))}
    </div>
  )
}

// One record: a main column of sections and a narrow side column.
export function SkeletonRecord() {
  return (
    // Side by side when there is room; stacked on a phone.
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex flex-col gap-4" style={{ flex: '2 1 480px', minWidth: 0 }}>
        <SkeletonForm fields={4} columns={2} />
        <SkeletonForm fields={2} />
      </div>
      <div className="rounded-[12px] border border-line bg-surface p-5" style={{ flex: '1 1 240px', minWidth: 0 }}>
        <Skeleton className="h-3.5 w-28" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mt-4 flex justify-between gap-4">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-2.5" style={{ width: 40 + ((i * 13) % 30) }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// A few short lines in place, for a small panel inside a page.
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2.5 py-1" aria-label="Loading" role="status">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${60 + ((i * 17) % 35)}%` }} />
      ))}
    </div>
  )
}
