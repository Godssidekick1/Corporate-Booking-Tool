import { SkeletonHeader, SkeletonTable } from '@/app/components/Skeleton'

export default function ClientsLoading() {
  return (
    <div className="px-8 py-7">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={5} />
    </div>
  )
}