import { SkeletonHeader, SkeletonTiles, SkeletonTable } from '@/app/components/Skeleton'

// The corporate dashboard is where a non-TMC sign-in lands, and it had no
// loading state at all — the whole gap between "credentials accepted" and
// "dashboard painted" was a blank screen. Next renders this during the route
// transition, before the page component mounts and starts fetching.
export default function DashboardLoading() {
  return (
    <div className="px-8 py-7">
      <SkeletonHeader />
      <SkeletonTiles count={3} />
      <div className="mt-4">
        <SkeletonTable rows={5} cols={5} />
      </div>
    </div>
  )
}
