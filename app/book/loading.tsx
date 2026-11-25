import { SkeletonHeader, SkeletonForm, SkeletonCards } from '@/app/components/Skeleton'

// Between steps of the booking flow (search, results, fare, passengers,
// confirm, ticket). The flow's chrome and stepper are already painted by
// app/book/layout.tsx; this fills the page with a search-and-list shape.
export default function BookingLoading() {
  return (
    <div className="page-frame">
      <SkeletonHeader />
      <SkeletonForm fields={4} columns={2} />
      <div className="mt-5">
        <SkeletonCards count={3} />
      </div>
    </div>
  )
}
