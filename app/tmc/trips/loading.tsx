import { SkeletonHeader, SkeletonForm, SkeletonCards } from '@/app/components/Skeleton'

// One trip, opened by the travel desk: its details, then its flights.
export default function TmcTripLoading() {
  return (
    <div className="page-frame medium">
      <SkeletonHeader />
      <SkeletonForm fields={4} columns={2} />
      <div className="mt-4">
        <SkeletonCards count={2} />
      </div>
    </div>
  )
}
