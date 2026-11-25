import { SkeletonHeader, SkeletonForm, SkeletonCards } from '@/app/components/Skeleton'

// One trip: its details, then its flights.
export default function TripLoading() {
  return (
    <div className="page-frame narrow">
      <SkeletonHeader />
      <SkeletonForm fields={4} columns={2} />
      <div className="mt-4">
        <SkeletonCards count={2} />
      </div>
    </div>
  )
}
