import { SkeletonHeader, SkeletonForm, SkeletonTable } from '@/app/components/Skeleton'

// Book travel: choose the client and traveller, then the desk's bookings.
export default function TmcBookLoading() {
  return (
    <div className="page-frame">
      <SkeletonHeader />
      <SkeletonForm fields={2} columns={2} />
      <div className="mt-5">
        <SkeletonTable rows={5} cols={5} />
      </div>
    </div>
  )
}
