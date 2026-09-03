import { SkeletonHeader, SkeletonTable } from '@/app/components/Skeleton'

export default function ApprovalsLoading() {
  return (
    <div className="px-8 py-7">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={5} />
    </div>
  )
}