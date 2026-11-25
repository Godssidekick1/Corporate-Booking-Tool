import { Skeleton, SkeletonHeader } from '@/app/components/Skeleton'

// The org chart: a chain above, the person in focus, their reports below.
export default function OrganizationLoading() {
  return (
    <div className="page-frame">
      <SkeletonHeader />
      <Skeleton className="mb-6 h-10 w-full max-w-md" style={{ borderRadius: 8 }} />
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3">
        <Skeleton className="h-12 w-64" style={{ borderRadius: 10 }} />
        <Skeleton className="h-28 w-full" style={{ borderRadius: 14 }} />
      </div>
      <div className="mt-6 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" style={{ borderRadius: 12 }} />)}
      </div>
    </div>
  )
}
