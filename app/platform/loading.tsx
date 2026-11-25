import { SkeletonHeader, SkeletonTable } from '@/app/components/Skeleton'

// The platform console: the list of travel management companies.
export default function PlatformLoading() {
  return (
    <div>
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={5} />
    </div>
  )
}
