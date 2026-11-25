import { SkeletonHeader, SkeletonCards } from '@/app/components/Skeleton'

// My trips: a narrow column of trip cards, as the page is. The page shows the
// same cards while it learns who is signed in (./page.tsx), so the tabs, the
// buttons and the list arrive together.
export default function BookingsLoading() {
  return (
    <div className="page-frame narrow">
      <SkeletonHeader />
      <SkeletonCards count={4} />
    </div>
  )
}
