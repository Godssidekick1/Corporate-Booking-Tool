import { SkeletonHeader, SkeletonTable } from '@/app/components/Skeleton'

export default function BookingsLoading() {
  return (
    <div className="px-8 py-7">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={6} />
    </div>
  )
}