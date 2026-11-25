import { SkeletonHeader, SkeletonTabs, SkeletonTiles, SkeletonTable } from '@/app/components/Skeleton'

// Reports: a tab per report, its headline figures, then its table.
export default function ReportsLoading() {
  return (
    <div className="page-frame">
      <SkeletonHeader />
      <SkeletonTabs count={6} />
      <SkeletonTiles count={4} />
      <div className="mt-4">
        <SkeletonTable rows={6} cols={6} />
      </div>
    </div>
  )
}
