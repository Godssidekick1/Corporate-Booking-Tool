import { SkeletonHeader, SkeletonTable } from '@/app/components/Skeleton'

// Nested inside /tmc/loading so the second column stays painted too — only the
// content pane swaps for a skeleton while a Configurations page loads.
export default function ConfigurationsLoading() {
  return (
    <div>
      <SkeletonHeader />
      <SkeletonTable rows={7} cols={4} />
    </div>
  )
}
