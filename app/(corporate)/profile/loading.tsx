import { SkeletonHeader, SkeletonForm } from '@/app/components/Skeleton'

// The traveller profile: personal details, then travel documents.
export default function ProfileLoading() {
  return (
    <div className="page-frame narrow">
      <SkeletonHeader />
      <div className="flex flex-col gap-4">
        <SkeletonForm fields={4} columns={2} />
        <SkeletonForm fields={3} columns={2} />
      </div>
    </div>
  )
}
