import { SkeletonHeader, SkeletonTable } from '@/app/components/Skeleton'

// Covers every corporate settings section. The sidebar is painted by the layout
// above, so only the content column needs placeholders.
export default function SettingsLoading() {
  return (
    <div>
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={5} />
    </div>
  )
}
